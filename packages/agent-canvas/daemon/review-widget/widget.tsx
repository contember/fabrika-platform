import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { isUnsentNote, type ReviewAnchor, type ReviewSource, type ReviewThread, type ReviewThreadState } from '../src/review/model'
import { describe, find } from './anchor'
import type { ReviewClient } from './client'
import { captureElement } from './screenshot'
import { bundleFrames, resolveSources } from './source'

/** A type alias, not an interface, so it passes as an inline style. */
type Box = {
	top: number
	left: number
	width: number
	height: number
}

interface Draft {
	anchor: ReviewAnchor
	box: Box
	element: Element
	/** Resolved while the reviewer writes: source maps can take a moment to load. */
	sources: Promise<ReviewSource[]>
}

const STATE_LABELS: Record<ReviewThreadState, string> = {
	open: 'Note',
	queued: 'Sent to Claude',
	working: 'Claude is on it',
	resolved: 'Resolved',
}

const INTERACTIVE =
	'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable]'
const CURSOR_CLASS = 'agent-canvas-review-picking'

const PENDING_REVEAL_KEY = 'agent-canvas-review:reveal'

/** A hash route changes without a reload; any other URL reloads the page, so the thread to reveal survives in the session. */
function navigate(href: string, threadId: string): void {
	const target = new URL(href)
	if (target.origin === location.origin && target.pathname === location.pathname && target.search === location.search) {
		location.hash = target.hash
		return
	}
	try {
		sessionStorage.setItem(PENDING_REVEAL_KEY, threadId)
	} catch {}
	location.href = href
}

function takePendingReveal(): string | null {
	try {
		const threadId = sessionStorage.getItem(PENDING_REVEAL_KEY)
		sessionStorage.removeItem(PENDING_REVEAL_KEY)
		return threadId
	} catch {
		return null
	}
}

function boxOf(element: Element): Box {
	const rect = element.getBoundingClientRect()
	return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/** Two URLs show the same page when they differ at most in a hash route's query, which apps use for transient state. */
function pageKey(href: string): string {
	const url = new URL(href)
	return `${url.origin}${url.pathname}${url.search}${url.hash.split('?')[0] ?? ''}`
}

export function anchorLabel(anchor: ReviewAnchor): string {
	if (anchor.quote !== undefined) return `“${anchor.quote.exact}”`
	if (anchor.role !== undefined && anchor.name !== undefined) return `${anchor.role} “${anchor.name}”`
	if (anchor.text !== undefined) return anchor.text
	return anchor.selector
}

/** Re-renders on scroll, resize and once a second, so pins follow elements the application moves. */
function useLayoutTick(): number {
	const [tick, setTick] = useState(0)
	useEffect(() => {
		let frame = 0
		const schedule = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => setTick((value) => value + 1))
		}
		window.addEventListener('scroll', schedule, true)
		window.addEventListener('resize', schedule)
		const interval = setInterval(schedule, 1000)
		return () => {
			cancelAnimationFrame(frame)
			window.removeEventListener('scroll', schedule, true)
			window.removeEventListener('resize', schedule)
			clearInterval(interval)
		}
	}, [])
	return tick
}

function useHref(): string {
	const [href, setHref] = useState(location.href)
	useEffect(() => {
		const check = () => setHref(location.href)
		window.addEventListener('hashchange', check)
		window.addEventListener('popstate', check)
		const interval = setInterval(check, 400)
		return () => {
			window.removeEventListener('hashchange', check)
			window.removeEventListener('popstate', check)
			clearInterval(interval)
		}
	}, [])
	return href
}

