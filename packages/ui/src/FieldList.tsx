import type { ReactNode } from 'react'
import { classNames } from './class-names'

export interface FieldListItem {
	readonly label: ReactNode
	readonly value: ReactNode
}

export interface FieldListProps {
	readonly items: readonly FieldListItem[]
	readonly columns?: 1 | 2 | 3
	readonly className?: string
}

function isBlank(value: ReactNode): boolean {
	return value === null || value === undefined || value === ''
}

export function FieldList({ items, columns = 1, className }: FieldListProps) {
	return (
		<dl className={classNames('fui-field-list', `fui-field-list--cols-${columns}`, className)}>
			{items.map((item, index) => (
				<div key={index} className="fui-field-list__item">
					<dt className="fui-field-list__label">{item.label}</dt>
					<dd className="fui-field-list__value">{isBlank(item.value) ? <span className="fui-field-list__blank">—</span> : item.value}</dd>
				</div>
			))}
		</dl>
	)
}
