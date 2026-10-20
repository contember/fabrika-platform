import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * The state the screen reports, in the console's lamp colours: `neutral` for a wall or a missing page, which nothing
 * fixes by waiting, `run` for an outage that a retry may get past, `stop` for a failure.
 */
export type GateTone = 'neutral' | 'run' | 'stop'

interface GateScreenProps {
	/** The state's glyph, drawn large on the grid where the pages outside the console draw the mark. */
	icon: IconName
	tone?: GateTone
	title: string
	/** Which part of the console answers, at the left under the panel: an outage reads as bounded to its plane. */
	context?: string
	/** The status for whoever reports it, at the right under the panel. */
	status?: string
	/** The sentence and the one way on. */
	children: ReactNode
}

/**
 * Why a page is not shown: a route error, a permission wall, a missing page, a plane that does not answer. It is the
 * frame of the pages fabrika serves outside the console (`@fabrika/proxy-core/page-style`) set in the workspace: the
 * words at the left, the state's glyph on the welcome's blueprint grid at the right, the context and the status in a
 * line under it. The rail beside it carries the brand, so the glyph stands where those pages draw the mark, and takes
 * the colour of the state as a lamp does.
 */
export function GateScreen({ icon, tone = 'neutral', title, context, status, children }: GateScreenProps) {
	return (
		<div className="gate">
			<section className="gate-screen" data-tone={tone}>
				<div className="gate-copy">
					<h1>{title}</h1>
					{children}
				</div>
				<div className="gate-art" aria-hidden="true">
					<Icon name={icon} size={88} />
				</div>
			</section>
			{(context !== undefined || status !== undefined) && (
				<p className="gate-foot">
					{context !== undefined && <span>{context}</span>}
					{status !== undefined && <span className="gate-status">{status}</span>}
				</p>
			)}
		</div>
	)
}
