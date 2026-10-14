import { type ReactNode, useId } from 'react'
import { classNames } from './class-names'

export interface CardProps {
	readonly title?: ReactNode
	readonly actions?: ReactNode
	readonly children: ReactNode
	readonly footer?: ReactNode
	readonly className?: string
}

export function Card({ title, actions, children, footer, className }: CardProps) {
	const titleId = useId()
	const hasHeader = title !== undefined || actions !== undefined
	return (
		<section className={classNames('fui-card', className)} aria-labelledby={title === undefined ? undefined : titleId}>
			{hasHeader && (
				<div className="fui-card__header">
					{title !== undefined && (
						<h2 className="fui-card__title" id={titleId}>
							{title}
						</h2>
					)}
					{actions !== undefined && <div className="fui-card__actions">{actions}</div>}
				</div>
			)}
			<div className="fui-card__body">{children}</div>
			{footer !== undefined && <div className="fui-card__footer">{footer}</div>}
		</section>
	)
}

export interface SectionProps {
	readonly title: ReactNode
	readonly description?: ReactNode
	readonly actions?: ReactNode
	readonly children: ReactNode
	readonly className?: string
}

export function Section({ title, description, actions, children, className }: SectionProps) {
	const titleId = useId()
	return (
		<section className={classNames('fui-section', className)} aria-labelledby={titleId}>
			<div className="fui-section__header">
				<div className="fui-section__heading">
					<h2 className="fui-section__title" id={titleId}>
						{title}
					</h2>
					{description !== undefined && <p className="fui-section__description">{description}</p>}
				</div>
				{actions !== undefined && <div className="fui-section__actions">{actions}</div>}
			</div>
			<div className="fui-section__body">{children}</div>
		</section>
	)
}
