// A procedure's admission buckets, its accepted challenge tokens and its byte budget on SQLite (a bun:sqlite stand-in
// for a Durable Object's storage): each take, record and reservation prunes what has expired and writes in one
// transaction, so concurrent calls never admit past a limit or accept a token twice.

import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf } from '../framework'
import { FORM_ADMISSIONS_TABLE, FORM_BYTES_TABLE, FORM_CHALLENGES_TABLE } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { type SqliteFramework, sqliteFramework } from './fixtures/sqlite-framework'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

let db: SqliteFramework
let admissions: ReturnType<typeof frameworkTablesOf>['admissions']

// A test may first wait out the end of a minute (up to six seconds).
setDefaultTimeout(20_000)

const MINUTE = `strftime('%Y-%m-%dT%H:%M:00.000Z', 'now')`
const HOUR = `strftime('%Y-%m-%dT%H:00:00.000Z', 'now')`

function rows(table: string, where = 'true'): number {
	const [row] = db.exec(`select count(*) as n from ${table} where ${where}`)
	return Number(row?.['n'])
}

beforeEach(async () => {
	db = await sqliteFramework()
	admissions = frameworkTablesOf(connected(tables, { database: db.database, capabilities: new TestAuthority('user:alice') }).database).admissions
	// Every take of one test must land in one minute.
	const second = new Date().getUTCSeconds()
	if (second > 55) {
		await Bun.sleep((61 - second) * 1000)
	}
}, 20_000)

describe('an admission bucket on SQLite', () => {
	test('fifty concurrent takes of a bucket of ten admit exactly ten', async () => {
		const taken = await Promise.all(Array.from({ length: 50 }, () => admissions.take('contact.send', 'accepted', 10)))
		expect(taken.filter(Boolean)).toHaveLength(10)
		const [row] = db.exec(`select count, window_start from ${FORM_ADMISSIONS_TABLE} where bucket = 'accepted'`)
		expect(row?.['count']).toBe(10)
		expect(String(row?.['window_start'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
	})

	test('buckets of one endpoint and of two endpoints are apart', async () => {
		expect([await admissions.take('contact.send', 'client:a', 1), await admissions.take('contact.send', 'client:a', 1)]).toEqual([true, false])
		expect(await admissions.take('contact.send', 'client:b', 1)).toBe(true)
		expect(await admissions.take('feedback.send', 'client:a', 1)).toBe(true)
	})

	test('a take prunes the rows of past minutes, a bounded batch at a time, and keeps the current one', async () => {
		db.exec(
			`with recursive n(i) as (select 1 union all select i + 1 from n where i < 40)
			insert into ${FORM_ADMISSIONS_TABLE} (form, bucket, window_start, count)
			select 'contact.send', 'client:' || i, strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '-2 minutes'), 3 from n`,
		)
		await admissions.take('contact.send', 'client:now', 5)
		expect(rows(FORM_ADMISSIONS_TABLE, `window_start < ${MINUTE}`)).toBe(8)
		await admissions.take('contact.send', 'client:now', 5)
		expect(rows(FORM_ADMISSIONS_TABLE, `window_start < ${MINUTE}`)).toBe(0)
		expect(rows(FORM_ADMISSIONS_TABLE)).toBe(1)
	})

	test('a past minute does not count against the current one', async () => {
		db.exec(
			`insert into ${FORM_ADMISSIONS_TABLE} (form, bucket, window_start, count)
			values ('contact.send', 'client:a', strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '-1 minutes'), 1)`,
		)
		expect(await admissions.take('contact.send', 'client:a', 1)).toBe(true)
	})

	test('refuses a limit that is no positive whole number', async () => {
		await expect(admissions.take('contact.send', 'client:a', 0)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(admissions.take('contact.send', 'client:a', 1.5)).rejects.toBeInstanceOf(QueryRefusedError)
	})
})

describe('an accepted challenge token on SQLite', () => {
	test('of ten concurrent records of one token, exactly one wins; a replay is refused until it expires', async () => {
		const recorded = await Promise.all(Array.from({ length: 10 }, () => admissions.recordChallenge('apply', 'digest-1', 60_000)))
		expect(recorded.filter(Boolean)).toHaveLength(1)
		expect(await admissions.recordChallenge('apply', 'digest-1', 60_000)).toBe(false)
		expect(await admissions.recordChallenge('feedback.send', 'digest-1', 60_000)).toBe(true)
		const [row] = db.exec(`select expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+59 seconds') as later from ${FORM_CHALLENGES_TABLE}`)
		expect(row?.['later']).toBe(1)
	})

	test('an expired record is replaced, and a record prunes the expired ones', async () => {
		db.exec(
			`with recursive n(i) as (select 1 union all select i + 1 from n where i < 10)
			insert into ${FORM_CHALLENGES_TABLE} (form, token_digest, expires_at)
			select 'apply', 'old-' || i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 seconds') from n`,
		)
		expect(await admissions.recordChallenge('apply', 'old-1', 60_000)).toBe(true)
		expect(rows(FORM_CHALLENGES_TABLE, `expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)).toBe(0)
		expect(rows(FORM_CHALLENGES_TABLE)).toBe(1)
	})
})

describe('a byte budget on SQLite', () => {
	test('of concurrent reservations, only those that fit are taken, and a release gives bytes back', async () => {
		const reserved = await Promise.all(Array.from({ length: 10 }, () => admissions.reserveBytes('apply', 300, 1000)))
		expect(reserved.filter(Boolean)).toHaveLength(3)
		expect(await admissions.reserveBytes('apply', 200, 1000)).toBe(false)
		await admissions.releaseBytes('apply', 200)
		expect(await admissions.reserveBytes('apply', 200, 1000)).toBe(true)
		expect(await admissions.reserveBytes('feedback.send', 1000, 1000)).toBe(true)
	})

	test('a release never goes below zero, and a reservation larger than the budget is refused', async () => {
		expect(await admissions.reserveBytes('apply', 1001, 1000)).toBe(false)
		expect(await admissions.reserveBytes('apply', 100, 1000)).toBe(true)
		await admissions.releaseBytes('apply', 500)
		expect(await admissions.reserveBytes('apply', 1000, 1000)).toBe(true)
		expect(await admissions.reserveBytes('apply', 1, 1000)).toBe(false)
	})

	test('a reservation prunes the rows of past hours, and a past hour does not count against the current one', async () => {
		db.exec(
			`with recursive n(i) as (select 1 union all select i + 1 from n where i < 40)
			insert into ${FORM_BYTES_TABLE} (form, window_start, bytes)
			select 'form-' || i, strftime('%Y-%m-%dT%H:00:00.000Z', 'now', '-2 hours'), 1000 from n`,
		)
		db.exec(
			`insert into ${FORM_BYTES_TABLE} (form, window_start, bytes) values ('apply', strftime('%Y-%m-%dT%H:00:00.000Z', 'now', '-1 hours'), 1000)`,
		)
		expect(await admissions.reserveBytes('apply', 1000, 1000)).toBe(true)
		expect(rows(FORM_BYTES_TABLE, `window_start < ${HOUR}`)).toBe(9)
		await admissions.reserveBytes('apply', 1, 1000)
		expect(rows(FORM_BYTES_TABLE, `window_start < ${HOUR}`)).toBe(0)
	})

	test('refuses a reservation or a budget that is no positive whole number', async () => {
		await expect(admissions.reserveBytes('apply', 0, 1000)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(admissions.reserveBytes('apply', 10, 1.5)).rejects.toBeInstanceOf(QueryRefusedError)
	})
})
