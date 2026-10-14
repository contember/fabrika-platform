import { type ReactNode, useId } from 'react'
import { classNames } from './class-names'

export interface ColumnsProps {
	readonly children: ReactNode
	readonly className?: string
}

/** A main column that grows and a `SidePanel` beside it; they stack on narrow screens. */
export function Columns({ children, className }: ColumnsProps) {
	return <div className={classNames('fui-columns', className)}>{children}</div>
}

export interface SidePanelProps {
	readonly title?: ReactNode
	readonly children: ReactNode
	readonly className?: string
}

export function SidePanel({ title, children, className }: SidePanelProps) {
	const titleId = useId()
	return (
		<aside className={classNames('fui-side-panel', className)} aria-labelledby={title === undefined ? undefined : titleId}>
			{title !== undefined && (
				<h2 className="fui-side-panel__title" id={titleId}>
					{title}
				</h2>
			)}
			{children}
		</aside>
	)
}
