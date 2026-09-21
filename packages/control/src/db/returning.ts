import type { SqlStatement } from '@fabrika/platform'

/**
 * Run a statement that always returns exactly one row (an `INSERT/UPDATE … RETURNING` we know
 * matched). `.first<T>()` is typed `T | null`; this narrows it to `T`, throwing if the row is
 * unexpectedly absent (a programming/DB error, not normal flow). Mirrors propustka's `firstRow`.
 */
export async function firstRow<T>(statement: SqlStatement): Promise<T> {
	const row = await statement.first<T>()
	if (row === null) {
		throw new Error('expected a row from a RETURNING statement, got none')
	}
	return row
}
