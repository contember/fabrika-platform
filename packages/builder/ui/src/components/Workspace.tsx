import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { PHASE_COUNT, phaseById } from '../../../shared/phases'
import { daemon } from '../lib/daemonClient'
import { PlanRenderer } from '../lib/kernel'
import { statusOf } from '../lib/phases'
import type { BuildEvent, CanvasFileInfo, PhaseId, PhaseState, Skeleton } from '../lib/types'
import { MarkdownLite } from './MarkdownLite'

export interface FocusedCanvas {
	revision: number
	files: CanvasFileInfo[]
}

function PacketHeader({
	state,
	focused,
	isCurrentGate,
}: {
	state: PhaseState
	focused: PhaseId
	isCurrentGate: boolean
}): JSX.Element {
	const p = phaseById(focused)
	const status = statusOf(focused, state.completed, state.current)
	const isCurrent = status === 'current'
	const reads = isCurrent && state.reads.length ? state.reads.join(', ') : p.reads.join(', ')
	const produces = isCurrent && state.produces.length ? state.produces.join(', ') : p.produces.join(', ')

	return (
		<div className="border-b border-border-subtle px-6 py-4">
			<div className="flex items-center gap-3">
				<h1 className="font-heading text-section text-text-primary">
					Phase {p.number}/{PHASE_COUNT} — {p.label}
				</h1>
				<span
					className={[
						'rounded px-2 py-0.5 text-tiny uppercase tracking-wide',
						status === 'done'
							? 'bg-accent-green-muted text-accent-green'
							: status === 'current'
							? 'bg-accent-amber-muted text-accent-amber'
							: 'border border-border-medium text-text-tertiary',
					].join(' ')}
				>
					{status}
				</span>
			</div>
			<dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-body">
				<dt className="text-text-tertiary">Read</dt>
				<dd className="min-w-0 break-words font-mono text-code text-text-secondary">{reads}</dd>
				<dt className="text-text-tertiary">Goal</dt>
				<dd className="min-w-0 break-words text-text-secondary">{produces}</dd>
				<dt className="text-text-tertiary">Gate</dt>
				<dd className="min-w-0 break-words font-mono text-code text-text-secondary">
					{p.gate
						? <>fabrika builder gate open {focused} --view view.jsx &amp;&amp; fabrika builder gate wait</>
						: <span className="text-text-tertiary">— (ungated compile step)</span>}
				</dd>
			</dl>
			{isCurrentGate && (
				<div className="mt-3 flex items-start gap-2 rounded-md bg-accent-amber-muted/60 px-3 py-2 text-tiny text-accent-amber">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mt-px shrink-0">
						<path
							d="M12 9v4m0 4h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					<span>
						<strong className="font-semibold">Gate open.</strong> Review the canvas — select text or hover a block to annotate, answer the choices, then
						{' '}
						<strong className="font-semibold">Submit</strong> in the panel on the right. That feedback is what{' '}
						<span className="font-mono">fabrika builder gate wait</span> hands back to the active agent.
					</span>
				</div>
			)}
		</div>
	)
}

