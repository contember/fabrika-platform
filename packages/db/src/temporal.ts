// Dates and timestamps at the layer's boundary. A Postgres `date` is a calendar day, so the layer answers it as
// `YYYY-MM-DD` text. A selected `date` column is read as
// the database's own text (`cast(<column> as text)`, `nodes.ts`), never through the `Date` `Bun.SQL` decodes: outside
// 0001–9999 that one drifts by the process's offset and can land on a neighbouring valid day. Only an aggregate's
// `min`/`max` and a store's joined child column still arrive as a `Date`. The generated column list names the `date`
// columns (`TableColumns.dates`); every read of a table's rows passes through `answerRows` (`answerDays` on Postgres). A write's text for a day or a
// timestamp is checked here before anything is sent: Postgres would also take `now`, `today` or `10/12/2026`, and read
// a timestamp without an offset in the session's time zone. On SQLite (ADR-0065) a timestamp is stored as UTC ISO text
// and a boolean as 0 or 1: `storedTimestamp` is what a write binds and `answerRows` turns both back into what Postgres's
// driver answers.

import { defineValue, inSet, type NameSet, ownDescriptor, ownKeys } from './builtins'
import type { SqlDialect } from './database'
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
const TIMESTAMP_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/

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

/** The instant of strict ISO 8601 text, in milliseconds since the epoch (digits past the millisecond dropped), or `undefined`. */
function instantOf(value: string): number | undefined {
	const match = TIMESTAMP_TEXT.exec(value)
	if (match === null) {
		return undefined
	}
	const [, year, month, day, hour, minute, second = '0', fraction = '', sign = '+', offsetHour = '0', offsetMinute = '0'] = match
	const valid = isCalendarDay(Number(year), Number(month), Number(day)) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
		&& Number(offsetHour) < 16 && Number(offsetMinute) < 60
	if (!valid) {
		return undefined
	}
	// setUTCFullYear, unlike Date.UTC, keeps the years 0001–0099.
	const date = new Date(0)
	date.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
	date.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3)))
	const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000
	return date.getTime() - (sign === '-' ? -offset : offset)
}

function timestampRefused(where: string): QueryRefusedError {
	return new QueryRefusedError('invalid_value', `${where} takes a Date or ISO 8601 text with Z or an offset, such as 2026-10-12T08:30:00.000Z`)
}

/** A timestamp a write binds as text: strict ISO 8601 with `Z` or an offset, every field in range. */
export function timestampInput(value: string, where: string): string {
	if (instantOf(value) === undefined) {
		throw timestampRefused(where)
	}
	return value
}

/** A timestamp as SQLite stores it: UTC `Date#toISOString()` text, whose text order is time order. */
const STORED_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/

/**
 * What a write or a comparison binds for a timestamp on SQLite: the instant of a `Date`, or of the text `timestampInput`
 * admits, as stored text. Digits past the millisecond are dropped; an instant outside the years 0000–9999 UTC is
 * refused, since its text would not sort.
 */
export function storedTimestamp(value: string | Date, where: string): string {
	const time = typeof value === 'string' ? instantOf(value) : value.getTime()
	if (time === undefined) {
		throw timestampRefused(where)
	}
	const text = Number.isNaN(time) ? '' : new Date(time).toISOString()
	if (!STORED_TIMESTAMP.test(text)) {
		throw new QueryRefusedError(
			'invalid_value',
			`${where} holds an instant outside the years 0000-9999 UTC, which SQLite cannot store as sortable text`,
		)
	}
	return text
}

/** The columns of a read's rows the layer answers in a form of its own, by the name each arrives under. */
export interface RowColumns {
	/** `date` columns: `YYYY-MM-DD` text. */
	readonly days: NameSet
	/** Timestamps: a `Date` (SQLite answers its stored text). */
	readonly timestamps: NameSet
	/** Booleans: `true` or `false` (SQLite answers 1 or 0). */
	readonly booleans: NameSet
}

function unexpected(where: string, expected: string): QueryRefusedError {
	return new QueryRefusedError('unexpected_row', `${where} came back as something other than ${expected}`)
}

/** One SQLite value of `key` as Postgres's driver answers it; a value the migrations' types never store is refused. */
function sqliteValue(columns: RowColumns, where: string, key: string, value: unknown): unknown {
	if (value === null) {
		return value
	}
	if (inSet(columns.timestamps, key)) {
		if (typeof value !== 'string' || !STORED_TIMESTAMP.test(value)) {
			throw unexpected(where, 'UTC ISO text (YYYY-MM-DDTHH:MM:SS.sssZ), the form a timestamp is stored in on SQLite')
		}
		return new Date(value)
	}
	if (inSet(columns.booleans, key)) {
		if (value !== 0 && value !== 1) {
			throw unexpected(where, '0 or 1, the form a boolean is stored in on SQLite')
		}
		return value === 1
	}
	return typeof value === 'string' && inSet(columns.days, key) ? dayText(value, where) : value
}

/**
 * Every row of a read as the layer answers it, in place: each day as `YYYY-MM-DD` text, and on SQLite each timestamp as
 * a `Date` and each boolean as `true` or `false`, so a handler reads the same values on both dialects.
 */
export function answerRows<R>(dialect: SqlDialect, table: string, columns: RowColumns, rows: R[]): R[] {
	if (dialect === 'postgres') {
		return answerDays(table, columns.days, rows)
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
			const answered = sqliteValue(columns, `${table}.${key}`, key, value)
			if (answered !== value) {
				defineValue(row, key, answered)
			}
		}
	}
	return rows
}
