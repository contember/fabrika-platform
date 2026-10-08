const PARAMETER_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * The name of a `:name` path segment, or null for any other segment. Gates and endpoint tables share this rule, so a
 * parameter matches exactly one non-empty segment in both.
 */
export function parameterName(segment: string): string | null {
	return PARAMETER_SEGMENT.exec(segment)?.[1] ?? null
}
