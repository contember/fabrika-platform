// How a bound Date reaches Postgres: as its ISO 8601 UTC text, whatever the process time zone, and an invalid Date
// never reaches it. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { openTestPostgres } from '@fabrika/db/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Within } from '../capability'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { defineStore } from '../store'
import { TestAuthority } from './fixtures/authority'
import { recordingLayer } from './fixtures/harness'
import { connected } from './fixtures/stores'
import { migration as tasksMigration, tables as tasksTables } from './fixtures/tasks'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`date-binding.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

/** West of UTC, so `Date#toString()` names an offset Postgres does not read as one. */
const PROCESS_TIME_ZONE = 'America/Los_Angeles'
const originalTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const AT = new Date('2026-03-04T05:06:07.891Z')
const later = (date: Date, ms: number): Date => new Date(date.getTime() + ms)

const schema = `dates_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database
let close: (task: string, at: Date, expectVersion: number) => Promise<unknown>
let closedBetween: (within: Within<'project', 'tasks.read'>, from: Date, to: Date) => Promise<readonly { id: string }[]>

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

const closedAt = async (task: string): Promise<unknown> =>
	(await admin((sql) => sql.unsafe(`select closed_at from ${schema}.tasks where id = $1`, [task])))[0]?.closed_at

beforeAll(async () => {
	process.env.TZ = PROCESS_TIME_ZONE
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${tasksMigration}`)
		await sql.unsafe(`insert into ${schema}.projects (id, org_id, title) values ('p1', 'o1', 'p1')`)
		await sql.unsafe(
			`insert into ${schema}.tasks (id, project_id, org_id, title, created_by, version) values ('t1', 'p1', 'o1', 't1', 'user:alice', 1), ('t2', 'p1', 'o1', 't2', 'user:alice', 1)`,
		)
	})
	database = openTestPostgres({ url: url ?? '', schema, max: 2 })
	const layer = connected(tasksTables, { database, capabilities: alice }).database
	const tasks = defineStore(layer, 'tasks', (t) => ({
		close: (task: string, at: Date, expectVersion: number) =>
			t.update(alice.ref('task', 'tasks.write', task, { project: 'p1', org: 'o1' }), { closed_at: at }, { expectVersion }),
		closedBetween: (within: Within<'project', 'tasks.read'>, from: Date, to: Date) =>
			t.select(within, (q) => q.columns(['id']).where('closed_at', '>=', from).where('closed_at', '<', to).orderBy('id')),
	}))
	close = tasks.close
	closedBetween = tasks.closedBetween
})

afterAll(async () => {
	process.env.TZ = originalTimeZone
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe('a bound Date', () => {
	test('the process runs west of UTC', () => {
		expect(AT.getTimezoneOffset()).toBeGreaterThan(0)
	})

	test('is bound as its ISO 8601 UTC text', async () => {
		const layer = recordingLayer()
		const notes = defineStore(layer.stores.database, 'notes', (t) => ({
			since: (within: Within<'workspace', 'notes.read'>, from: Date) => t.select(within, (q) => q.columns(['id']).where('created_at', '>=', from)),
		}))
		const outcome = await layer.attempt(() => notes.since(layer.within('notes.read'), AT))
		expect(outcome.error).toBeUndefined()
		expect(outcome.statements.map((statement) => statement.parameters)).toEqual([['2026-03-04T05:06:07.891Z', 'w1']])
	})

	test('an invalid Date is refused before any statement is sent', async () => {
		const layer = recordingLayer()
		const notes = defineStore(layer.stores.database, 'notes', (t) => ({
			since: (within: Within<'workspace', 'notes.read'>, from: Date) => t.select(within, (q) => q.columns(['id']).where('created_at', '>=', from)),
		}))
		const fromStore = await layer.attempt(() => notes.since(layer.within('notes.read'), new Date(Number.NaN)))
		expect(fromStore.error).toBeInstanceOf(QueryRefusedError)
		expect(fromStore.statements).toEqual([])
	})
})

describe.skipIf(!hasPostgres)('a bound Date on Postgres', () => {
	test('the layer stores it to the millisecond', async () => {
		await close('t1', AT, 1)
		expect(await closedAt('t1')).toEqual(AT)
	})

	test('an invalid Date is refused and nothing is written', async () => {
		await expect(close('t2', new Date(Number.NaN), 1)).rejects.toBeInstanceOf(QueryRefusedError)
		expect(await closedAt('t2')).toBeNull()
	})

	test('a store compares it to the millisecond', async () => {
		const within = alice.within('project', 'tasks.read', ['p1'])
		expect(await closedBetween(within, AT, later(AT, 1))).toEqual([{ id: 't1' }])
		expect(await closedBetween(within, later(AT, 1), later(AT, 2))).toEqual([])
		expect(await closedBetween(within, later(AT, -1), AT)).toEqual([])
	})
})
