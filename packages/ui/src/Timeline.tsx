import type { ReactNode } from 'react'
import { classNames } from './class-names'
import type { Tone } from './tone'

export interface TimelineItem {
	readonly id: string
	readonly at: ReactNode
	readonly title: ReactNode
	readonly body?: ReactNode
	readonly tone?: Tone
}

export interface TimelineProps {
	readonly items: readonly TimelineItem[]
	readonly empty?: ReactNode
	readonly className?: string
}

export function Timeline({ items, empty = 'Nothing here yet', className }: TimelineProps) {
	if (items.length === 0) return <p className={classNames('fui-timeline-empty', className)}>{empty}</p>
	return (
		<ol className={classNames('fui-timeline', className)}>
			{items.map((item) => (
				<li key={item.id} className={classNames('fui-timeline__item', `fui-timeline__item--${item.tone ?? 'neutral'}`)}>
					<span className="fui-timeline__marker" aria-hidden="true" />
					<div className="fui-timeline__content">
						<div className="fui-timeline__head">
							<span className="fui-timeline__title">{item.title}</span>
							<span className="fui-timeline__at">{item.at}</span>
						</div>
						{item.body !== undefined && <div className="fui-timeline__body">{item.body}</div>}
					</div>
				</li>
			))}
		</ol>
	)
}
