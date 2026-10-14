import type { ReactNode } from 'react'
import { Button } from './Button'
import { classNames } from './class-names'

export interface FilterBarProps {
	readonly children: ReactNode
	readonly onReset?: () => void
	readonly resetLabel?: string
	readonly label?: string
	readonly className?: string
}

export function FilterBar({ children, onReset, resetLabel = 'Reset filters', label = 'Filters', className }: FilterBarProps) {
	return (
		<div className={classNames('fui-filter-bar', className)} role="group" aria-label={label}>
			<div className="fui-filter-bar__filters">{children}</div>
			{onReset && (
				<Button variant="ghost" size="sm" onClick={onReset}>
					{resetLabel}
				</Button>
			)}
		</div>
	)
}
