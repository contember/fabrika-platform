// The values a dimension lists for the person who grants (ADR-0085): information for the console, never authorization.

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