/** While picking, the page's own handlers must not see the click that chooses an element. */
function usePicker(
	host: HTMLElement,
	active: boolean,
	onHover: (element: Element | null) => void,
	onPick: (element: Element, range?: Range) => void,
	onCancel: () => void,
) {
	useEffect(() => {
		if (!active) return
		document.documentElement.classList.add(CURSOR_CLASS)
		const isOwn = (event: Event) => event.composedPath().includes(host)
		// A click on a link's or a button's inner span means the link or the button.
		const targetOf = (event: Event) => (event.target instanceof Element ? (event.target.closest(INTERACTIVE) ?? event.target) : null)
		const onMove = (event: MouseEvent) => {
			if (!isOwn(event)) onHover(targetOf(event))
		}
		const onDown = (event: MouseEvent) => {
			if (isOwn(event)) return
			if (targetOf(event)?.closest(INTERACTIVE)) {
				event.preventDefault()
				event.stopPropagation()
			}
		}
		const onClick = (event: MouseEvent) => {
			if (isOwn(event)) return
			event.preventDefault()
			event.stopPropagation()
			const selection = window.getSelection()
			const range = selection !== null && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : undefined
			if (range !== undefined) {
				const container = range.commonAncestorContainer
				const element = container instanceof Element ? container : container.parentElement
				if (element !== null) return onPick(element, range)
			}
			const target = targetOf(event)
			if (target !== null) onPick(target)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onCancel()
		}
		document.addEventListener('mousemove', onMove, true)
		document.addEventListener('pointerdown', onDown, true)
		document.addEventListener('mousedown', onDown, true)
		document.addEventListener('click', onClick, true)
		document.addEventListener('keydown', onKey, true)
		return () => {
			document.documentElement.classList.remove(CURSOR_CLASS)
			document.removeEventListener('mousemove', onMove, true)
			document.removeEventListener('pointerdown', onDown, true)
			document.removeEventListener('mousedown', onDown, true)
			document.removeEventListener('click', onClick, true)
			document.removeEventListener('keydown', onKey, true)
		}
	}, [host, active, onHover, onPick, onCancel])
}

function popoverPosition(box: Box): { top: number; left: number } {
	const width = 320
	const height = 190
	const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8)
	const below = box.top + box.height + 8
	const top = below + height < window.innerHeight ? below : Math.max(8, box.top - height - 8)
	return { top, left }
}

function Composer(props: { draft: Draft; onSubmit: (body: string, send: boolean, screenshot: boolean) => Promise<void>; onCancel: () => void }) {
	const [body, setBody] = useState('')
	const [screenshot, setScreenshot] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const textarea = useRef<HTMLTextAreaElement>(null)
	useEffect(() => textarea.current?.focus(), [])

	const submit = async (send: boolean) => {
		if (body.trim() === '') return
		setBusy(true)
		setError(null)
		try {
			await props.onSubmit(body, send, screenshot)
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure))
			setBusy(false)
		}
	}

	return (
		<div class="popover" style={popoverPosition(props.draft.box)}>
			<div class="target" title={props.draft.anchor.selector}>{anchorLabel(props.draft.anchor)}</div>
			{props.draft.anchor.components !== undefined && <div class="target">{props.draft.anchor.components.slice(-3).join(' › ')}</div>}
			<textarea
				ref={textarea}
				value={body}
				placeholder="What should change here?"
				onInput={(event) => setBody(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') props.onCancel()
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(true)
				}}
			/>
			<label class="option">
				<input type="checkbox" checked={screenshot} onChange={(event) => setScreenshot(event.currentTarget.checked)} />
				Attach a screenshot
			</label>
			{error !== null && <div class="error">{error}</div>}
			<div class="actions">
				<button type="button" class="ghost" onClick={props.onCancel}>Cancel</button>
				<button type="button" disabled={busy || body.trim() === ''} onClick={() => void submit(false)}>Save note</button>
				<button type="button" class="primary" disabled={busy || body.trim() === ''} onClick={() => void submit(true)}>Send to Claude</button>
			</div>
			<div class="hint">Ctrl+Enter sends to Claude · Esc cancels</div>
		</div>
	)
}

