// A form's admission counters and its accepted challenge tokens against a REAL Postgres: each take and each record is
// one statement, so concurrent instances never admit past a limit or accept a token twice, and each prunes what has
// expired. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf } from '../framework'
import { FORM_ADMISSIONS_TABLE, FORM_CHALLENGES_TABLE, FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`form-admissions.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `fa_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let database: Database
let forms: ReturnType<typeof frameworkTablesOf>['forms']

// A test may first wait out the end of a database minute (up to six seconds).
setDefaultTimeout(20_000)

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function rows(table: string, where = 'true'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.${table} where ${where}`))
	return Number(row?.n)
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration}`)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 8 })
	forms = frameworkTablesOf(connected(tables, { database, capabilities: new TestAuthority('user:alice') }).database).forms
})

beforeEach(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) => sql.unsafe(`delete from ${schema}.${FORM_ADMISSIONS_TABLE}; delete from ${schema}.${FORM_CHALLENGES_TABLE}`))
	// Every take of one test must land in one database minute.
	const [row] = await admin((sql) => sql.unsafe('select extract(second from now())::float8 as second'))
	if (Number(row?.second) > 55) {
		await Bun.sleep((61 - Number(row?.second)) * 1000)
	}
}, 20_000)

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('a form admission bucket', () => {
	test('fifty concurrent takes of a bucket of ten admit exactly ten', async () => {
		const taken = await Promise.all(Array.from({ length: 50 }, () => forms.take('contact', 'accepted', 10)))
		expect(taken.filter(Boolean)).toHaveLength(10)
		const [row] = await admin((sql) => sql.unsafe(`select count from ${schema}.${FORM_ADMISSIONS_TABLE} where bucket = 'accepted'`))
		expect(row?.count).toBe(10)
	})

	test('buckets of one form and of two forms are apart', async () => {
		expect([await forms.take('contact', 'client:a', 1), await forms.take('contact', 'client:a', 1)]).toEqual([true, false])
		expect(await forms.take('contact', 'client:b', 1)).toBe(true)
		expect(await forms.take('feedback', 'client:a', 1)).toBe(true)
	})

	test('a take prunes the rows of past minutes, a bounded batch at a time, and keeps the current one', async () => {
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.${FORM_ADMISSIONS_TABLE} (form, bucket, window_start, count)
				select 'contact', 'client:' || n, date_trunc('minute', now()) - interval '2 minutes', 3 from generate_series(1, 40) n`,
			)
		)
		await forms.take('contact', 'client:now', 5)
		expect(await rows(FORM_ADMISSIONS_TABLE, `window_start < date_trunc('minute', now())`)).toBe(8)
		await forms.take('contact', 'client:now', 5)
		expect(await rows(FORM_ADMISSIONS_TABLE, `window_start < date_trunc('minute', now())`)).toBe(0)
		expect(await rows(FORM_ADMISSIONS_TABLE)).toBe(1)
	})

	test('a past minute does not count against the current one', async () => {
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.${FORM_ADMISSIONS_TABLE} (form, bucket, window_start, count) values ('contact', 'client:a', date_trunc('minute', now()) - interval '1 minute', 1)`,
			)
		)
		expect(await forms.take('contact', 'client:a', 1)).toBe(true)
	})

	test('refuses a limit that is no positive whole number', async () => {
		await expect(forms.take('contact', 'client:a', 0)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(forms.take('contact', 'client:a', 1.5)).rejects.toBeInstanceOf(QueryRefusedError)
	})
})

describe.skipIf(!hasPostgres)('an accepted challenge token', () => {
	test('of ten concurrent records of one token, exactly one wins', async () => {
		const recorded = await Promise.all(Array.from({ length: 10 }, () => forms.recordChallenge('apply', 'digest-1', 60_000)))
		expect(recorded.filter(Boolean)).toHaveLength(1)
		expect(await forms.recordChallenge('feedback', 'digest-1', 60_000)).toBe(true)
	})

	test('an expired record is replaced, and a record prunes the expired ones', async () => {
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.${FORM_CHALLENGES_TABLE} (form, token_digest, expires_at)
				select 'apply', 'old-' || n, now() - interval '1 second' from generate_series(1, 10) n`,
			)
		)
		expect(await forms.recordChallenge('apply', 'old-1', 60_000)).toBe(true)
		expect(await rows(FORM_CHALLENGES_TABLE, 'expires_at <= now()')).toBe(0)
		expect(await rows(FORM_CHALLENGES_TABLE)).toBe(1)
	})
})
