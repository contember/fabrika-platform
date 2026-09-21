/** Group rows by a key, preserving order — how a single page-wide query becomes per-row lists. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>()
	for (const row of rows) {
		const bucket = out.get(key(row))
		if (bucket === undefined) {
			out.set(key(row), [row])
		} else {
			bucket.push(row)
		}
	}
	return out
}

/** The `before` value for the next page, or null when this page is the last one. */
export function cursorOf<T>(items: readonly T[], limit: number, id: (item: T) => string): string | null {
	const last = items.at(-1)
	return items.length === limit && last !== undefined ? id(last) : null
}

const DEFAULT_LIMIT = 50

const MAX_LIMIT = 200

export function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
	return Math.min(Math.floor(limit), MAX_LIMIT)
}
