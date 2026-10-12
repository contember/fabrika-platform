// Dates and timestamps at the layer's boundary. A Postgres `date` is a calendar day, so the layer answers it as
// `YYYY-MM-DD` text. A selected `date` column is read as
// the database's own text (`cast(<column> as text)`, `nodes.ts`), never through the `Date` `Bun.SQL` decodes: outside
// 0001–9999 that one drifts by the process's offset and can land on a neighbouring valid day. Only an aggregate's
// `min`/`max` and a store's joined child column still arrive as a `Date`. The generated column list names the `date`
// columns (`TableColumns.dates`); every read of a table's rows passes through `answerDays`. A write's text for a day or a
// timestamp is checked here before anything is sent: Postgres would also take `now`, `today` or `10/12/2026`, and read
// a timestamp without an offset in the session's time zone.

import { defineValue, inSet, type NameSet, ownDescriptor, ownKeys } from './builtins'
import { QueryRefusedError } from './errors'

/** The text Postgres prints for a day in 0001–9999 under its default `DateStyle` (ISO). */
const DAY_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

const MS_PER_DAY = 86_400_000

function refused(where: string): QueryRefusedError {
	return new QueryRefusedError('invalid_value', `${where} holds a date outside 0001-01-01 to 9999-12-31, which the layer cannot read as YYYY-MM-DD`)
}

/**
 * A day as the layer answers it: the database's `YYYY-MM-DD` text, or a decoded `Date` that is exactly a UTC midnight
 * in 0001–9999 — the only `Date` `Bun.SQL` decodes correctly from a `date`, whatever the process's time zone.
 */
export function dayText(value: string | Date, where: string): string {
	if (typeof value === 'string') {
		if (!DAY_TEXT.test(value)) {
			throw refused(where)
		}
		return value
	}
	const time = value.getTime()
	const year = value.getUTCFullYear()
	if (Number.isNaN(time) || time % MS_PER_DAY !== 0 || year < 1 || year > 9999) {
		throw refused(where)
	}
	return value.toISOString().slice(0, 10)
}

/** Replaces each value under a key of `days` in every row with its `YYYY-MM-DD` text, in place. */
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
			if (inSet(days, key) && (typeof value === 'string' || value instanceof Date)) {
				defineValue(row, key, dayText(value, `${table}.${key}`))
			}
		}
	}
	return rows
}

/** An instant in strict ISO 8601: a day, `T`, the time to the minute or finer, and `Z` or an offset. */
const TIMESTAMP_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,6})?)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$/

/** Whether `year-month-day` is a day of the calendar: no 30 February, no month 13. */
function isCalendarDay(year: number, month: number, day: number): boolean {
	const date = new Date(Date.UTC(year, month - 1, day))
	return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** A day a write binds: `YYYY-MM-DD` text of a real day, as the layer answers one. */
export function dayInput(value: string, where: string): string {
	const [year, month, day] = value.split('-').map(Number)
	if (!DAY_TEXT.test(value) || year === undefined || month === undefined || day === undefined || !isCalendarDay(year, month, day)) {
		throw new QueryRefusedError('invalid_value', `${where} takes a day as YYYY-MM-DD text, such as 2026-10-12`)
	}
	return value
}

/** A timestamp a write binds as text: strict ISO 8601 with `Z` or an offset, every field in range. */
export function timestampInput(value: string, where: string): string {
	const match = TIMESTAMP_TEXT.exec(value)
	const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = match ?? []
	const valid = match !== null && isCalendarDay(Number(year), Number(month), Number(day)) && Number(hour) < 24 && Number(minute) < 60
		&& Number(second) < 60 && Number(offsetHour) < 16 && Number(offsetMinute) < 60
	if (!valid) {
		throw new QueryRefusedError('invalid_value', `${where} takes a Date or ISO 8601 text with Z or an offset, such as 2026-10-12T08:30:00.000Z`)
	}
	return value
}
