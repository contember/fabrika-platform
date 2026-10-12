// A Postgres `date` is a calendar day, so the layer answers it as `YYYY-MM-DD` text. `Bun.SQL` decodes one to a `Date`
// at UTC midnight, whatever the process's time zone; the generated column list names the `date` columns
// (`TableColumns.dates`), and every read of a table's rows converts them here.

import { defineValue, inSet, type NameSet, ownDescriptor, ownKeys } from './builtins'
import { QueryRefusedError } from './errors'

/** The last year `Bun.SQL` decodes correctly; it misreads a later one and answers an invalid `Date` for BC and infinity. */
const LAST_YEAR = 9999

/** The day a decoded `date` value names, as `YYYY-MM-DD`. */
export function dayText(value: Date, where: string): string {
	const year = value.getUTCFullYear()
	if (Number.isNaN(value.getTime()) || year < 1 || year > LAST_YEAR) {
		throw new QueryRefusedError(`${where} holds a date outside 0001-01-01 to 9999-12-31, which the layer cannot read as YYYY-MM-DD`)
	}
	return value.toISOString().slice(0, 10)
}

/** Replaces each `Date` under a key of `days` in every row with its `YYYY-MM-DD` text, in place. */
export function answerDays<R>(table: string, days: NameSet, rows: R[]): R[] {
	if (ownKeys(days).length === 0) {
		return rows
	}
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]
		if (typeof row !== 'object' || row === null) {
			continue
		}
		const keys = ownKeys(row)
		for (let position = 0; position < keys.length; position++) {
			const key = keys[position] ?? ''
			const value: unknown = ownDescriptor(row, key)?.value
			if (inSet(days, key) && value instanceof Date) {
				defineValue(row, key, dayText(value, `${table}.${key}`))
			}
		}
	}
	return rows
}