function SkeletonGrid({
	sessionId,
	live,
	upcoming,
}: {
	sessionId: string
	live: boolean
	upcoming: boolean
}): JSX.Element {
	const [skeletons, setSkeletons] = useState<Skeleton[] | null>(null)

	useEffect(() => {
		if (!live) return
		let cancelled = false
		daemon.skeletons(sessionId).then((s) => {
			if (!cancelled) setSkeletons(s)
		})
		return () => {
			cancelled = true
		}
	}, [sessionId, live])

	const list = skeletons ?? []

	return (
		<div className="p-6">
			{upcoming && (
				<p className="mb-4 text-body text-text-tertiary">
					Not reached yet — once the design gate is approved, this phase turns each user flow into an opice <span className="font-mono">*.test.ts</span>
					{' '}
					skeleton (the acceptance contract), reviewed here as a grid.
				</p>
			)}
			{live && list.length === 0 && (
				<p className="text-body text-text-tertiary">
					No skeletons in <span className="font-mono">tests/browser/</span> yet. Author them with the <span className="font-mono">opice-plan</span>{' '}
					skill, then <span className="font-mono">fabrika builder induce</span>.
				</p>
			)}
			<div className="grid grid-cols-2 gap-3">
				{list.map((s) => (
					<div
						key={s.file}
						className="rounded-md border border-border-subtle bg-bg-surface p-4 transition-colors hover:border-border-hover"
					>
						<div className="font-mono text-code text-text-primary">{s.file}</div>
						<div className="mt-1 truncate text-body text-text-secondary">{s.name}</div>
						<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-tiny text-text-tertiary">
							{s.url && <span className="font-mono">{s.url}</span>}
							<span>{s.steps} steps</span>
							<span>{s.invariants} invariants</span>
							{s.pending > 0 ? <span className="text-accent-amber">{s.pending} pending</span> : <span className="text-accent-green">authored</span>}
						</div>
						{(s.seeds.length > 0 || s.roles.length > 0) && (
							<div className="mt-2 flex flex-wrap gap-1">
								{s.seeds.map((sd) => (
									<span key={sd} className="rounded bg-bg-elevated px-1.5 py-0.5 text-tiny text-text-secondary">
										seed:{sd}
									</span>
								))}
								{s.roles.map((r) => (
									<span key={r} className="rounded bg-bg-elevated px-1.5 py-0.5 text-tiny text-text-secondary">
										role:{r}
									</span>
								))}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	)
}

function BuildLog({ live }: { live: boolean }): JSX.Element {
	const [events, setEvents] = useState<BuildEvent[]>([])

	useEffect(() => {
		if (!live) return
		const es = daemon.buildStream((ev) => setEvents((prev) => [...prev.slice(-200), ev]))
		return () => es?.close()
	}, [live])

	const dot: Record<BuildEvent['status'], string> = {
		queued: 'bg-text-tertiary',
		running: 'bg-accent-blue',
		passed: 'bg-accent-green',
		failed: 'bg-accent-red',
		blocked: 'bg-accent-amber',
		info: 'bg-text-tertiary',
	}

	return (
		<div className="p-6">
			<h2 className="mb-3 font-heading text-section text-text-primary">Build</h2>
			{events.length === 0
				? (
					<p className="text-body text-text-tertiary">
						Waiting for build events. Run <span className="font-mono">fabrika builder build</span> to drive the per-issue pipeline; each{' '}
						<span className="font-mono">build done/block</span> posts here.
					</p>
				)
				: (
					<ul className="space-y-1.5 font-mono text-code">
						{events.map((ev, i) => (
							<li key={i} className="flex items-center gap-2">
								<span className={`inline-flex h-2 w-2 shrink-0 rounded-full ${dot[ev.status]}`} />
								{ev.issue && <span className="text-text-secondary">{ev.issue}</span>}
								<span className="text-text-tertiary">{ev.status}</span>
								{ev.message && <span className="truncate text-text-secondary">— {ev.message}</span>}
							</li>
						))}
					</ul>
				)}
		</div>
	)
}

function GateCanvas({ canvas }: { canvas: FocusedCanvas }): JSX.Element {
	return (
		<>
			{canvas.files.map((cf) => (
				<div key={cf.filename} className="mb-8">
					{canvas.files.length > 1 && (
						<div className="mb-2 text-tiny uppercase tracking-wide text-text-tertiary">
							{cf.label ?? cf.filename}
						</div>
					)}
					<PlanRenderer revision={canvas.revision} filename={cf.filename} />
				</div>
			))}
		</>
	)
}

export function Workspace({
	state,
	focused,
	canvas,
	artifact,
	isCurrentGate,
	sessionId,
	live,
}: {
	state: PhaseState
	focused: PhaseId
	canvas: FocusedCanvas | null
	artifact: string
	isCurrentGate: boolean
	sessionId: string
	live: boolean
}): JSX.Element {
	const status = statusOf(focused, state.completed, state.current)
	const upcoming = status === 'upcoming'

	return (
		<section className="flex h-full min-w-0 flex-col bg-bg-base">
			<PacketHeader state={state} focused={focused} isCurrentGate={isCurrentGate} />
			{}
			<div id="plan-scroll-container" className="flex-1 overflow-y-auto">
				{canvas
					? (
						<div className="mx-auto max-w-3xl px-6 py-5">
							<GateCanvas canvas={canvas} />
						</div>
					)
					: focused === 'skeletons'
					? <SkeletonGrid sessionId={sessionId} live={live} upcoming={upcoming} />
					: focused === 'build'
					? <BuildLog live={live} />
					: (
						<div className="mx-auto max-w-3xl px-6 py-5">
							{upcoming && (
								<p className="mb-4 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-tiny text-text-tertiary">
									This phase hasn't started yet — it unlocks once the earlier gates are approved. Here's what it will produce:
								</p>
							)}
							<MarkdownLite source={artifact} />
						</div>
					)}
			</div>
		</section>
	)
}
