import { useState, useSyncExternalStore } from 'react'
import { type CanvasThread, type CanvasThreads, useCanvasHost } from './hostContext'
import { MarkdownPreview } from './ResponsePreview'

const NO_THREADS: readonly CanvasThread[] = []
const noSubscription = () => () => {}
const noThreads = () => NO_THREADS

/** The host's threads, or none when it has no thread store. */
function useCanvasThreads(): readonly CanvasThread[] {
	const threads = useCanvasHost().threads
	return useSyncExternalStore(threads?.subscribe ?? noSubscription, threads?.current ?? noThreads)
}

const STATE_LABELS: Record<CanvasThread['state'], string> = {
	open: 'Answered',
	queued: 'Reply sent',
	working: 'Agent is on it',
	resolved: 'Resolved',
}

/** Threads the agent opened by answering annotations, in the host's order; resolved ones collapse. */
export function ThreadList() {
	const store = useCanvasHost().threads
	const threads = useCanvasThreads()
	if (store === null || threads.length === 0) return null
	const active = threads.filter((thread) => thread.state !== 'resolved')
	const resolved = threads.filter((thread) => thread.state === 'resolved')

	return (
		<section aria-label="Threads" className="px-3 pt-1 pb-3 border-b border-border-subtle">
			<div className="text-[10px] uppercase tracking-widest text-text-tertiary font-body px-1 mb-1">Threads</div>
			{active.map((thread) => <ThreadCard key={thread.id} thread={thread} store={store} />)}
			{resolved.length > 0 && (
				<details className="mt-1">
					<summary className="text-[11px] text-text-tertiary font-body px-1 cursor-pointer">Resolved ({resolved.length})</summary>
					{resolved.map((thread) => <ThreadCard key={thread.id} thread={thread} store={store} />)}
				</details>
			)}
		</section>
	)
}

function ThreadCard({ thread, store }: { thread: CanvasThread; store: CanvasThreads }) {
	const [draft, setDraft] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await action()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const send = () =>
		run(async () => {
			await store.reply(thread.id, draft.trim())
			setDraft('')
		})

	const where = thread.filePath ?? thread.canvasFile?.replace(/\.jsx$/, '')

	return (
		<article className="rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 mt-2" data-thread-id={thread.id}>
			<div className="flex items-center justify-between gap-2 text-[11px] text-text-tertiary font-body">
				<span className="truncate">{where ? `${where} · ` : ''}Round {thread.revision}</span>
				<span>{STATE_LABELS[thread.state]}</span>
			</div>
			{thread.snippet.trim() && (
				<blockquote className="mt-1 border-l-2 border-border-medium pl-2 text-[12px] text-text-secondary font-body line-clamp-3">
					{thread.snippet}
				</blockquote>
			)}
			<ol className="mt-2 space-y-2">
				{thread.comments.map((comment) => (
					<li key={comment.id} className="text-[13px] font-body">
						<div className="text-[10px] uppercase tracking-widest text-text-tertiary">{comment.author === 'agent' ? 'Agent' : 'You'}</div>
						{/* The agent's text has the same trust as the canvas it wrote; the user's own is shown as typed. */}
						{comment.author === 'agent' ? <MarkdownPreview text={comment.body} /> : <p className="whitespace-pre-wrap text-text-primary">{comment.body}</p>}
					</li>
				))}
			</ol>
			<label className="sr-only" htmlFor={`thread-reply-${thread.id}`}>Reply</label>
			<textarea
				id={`thread-reply-${thread.id}`}
				value={draft}
				onInput={(event) => setDraft(event.currentTarget.value)}
				placeholder="Reply to the agent"
				rows={2}
				className="mt-2 w-full rounded-md bg-bg-input px-2 py-1.5 text-[13px] font-body text-text-primary"
			/>
			{error && <p role="alert" className="text-[12px] text-accent-red font-body">{error}</p>}
			<div className="mt-1 flex justify-end gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => run(() => store.setResolved(thread.id, thread.state !== 'resolved'))}
					className="px-2.5 py-1 rounded text-[12px] font-body text-text-secondary hover:text-text-primary"
				>
					{thread.state === 'resolved' ? 'Reopen' : 'Resolve'}
				</button>
				<button
					type="button"
					disabled={busy || draft.trim() === ''}
					onClick={send}
					className="px-2.5 py-1 rounded text-[12px] font-body font-medium bg-btn-primary text-btn-primary-text disabled:opacity-50"
				>
					Send
				</button>
			</div>
		</article>
	)
}
