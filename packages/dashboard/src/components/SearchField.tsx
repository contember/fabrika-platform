import type { ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * A filter bar's search: the field that takes the row's slack, with a magnifier in it and, once something is typed,
 * a button that empties it. The browser's own clear button shows only under the pointer and not in every browser, so
 * this one replaces it. The button sits beside the label, not in it, so the field's accessible name stays `label`, and
 * its own name never repeats the label's words: a lookup by label (`getByLabel('Search')`) matches aria-labels by
 * substring and would find the button too.
 */
export function SearchField(
	{ label, value, onChange, placeholder, className, children }: {
		label: string
		value: string
		onChange: (value: string) => void
		placeholder?: string
		className?: string
		/** A field of its own in place of the plain input (the audit log's highlighted query); it must render the input. */
		children?: ReactNode
	},
) {
	return (
		<div className={className === undefined ? 'field-wide search-box' : `field-wide search-box ${className}`}>
			<label>
				{label}
				{children ?? <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
			</label>
			{value !== '' && (
				<button type="button" className="search-clear" aria-label="Clear the field" onClick={() => onChange('')}>
					<Icon name="close" size={12} />
				</button>
			)}
		</div>
	)
}
