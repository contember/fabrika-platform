import type { JSX } from 'react'
import { useState } from 'react'
import { AnnotationSidebar } from '../lib/kernel'

export function AnnotationPanel({
	gateName,
	hasGate,
	isCurrentGate,
	onSubmit,
}: {
	gateName: string | null
	hasGate: boolean
	isCurrentGate: boolean
	onSubmit: (feedback: string) => void
}): JSX.Element {
	const [open, setOpen] = useState(true)

	if (!open) {
		return (
			<button
				onClick={() => setOpen(true)}
				className="flex w-9 flex-col items-center gap-2 border-l border-border-subtle bg-bg-surface py-3 text-text-tertiary hover:text-text-secondary"
				title="Open review panel"
			>
				<span className="[writing-mode:vertical-rl] text-tiny uppercase tracking-wide">review</span>
			</button>
		)
	}

	const collapseButton = (
		<button
			onClick={() => setOpen(false)}
			className="text-text-tertiary hover:text-text-secondary"
			title="Collapse"
		>
			<svg width="14" height="14" viewBox="0 0 12 12" fill="none">
				<path
					d="M4.5 3L7.5 6L4.5 9"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</button>
	)

	return (
		<aside className="flex h-full w-72 flex-col border-l border-border-subtle bg-bg-surface">
			{hasGate
				? <AnnotationSidebar onSubmit={onSubmit} collapseButton={collapseButton} />
				: (
					<>
						<div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
							<div className="text-tiny uppercase tracking-wide text-text-tertiary">
								review &amp; annotate
							</div>
							{collapseButton}
						</div>
						<div className="flex-1 px-4 py-6 text-center text-tiny text-text-tertiary">
							{isCurrentGate && gateName
								? (
									<>
										gate <span className="font-mono">{gateName}</span> open — connect to a live daemon to review the pushed canvas.
									</>
								)
								: gateName
								? (
									<>
										this phase's <span className="font-mono">{gateName}</span> gate opens once the earlier phases are approved.
									</>
								)
								: (
									'no gate on this phase — nothing to review here.'
								)}
						</div>
					</>
				)}
		</aside>
	)
}
