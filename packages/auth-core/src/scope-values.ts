// The values a dimension lists for the person who grants (ADR-0085): information for the console, never authorization.

import type { OutputShape, SchemaShape } from './contract'
import { MAX_MEMBERSHIP_SCOPE_PART_LENGTH } from './membership'

/** One value a dimension lists, with the text the console shows beside it. */
export interface DimensionValue {
	readonly value: string
	readonly label?: string
}

/** The most values a dimension lists. */
export const MAX_DIMENSION_VALUES = 500

/** The longest label of a listed value. */
export const MAX_DIMENSION_VALUE_LABEL_LENGTH = 120

/**
 * Why `values` is not a dimension's list, or `null`: at least one and at most `MAX_DIMENSION_VALUES` values, each a
 * non-empty value no longer than a scope value IAM takes, listed once, with a non-empty label when it has one.
 */
export function dimensionValuesProblem(values: readonly DimensionValue[]): string | null {
	if (values.length === 0) return 'lists no value (allowed: at least one, or no values field)'
	if (values.length > MAX_DIMENSION_VALUES) return `lists ${values.length} values (allowed: at most ${MAX_DIMENSION_VALUES})`
	const seen = new Set<string>()
	for (const { value, label } of values) {
		if (value === '' || value.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) {
			return `lists the value '${value}' (allowed: 1 to ${MAX_MEMBERSHIP_SCOPE_PART_LENGTH} characters)`
		}
		if (seen.has(value)) return `lists the value '${value}' twice`
		seen.add(value)
		if (label !== undefined && (label.trim() === '' || label.length > MAX_DIMENSION_VALUE_LABEL_LENGTH)) {
			return `labels the value '${value}' with '${label}' (allowed: 1 to ${MAX_DIMENSION_VALUE_LABEL_LENGTH} characters)`
		}
	}
	return null
}

/**
 * Where IAM asks the application for a dimension's values (ADR-0085 §4): the procedure's endpoint id, its path on the
 * application's origin and the action its requirement names. IAM calls it as the administrator, through the proxy.
 */
export interface DimensionValueSource {
	readonly endpoint: string
	readonly path: string
	readonly action: string
}

/** How long IAM waits for a value source's whole answer before the console falls back. */
export const SCOPE_VALUE_SOURCE_TIMEOUT_MS = 3000

/** The largest answer IAM reads from a value source. */
export const MAX_SCOPE_VALUE_SOURCE_BYTES = 256 * 1024

/** The row of a value-source procedure, as far as its rule reads it. */
interface ValueSourceRow {
	readonly id: string
	readonly kind: string
	readonly method: string
	readonly callers: readonly string[]
	readonly requirement:
		| { readonly kind: string; readonly action?: string; readonly access?: { readonly form: string; readonly dimension?: string } }
		| null
	readonly input: SchemaShape | null
	readonly output: OutputShape | null
}

/**
 * Why `row` cannot be `dimension`'s value source, or null: a person's `POST` query without input, requiring an action
 * `over` that dimension, whose output is `{ values: [{ value: string, label?: string }] }`. The proxy decides the call
 * from the row like any other; the requirement's action is what IAM's key for the call carries.
 */
export function valueSourceProblem(row: ValueSourceRow, dimension: string): string | null {
	if (row.kind !== 'query' || row.method !== 'POST') return `'${row.id}' is not a query procedure (allowed: r.query(…) of an rpc mount)`
	if (!row.callers.includes('human')) return `'${row.id}' admits no person (allowed: callers including 'human')`
	const requirement = row.requirement
	if (requirement?.kind !== 'action' || requirement.access?.form !== 'over' || requirement.access.dimension !== dimension) {
		return `'${row.id}' does not require an action over '${dimension}' (allowed: access: { action: '<action>', over: '${dimension}' })`
	}
	if (row.input !== null) return `'${row.id}' takes an input (allowed: no input)`
	if (row.output === null || !isDimensionValuesShape(row.output)) {
		return `'${row.id}' does not answer { values: [{ value: string, label?: string }] }`
	}
	return null
}

/** The output shape `{ values: [{ value: string, label?: string }] }`, strings with any checks. */
export function isDimensionValuesShape(shape: OutputShape): boolean {
	if (shape.type !== 'object' || Object.keys(shape.fields).length !== 1) return false
	const values = shape.fields['values']
	if (values?.type !== 'array') return false
	const item = values.items
	if (item.type !== 'object') return false
	const keys = Object.keys(item.fields)
	if (!keys.includes('value') || keys.some((key) => key !== 'value' && key !== 'label')) return false
	const label = item.fields['label']
	return item.fields['value']?.type === 'string' && (label === undefined || (label.type === 'optional' && label.inner.type === 'string'))
}

/**
 * The values a source answered, or null when the answer is not `{ values }` of at most `MAX_DIMENSION_VALUES` values
 * `dimensionValuesProblem` admits. An answer is the application's word: the console shows it, IAM decides nothing by it.
 */
export function parseDimensionValues(result: unknown): DimensionValue[] | null {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
	const list: unknown = Reflect.get(result, 'values')
	if (!Array.isArray(list)) return null
	const values: DimensionValue[] = []
	for (const entry of list) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
		const value: unknown = Reflect.get(entry, 'value')
		const label: unknown = Reflect.get(entry, 'label')
		if (typeof value !== 'string' || (label !== undefined && typeof label !== 'string')) return null
		values.push(label === undefined ? { value } : { value, label })
	}
	if (values.length === 0) return values
	return dimensionValuesProblem(values) === null ? values : null
}
