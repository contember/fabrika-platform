import { type SqlStatement } from '@fabrika/platform'

/**
 * Run a statement that always returns exactly one row (an `INSERT/UPDATE … RETURNING`
 * we know matched). `.first<T>()` is typed `T | null`; this narrows it to `T`,
 * throwing if the row is unexpectedly absent (a programming/DB error, not normal flow).
 */
export async function firstRow<T>(statement: SqlStatement): Promise<T> {
	const row = await statement.first<T>()
	if (row === null) {
		throw new Error('expected a row from a RETURNING statement, got none')
	}
	return row
}

/**
 * The current time in unix seconds — the unit every `*_at` column stores. Timestamps are
 * generated HERE, never in SQL: `unixepoch()` is SQLite-only, so a statement carrying it
 * cannot run on Postgres (see @fabrika/platform's `sql.ts`).
 */
export function unixNow(): number {
	return Math.floor(Date.now() / 1000)
}
