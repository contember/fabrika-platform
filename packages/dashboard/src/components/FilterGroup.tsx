import type { ReactNode } from 'react'

interface FilterGroupProps<T extends string> {
	label: string
	options: readonly { value: T; label: ReactNode; count?: number }[]
	value: T
	onChange: (value: T) => void
	className?: string
}

export function FilterGroup<T extends string>({ label, options, value, onChange, className = '' }: FilterGroupProps<T>) {
	return (
		<div className={`filter-group ${className}`} role="group" aria-label={label}>
			{options.map((option) => (
				<button
					type="button"
					key={option.value}
					className="filter-option"
					aria-pressed={value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
					{option.count !== undefined && <span className="filter-option-count">{option.count}</span>}
				</button>
			))}
		</div>
	)
}
