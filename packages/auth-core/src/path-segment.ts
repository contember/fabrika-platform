const PARAMETER_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * The name of a `:name` path segment, or null for any other segment. Every endpoint table, an application's and an
 * installation service's, reads a parameter by this rule: it matches exactly one non-empty segment.
 */
export function parameterName(segment: string): string | null {
	return PARAMETER_SEGMENT.exec(segment)?.[1] ?? null
}