function ThreadCard(props: { thread: ReviewThread; number: number | null; client: ReviewClient; onReveal: () => void }) {
	const { thread, client } = props
	const [reply, setReply] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const run = (action: () => Promise<unknown>) => {
		setError(null)
		action().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
	}
	const sendReply = (send: boolean) => {
		if (reply === null || reply.trim() === '') return
		run(() => client.comment(thread.id, reply, send).then(() => setReply(null)))
	}

	return (
		<div class={`thread${props.number === null ? '' : ' current'}${thread.state === 'resolved' ? ' resolved' : ''}`}>
			<div class="thread-head">
				<button type="button" class="ghost" title="Show in page" aria-label="Show in page" onClick={props.onReveal}>
					{props.number === null ? '↗' : `#${props.number}`}
				</button>
				<span class="target" title={thread.anchor.url}>{anchorLabel(thread.anchor)}</span>
				<span class={`badge ${thread.state}`}>{STATE_LABELS[thread.state]}</span>
			</div>
			{thread.comments.map((comment) => (
				<div key={comment.id} class={`comment ${comment.author}`}>
					<span class="author">{comment.author === 'user' ? 'You' : 'Claude'}</span>
					<span class="body">{comment.body}</span>
				</div>
			))}
			{reply !== null && (
				<textarea
					value={reply}
					placeholder="Reply…"
					onInput={(event) => setReply(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendReply(true)
					}}
				/>
			)}
			{error !== null && <div class="error">{error}</div>}
			<div class="actions">
				{reply === null
					? (
						<>
							<button type="button" class="ghost" onClick={() => run(() => client.delete(thread.id))}>Delete</button>
							{thread.state === 'resolved'
								? <button type="button" onClick={() => run(() => client.setResolved(thread.id, false))}>Reopen</button>
								: <button type="button" onClick={() => run(() => client.setResolved(thread.id, true))}>Resolve</button>}
							<button type="button" onClick={() => setReply('')}>Reply</button>
							{thread.state === 'open' && <button type="button" class="primary" onClick={() => run(() => client.send(thread.id))}>Send to Claude</button>}
						</>
					)
					: (
						<>
							<button type="button" class="ghost" onClick={() => setReply(null)}>Cancel</button>
							<button type="button" disabled={reply.trim() === ''} onClick={() => sendReply(false)}>Reply</button>
							<button type="button" class="primary" disabled={reply.trim() === ''} onClick={() => sendReply(true)}>Reply & send</button>
						</>
					)}
			</div>
		</div>
	)
}

