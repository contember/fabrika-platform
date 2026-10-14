import type { ReactNode } from 'react'
import { classNames } from './class-names'

export interface PageHeaderProps {
	readonly title: ReactNode
	readonly lead?: ReactNode
	readonly back?: { readonly href: string; readonly label: string }
	readonly actions?: ReactNode
	readonly meta?: ReactNode
	readonly className?: string
}

export function PageHeader({ title, lead, back, actions, meta, className }: PageHeaderProps) {
	return (
		<div className={classNames('fui-page-header', className)}>
			{back !== undefined && (
				<a className="fui-page-header__back" href={back.href}>
					<span aria-hidden="true">←</span>
					{back.label}
				</a>
			)}
			<div className="fui-page-header__row">
				<div className="fui-page-header__heading">
					{/* The router moves focus here after a navigation, so a screen reader announces the new page. */}
					<h1 className="fui-page-header__title" tabIndex={-1}>
						{title}
					</h1>
					{lead !== undefined && <p className="fui-page-header__lead">{lead}</p>}
				</div>
				{actions !== undefined && <div className="fui-page-header__actions">{actions}</div>}
			</div>
			{meta !== undefined && <div className="fui-page-header__meta">{meta}</div>}
		</div>
	)
}
