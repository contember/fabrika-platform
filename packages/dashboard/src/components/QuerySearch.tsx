import { type ReactNode, useEffect, useRef, useState } from 'react'
import { formatQuery, highlightQuery, parseQuery, type QueryFilters, type QueryLanguage } from '../lib/query-search'
import { SearchField } from './SearchField'

/**
 * A list's GitHub-style search field (`app:notes env:prod`, see `lib/query-search`). Enter applies it, or every
 * keystroke does where the list filters in the browser (`live`); the clear button applies the empty field, which clears
 * the filters. Deleting the text by hand applies nothing until Enter, since that is how a new query starts: a list that
 * loads from its service would otherwise fetch everything mid-edit. It shows what is
 * applied, so a filter set elsewhere (a click in the table, the page's address) appears in it. The typed text is
 * transparent over a layer that draws the same characters in colour: a qualifier it reads, the value, and in red a
 * word it cannot read. The qualifiers it knows are listed under it, each a button that starts one.
 */
export function QuerySearch<K extends string>(
	{ language, label, filters, text = '', onApply, placeholder, live = false, id, aside }: {
		language: QueryLanguage<K>
		label: string
		/** What is applied now. */
		filters: QueryFilters<K>
		text?: string
		onApply: (filters: QueryFilters<K>, text: string) => void
		placeholder: string
		live?: boolean
		/** Prefix for the ids that tie the field to its help line. */
		id: string
		/** Shown at the end of the help line: the list's count, say. */
		aside?: ReactNode
	},
) {
	const applied = formatQuery(language, filters, text)
	const [query, setQuery] = useState(applied)
	const [problems, setProblems] = useState<string[]>([])
	const field = useRef<HTMLInputElement>(null)
	const layer = useRef<HTMLDivElement>(null)

	useEffect(() => {
		// Typing that already says what is applied (a trailing space, a long spelling) stays as typed.
		setQuery((current) => {
			const typed = parseQuery(language, current)
			return formatQuery(language, typed.filters, typed.text) === applied ? current : applied
		})
		setProblems([])
	}, [applied, language])

	function apply(value: string) {
		const parsed = parseQuery(language, value)
		setProblems(parsed.problems)
		if (parsed.problems.length === 0) onApply(parsed.filters, parsed.text)
	}
	function change(value: string) {
		setQuery(value)
		if (!live) return
		// While typing, a half-written filter (`status:inv`) is not yet a mistake: the list follows every query that
		// reads, and the field names what it cannot read only when Enter is pressed.
		const parsed = parseQuery(language, value)
		setProblems([])
		if (parsed.problems.length === 0) onApply(parsed.filters, parsed.text)
	}
	function clear() {
		setQuery('')
		apply('')
		field.current?.focus()
	}
	function addQualifier(name: string) {
		setQuery(`${query.trimEnd()}${query.trim() === '' ? '' : ' '}${name}:`)
		field.current?.focus()
	}
	// The layer scrolls with the field's text, so the colours stay under the letters they colour.
	function followScroll() {
		if (layer.current !== null && field.current !== null) layer.current.scrollLeft = field.current.scrollLeft
	}

	return (
		<form
			className="filters query-search"
			onSubmit={(e) => {
				e.preventDefault()
				apply(query)
			}}
		>
			<SearchField label={label} value={query} onChange={clear}>
				<span className="query-field">
					<input
						ref={field}
						type="search"
						value={query}
						onChange={(e) => change(e.target.value)}
						onScroll={followScroll}
						onKeyUp={followScroll}
						onSelect={followScroll}
						placeholder={placeholder}
						spellCheck={false}
						autoComplete="off"
						aria-describedby={`${id}-help`}
						aria-invalid={problems.length > 0}
					/>
					<div ref={layer} className="query-layer" aria-hidden="true">
						{highlightQuery(language, query).map((part, index) => <span key={`${index}:${part.text}`} className={`query-${part.kind}`}>{part.text}</span>)}
					</div>
				</span>
			</SearchField>
			<div id={`${id}-help`} className="search-help">
				{problems.length > 0
					? <span className="error-text">{problems.join(' · ')}. Filter with:</span>
					: <span>{live ? 'Filter with:' : 'Press Enter to filter with:'}</span>}
				{language.qualifiers.map(({ name }) => (
					<button key={name} type="button" className="qualifier" onClick={() => addQualifier(name)}>
						{name}:
					</button>
				))}
				{aside !== undefined && <span className="search-aside">{aside}</span>}
			</div>
		</form>
	)
}
