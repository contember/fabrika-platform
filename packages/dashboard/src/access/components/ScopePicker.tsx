import type { AppScopeDef, DimensionValue } from '@fabrika/iam-contract'
import { MAX_GRANT_SCOPE_VALUES } from '@fabrika/iam-contract'
import { useState } from 'react'
import { SearchField } from '../../components/SearchField'
import { type LiveScopeValues, unavailableReason, useLiveScopeValues } from '../lib/useLiveScopeValues'
import { Badge } from './Badge'

/**
 * The chosen scope for a grant (ADR-0085). Two explicit states:
 *  - `{ kind: 'global' }`: all scopes → stored `scope_type = scope_value = null`
 *  - `{ kind: 'scoped', type, values, text }`: one dimension and the values the grant holds. `values` is what is
 *    sent; `text` is the free-text box's own content, kept so typing a new line is not undone by parsing it.
 */
export type ScopeValue =
	| { kind: 'global' }
	| { kind: 'scoped'; type: string; values: readonly string[]; text: string }

/** A scoped value of `type` holding `values`, with the free-text box showing them one per line. */
export function scopedValue(type: string, values: readonly string[] = []): ScopeValue {
	return { kind: 'scoped', type, values, text: values.join('\n') }
}

/** The values typed into the free-text box: one per line, trimmed, blank lines and repeats dropped. */
export function valuesFromText(text: string): string[] {
	return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))]
}

/** Resolve a ScopeValue to the API `scopeType` / `scopeValues` pair (both null = global). */
export function resolveScope(value: ScopeValue): { scopeType: string | null; scopeValues: string[] | null } {
	if (value.kind === 'global') return { scopeType: null, scopeValues: null }
	const type = value.type.trim()
	const values = [...new Set(value.values.map((entry) => entry.trim()).filter((entry) => entry !== ''))]
	if (type === '' || values.length === 0) throw new Error('Pick a scope dimension and at least one value, or choose Global.')
	if (values.length > MAX_GRANT_SCOPE_VALUES) throw new Error(`A grant holds at most ${MAX_GRANT_SCOPE_VALUES} values. Split it into several grants.`)
	return { scopeType: type, scopeValues: values }
}

interface ScopePickerProps {
	/** The application the grant is at, whose values a dimension with a source lists; null or omitted for none. */
	app?: string | null
	/** Scope dimensions for the chosen app (from GET schema); empty when no app picked. */
	scopes: AppScopeDef[]
	value: ScopeValue
	onChange: (value: ScopeValue) => void
	idPrefix?: string
}

/**
 * Generic scope picker: Global, or one dimension (`type`, from the app's `app_scopes`) and the values the grant holds.
 * Defaults to Global.
 */
export function ScopePicker({ app, scopes, value, onChange, idPrefix = 'scope' }: ScopePickerProps) {
	const scopedId = `${idPrefix}-scoped`
	const firstType = scopes[0]?.type ?? ''
	if (scopes.length === 0) return null
	const dimension = value.kind === 'scoped' ? scopes.find((scope) => scope.type === value.type) : undefined

	return (
		<div className="grant-scope">
			<label htmlFor={scopedId} className="checkbox">
				<input
					id={scopedId}
					type="checkbox"
					checked={value.kind === 'scoped'}
					onChange={(event) => onChange(event.target.checked ? scopedValue(firstType) : { kind: 'global' })}
				/>
				Limit access to a specific scope
			</label>
			{value.kind === 'scoped' && (
				<>
					<label>
						Scope dimension
						<select value={value.type} onChange={(e) => onChange(scopedValue(e.target.value))}>
							{scopes.map((s) => <option key={s.type} value={s.type}>{s.label ? `${s.label} (${s.type})` : s.type}</option>)}
						</select>
					</label>
					<ScopeValuesField app={app} dimension={dimension ?? { type: value.type }} value={value} onChange={onChange} idPrefix={idPrefix} />
				</>
			)}
			{value.kind === 'global' && <p className="hint">Applies to all scopes within the selected application.</p>}
		</div>
	)
}

interface ScopeValuesFieldProps {
	/** The application the grant is at; a dimension with a source lists its values from it (ADR-0085 §4). */
	app?: string | null
	/** The dimension the values belong to; its `values` are what the application declares. */
	dimension: Pick<AppScopeDef, 'type' | 'label' | 'values' | 'valueSource'>
	value: Extract<ScopeValue, { kind: 'scoped' }>
	onChange: (value: ScopeValue) => void
	idPrefix?: string
}

/** The values of one dimension a grant holds, from the application itself when the dimension names a source. */
export function ScopeValuesField({ app, dimension, ...rest }: ScopeValuesFieldProps) {
	const live = useLiveScopeValues(app, dimension)
	return <ScopeValuesChoice dimension={dimension} live={live} {...rest} />
}

interface ScopeValuesChoiceProps extends Omit<ScopeValuesFieldProps, 'app'> {
	live: LiveScopeValues
}

