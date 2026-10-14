import type { ReactNode } from 'react'
import { classNames } from './class-names'
import type { Tone } from './tone'

export interface StatusPillProps {
	readonly tone?: Tone
	readonly children: ReactNode
	readonly className?: string
}

export function StatusPill({ tone = 'neutral', children, className }: StatusPillProps) {
	return (
		<span className={classNames('fui-pill', `fui-pill--${tone}`, className)}>
			<span className="fui-pill__dot" aria-hidden="true" />
			{children}
		</span>
	)
}
