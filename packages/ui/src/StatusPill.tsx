import type { ReactNode } from 'react'
import { classNames } from './class-names'
import type { Tone } from './tone'

export interface StatusPillProps {
	readonly tone?: Tone
	/** The tone's dot before the text; `false` leaves it out. */
	readonly dot?: boolean
	readonly children: ReactNode
	readonly className?: string
}

export function StatusPill({ tone = 'neutral', dot = true, children, className }: StatusPillProps) {
	return (
		<span className={classNames('fui-pill', `fui-pill--${tone}`, className)}>
			{dot && <span className="fui-pill__dot" aria-hidden="true" />}
			{children}
		</span>
	)
}