/**
 * A dimension that lists its values offers one checkbox each, one per row: the application's answer when it gave one,
 * else the declared list. Past eight values a filter narrows the rows. A value the grant holds that the list does not
 * have stays checked and flagged until it is unchecked.
 * With no list at all it takes free text, one value per line, under a warning that nothing checks it. When the
 * application was asked and did not answer, a warning says why and what is shown instead.
 */
export function ScopeValuesChoice({ dimension, live, value, onChange, idPrefix = 'scope' }: ScopeValuesChoiceProps) {
	const [query, setQuery] = useState('')
	const name = dimension.label ?? dimension.type
	const listed = live.status === 'live' ? live.values : dimension.values ?? []
	const fallback = live.status === 'unavailable'
		? (
			<p className="warn-text" role="note">
				Could not load the values of {name} from the application: {unavailableReason(live.reason)}.{' '}
				{listed.length > 0 ? 'Showing the values the application declares instead.' : 'Enter the IDs by hand.'}
			</p>
		)
		: null
	if (live.status === 'loading') {
		return <p className="hint" role="status">Loading the values of {name} from the application…</p>
	}
	if (listed.length === 0) {
		const id = `${idPrefix}-values`
		return (
			<label htmlFor={id}>
				{name} values
				<textarea
					id={id}
					rows={Math.min(Math.max(value.values.length + 1, 3), 10)}
					value={value.text}
					onChange={(event) => onChange({ ...value, text: event.target.value, values: valuesFromText(event.target.value) })}
					placeholder={`One ${name} ID per line`}
				/>
				{fallback}
				<span className="warn-text" role="note">
					{live.status === 'live'
						? `The application lists no values of ${name} for you, so nothing checks these. Use the exact IDs from the application.`
						: `The application lists no values of ${name}, so nothing checks these. Use the exact IDs from the application.`}
				</span>
			</label>
		)
	}
	const chosen = new Set(value.values)
	const known = new Set(listed.map((entry) => entry.value))
	const unlisted = value.values.filter((entry) => !known.has(entry))
	const filtering = listed.length + unlisted.length > FILTER_FROM
	const shownListed = filtering ? listed.filter((entry) => valueMatches(entry, query)) : listed
	const shownUnlisted = filtering ? unlisted.filter((entry) => valueMatches({ value: entry }, query)) : unlisted
	function toggle(entry: string, on: boolean) {
		const next = on ? [...value.values, entry] : value.values.filter((held) => held !== entry)
		onChange({ ...value, values: next, text: next.join('\n') })
	}
	return (
		<fieldset className="scope-picker">
			<legend>{name} values</legend>
			{fallback}
			{filtering && (
				<div className="filters">
					<SearchField label={`Filter ${name} values`} value={query} onChange={setQuery} placeholder="Name or ID" />
				</div>
			)}
			<div className="scope-value-list">
				{shownListed.map((entry) => {
					const id = `${idPrefix}-value-${entry.value}`
					return (
						<label key={entry.value} htmlFor={id} className="checkbox" title={entry.label === undefined ? entry.value : `${entry.label} · ${entry.value}`}>
							<input
								id={id}
								type="checkbox"
								checked={chosen.has(entry.value)}
								onChange={(event) =>
									toggle(entry.value, event.target.checked)}
							/>
							{entry.label === undefined ? <code className="truncate">{entry.value}</code> : (
								<>
									<span className="truncate">{entry.label}</span>
									<span className="truncate muted small">{entry.value}</span>
								</>
							)}
						</label>
					)
				})}
				{shownUnlisted.map((entry) => {
					const id = `${idPrefix}-value-${entry}`
					return (
						<label key={entry} htmlFor={id} className="checkbox" title={entry}>
							<input id={id} type="checkbox" checked onChange={(event) => toggle(entry, event.target.checked)} />
							<code className="truncate">{entry}</code>
							<Badge tone="warn" title="The grant holds this value, but the application no longer lists it.">not listed</Badge>
						</label>
					)
				})}
				{shownListed.length + shownUnlisted.length === 0 && <p className="hint">No value matches “{query.trim()}”.</p>}
			</div>
			{unlisted.length > 0 && (
				<p className="warn-text" role="note">
					The grant holds {unlisted.length === 1 ? 'a value' : 'values'} the application no longer lists. Uncheck {unlisted.length === 1 ? 'it' : 'them'}
					{' '}
					to remove {unlisted.length === 1 ? 'it' : 'them'} from the grant.
				</p>
			)}
		</fieldset>
	)
}

/** Past this many values the list offers a filter; fewer fit the box without one. */
const FILTER_FROM = 8

/** Whether a value's label or ID contains the filter, ignoring case; an empty filter matches every value. */
export function valueMatches(entry: DimensionValue, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (needle === '') return true
	return entry.value.toLowerCase().includes(needle) || (entry.label?.toLowerCase().includes(needle) ?? false)
}