export function ReviewWidget(props: { client: ReviewClient; host: HTMLElement }) {
	const { client, host } = props
	const [threads, setThreads] = useState<readonly ReviewThread[]>([])
	const [watching, setWatching] = useState(false)
	const [connected, setConnected] = useState(false)
	const [picking, setPicking] = useState(false)
	const [hovered, setHovered] = useState<Element | null>(null)
	const [draft, setDraft] = useState<Draft | null>(null)
	const [panelOpen, setPanelOpen] = useState(false)
	const [showAll, setShowAll] = useState(false)
	const [hideResolved, setHideResolved] = useState(false)
	const [panelError, setPanelError] = useState<string | null>(null)
	const [revealId, setRevealId] = useState<string | null>(takePendingReveal)
	const [flash, setFlash] = useState<Box | null>(null)
	const href = useHref()
	useLayoutTick()

	useEffect(() => {
		client.connect({ threads: setThreads, agentWatching: setWatching, connected: setConnected })
		return () => client.close()
	}, [client])

	const cancelPicking = useCallback(() => {
		setPicking(false)
		setHovered(null)
	}, [])
	const pick = useCallback((element: Element, range?: Range) => {
		setPicking(false)
		setHovered(null)
		window.getSelection()?.removeAllRanges()
		setDraft({ anchor: describe(element, location.href, range), box: boxOf(element), element, sources: resolveSources(bundleFrames(element)) })
	}, [])
	usePicker(host, picking, setHovered, pick, cancelPicking)
	// The panel covers the right edge of the page, which the reviewer may want to pick from.
	const startPicking = () => {
		setPanelOpen(false)
		setDraft(null)
		setPicking(true)
	}

	const page = pageKey(href)
	const onPage = useMemo(
		() => threads.filter((thread) => pageKey(thread.anchor.url) === page && (!hideResolved || thread.state !== 'resolved')),
		[threads, page, hideResolved],
	)
	const listed = showAll ? threads.filter((thread) => !hideResolved || thread.state !== 'resolved') : onPage
	const numbers = new Map(onPage.map((thread, index) => [thread.id, index + 1]))
	const pending = threads.filter((thread) => thread.state !== 'resolved').length
	const notes = threads.filter(isUnsentNote).length
	const sendNotes = () => {
		setPanelError(null)
		client.sendNotes().catch((failure: unknown) => setPanelError(failure instanceof Error ? failure.message : String(failure)))
	}

	useEffect(() => {
		if (revealId === null) return
		const thread = threads.find((candidate) => candidate.id === revealId)
		if (thread === undefined || pageKey(thread.anchor.url) !== page) return
		const element = find(document, thread.anchor)
		if (element === null) return
		element.scrollIntoView({ block: 'center', behavior: 'smooth' })
		setRevealId(null)
		setTimeout(() => setFlash(boxOf(element)), 350)
		setTimeout(() => setFlash(null), 1600)
	}, [revealId, threads, page])

	const reveal = (thread: ReviewThread) => {
		setRevealId(thread.id)
		if (pageKey(thread.anchor.url) !== page) navigate(thread.anchor.url, thread.id)
	}

	const presence = !connected ? 'Daemon offline' : watching ? 'Claude is listening' : 'Claude is not listening'
	const hoveredBox = hovered === null ? null : boxOf(hovered)

	return (
		<>
			{hoveredBox !== null && <div class="highlight" style={hoveredBox} />}
			{flash !== null && <div class="highlight flash" style={flash} />}
			{onPage.map((thread) => {
				const element = find(document, thread.anchor)
				if (element === null) return null
				const box = boxOf(element)
				if (box.width === 0 && box.height === 0) return null
				return (
					<button
						key={thread.id}
						type="button"
						class={`pin ${thread.state}`}
						style={{ top: Math.max(0, box.top - 11), left: Math.max(0, box.left + box.width - 11) }}
						title={thread.comments[0]?.body}
						onClick={() => setPanelOpen(true)}
					>
						{numbers.get(thread.id)}
					</button>
				)
			})}
			{draft !== null && (
				<Composer
					draft={draft}
					onCancel={() => setDraft(null)}
					onSubmit={async (body, send, screenshot) => {
						// The capture asks for the tab, which the browser allows only while the click still counts as a gesture.
						const image = screenshot ? await captureElement(draft.element, host) : undefined
						const sources = await draft.sources
						await client.createThread(sources.length === 0 ? draft.anchor : { ...draft.anchor, sources }, body, send, image)
						setDraft(null)
					}}
				/>
			)}
			{panelOpen && (
				<aside class="panel">
					<header>
						<h2>Review</h2>
						<button type="button" class="ghost" onClick={() => setPanelOpen(false)}>Close</button>
					</header>
					<div class="tabs">
						<button type="button" class={showAll ? '' : 'active'} onClick={() => setShowAll(false)}>This page</button>
						<button type="button" class={showAll ? 'active' : ''} onClick={() => setShowAll(true)}>All pages</button>
						<button type="button" class={hideResolved ? 'active' : ''} onClick={() => setHideResolved(!hideResolved)}>Hide resolved</button>
					</div>
					{notes > 0 && (
						<div class="send-notes">
							<button type="button" class="primary" onClick={sendNotes}>
								Send {notes === 1 ? '1 note' : `${notes} notes`} to Claude
							</button>
						</div>
					)}
					{panelError !== null && <div class="error">{panelError}</div>}
					<div class="threads">
						{listed.length === 0 && <div class="empty">No comments yet. Click “Comment”, then an element or a text selection.</div>}
						{listed.map((thread) => (
							<ThreadCard
								key={thread.id}
								thread={thread}
								number={numbers.get(thread.id) ?? null}
								client={client}
								onReveal={() => reveal(thread)}
							/>
						))}
					</div>
				</aside>
			)}
			<div class={`toolbar${panelOpen ? ' beside-panel' : ''}`}>
				<span class="presence" title={presence}>
					<span class={`dot ${!connected ? 'off-line' : watching ? 'on' : ''}`} />
					{presence}
				</span>
				<button type="button" class={picking ? 'active' : ''} onClick={() => (picking ? cancelPicking() : startPicking())}>
					{picking ? 'Pick an element…' : 'Comment'}
				</button>
				<button type="button" class={panelOpen ? 'active' : ''} onClick={() => setPanelOpen(!panelOpen)}>
					Threads{pending > 0 ? ` (${pending})` : ''}
				</button>
			</div>
		</>
	)
}
