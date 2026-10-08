import type { JSX } from 'react'
import { PHASE_COUNT, PHASES } from '../../../shared/phases'
import { statusOf } from '../lib/phases'
import type { PhaseId, PhaseState } from '../lib/types'

function Marker({ status }: { status: 'done' | 'current' | 'upcoming' }): JSX.Element {
	if (status === 'done') {
		return (
			<span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-green-muted text-accent-green">
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
					<path
						d="M2.5 6.2L4.8 8.5L9.5 3.5"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</span>
		)
	}
	if (status === 'current') {
		return (
			<span className="relative flex h-5 w-5 items-center justify-center">
				<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-amber opacity-40" />
				<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-amber" />
			</span>
		)
	}
	return <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border-medium" />
}

export function PhaseRail({
	state,
	focused,
	onFocus,
}: {
	state: PhaseState
	focused: PhaseId
	onFocus: (id: PhaseId) => void
}): JSX.Element {
	return (
		<nav className="flex h-full flex-col border-r border-border-subtle bg-bg-surface">
			<div className="border-b border-border-subtle px-4 py-3">
				<div className="font-heading text-xl text-text-primary">fabrika</div>
				<div className="text-tiny uppercase tracking-wide text-text-tertiary">guided app build</div>
				<p className="mt-2 text-tiny leading-snug text-text-tertiary">
					8 phases from brief to build. Each ends in a review gate — click a phase to see its canvas.
				</p>
			</div>
			<ol className="flex-1 overflow-y-auto py-2">
				{PHASES.map((p) => {
					const status = statusOf(p.id, state.completed, state.current)
					const isFocused = focused === p.id
					const clickable = status !== 'upcoming'
					return (
						<li key={p.id}>
							<button
								disabled={!clickable}
								onClick={() => clickable && onFocus(p.id)}
								className={[
									'group flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors',
									isFocused ? 'bg-bg-elevated' : 'hover:bg-bg-elevated-half',
									clickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
								].join(' ')}
							>
								<div className="mt-0.5 shrink-0">
									<Marker status={status} />
								</div>
								<div className="min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="text-tiny tabular-nums text-text-tertiary">
											{p.number}/{PHASE_COUNT}
										</span>
										{p.gate && (
											<span
												title="canvas gate"
												className="rounded bg-badge-bg px-1 text-[10px] uppercase tracking-wide text-accent-amber"
											>
												gate
											</span>
										)}
									</div>
									<div
										className={[
											'truncate text-task-label',
											status === 'current'
												? 'font-semibold text-text-primary'
												: status === 'done'
												? 'text-text-secondary'
												: 'text-text-tertiary',
										].join(' ')}
									>
										{p.label}
									</div>
								</div>
							</button>
						</li>
					)
				})}
			</ol>
			<div className="border-t border-border-subtle px-4 py-2 text-tiny text-text-tertiary">
				phase derived from <span className="font-mono">GET /api/phase</span>
			</div>
		</nav>
	)
}
