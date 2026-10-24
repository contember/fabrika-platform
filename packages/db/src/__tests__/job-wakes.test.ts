// The pending wakes of the jobs and their projection over the lease, against a REAL Postgres. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { openPostgres } from '@fabrika/db/postgres'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { type Database, runFixedStatement, sessionOf } from '../database'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf, type JobLeases, type JobWakes } from '../framework'
import { fencedTransaction } from '../job-leases'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`job-wakes.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `jw_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const HOUR = 3_600_000
const MINUTE = 60_000
const authority = new TestAuthority('job:purge')
let database: Database
let leases: JobLeases
let wakes: JobWakes

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration}`)
		await sql.unsafe(`set search_path to ${schema};
			insert into organizations (id, name) values ('o1', 'Org');
			insert into workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'W1', 'u');`)
	})
	database = openPostgres({ url, schema, max: 4 })
	const framework = frameworkTablesOf(connected(tables, { database, capabilities: authority }).database)
	leases = framework.jobs
	wakes = framework.wakes
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

const at = (offsetMs: number): Date => new Date(Date.now() + offsetMs)

async function lease(job: string, holder = `holder-${job}`): Promise<LeaseFence> {
	await leases.register(job)
	const fence = await leases.tryAcquire(job, holder, HOUR, HOUR)
	if (fence === null) throw new Error('no lease')
	return fence
}

const dues = async (job: string): Promise<number[]> => (await wakes.pending(job)).map((wake) => wake.dueAt.getTime())

describe.skipIf(!hasPostgres)('the wakes of a job on Postgres', () => {
	test('a dedupe key holds one wake, at the earliest due time: a later one never replaces it', async () => {
		const t1 = at(MINUTE)
		const t2 = at(2 * MINUTE)
		const first = await wakes.schedule({ job: 'digest', reason: 'cron', dueAt: t2, dedupe: 'cron:digest:0 * * * *' })
		const earlier = await wakes.schedule({ job: 'digest', reason: 'cron', dueAt: t1, dedupe: 'cron:digest:0 * * * *' })
		const later = await wakes.schedule({ job: 'digest', reason: 'cron', dueAt: t2, dedupe: 'cron:digest:0 * * * *' })
		expect(earlier.id).toBe(first.id)
		expect(later).toEqual(earlier)
		expect(later).toMatchObject({ job: 'digest', reason: 'cron', dueAt: t1, attempt: 0, dedupe: 'cron:digest:0 * * * *' })
		expect(await dues('digest')).toEqual([t1.getTime()])
	})

	test('wakes without a key, or under different keys, stay separate rows', async () => {
		const t1 = at(MINUTE)
		const t2 = at(2 * MINUTE)
		await wakes.schedule({ job: 'remind-keys', reason: 'kick', dueAt: t2 })
		await wakes.schedule({ job: 'remind-keys', reason: 'kick', dueAt: t1 })
		await wakes.schedule({ job: 'remind-keys', reason: 'kick', dueAt: t1, dedupe: 'kick:remind-keys:1' })
		await wakes.schedule({ job: 'remind-keys', reason: 'kick', dueAt: t1, dedupe: 'kick:remind-keys:2' })
		expect(await dues('remind-keys')).toEqual([t1.getTime(), t1.getTime(), t1.getTime(), t2.getTime()])
	})

	test("a key another job holds is refused, and the other job's wake is untouched", async () => {
		const t1 = at(MINUTE)
		await wakes.schedule({ job: 'owner', reason: 'claim', dueAt: t1, dedupe: 'claim:owner' })
		await expect(wakes.schedule({ job: 'thief', reason: 'claim', dueAt: at(-MINUTE), dedupe: 'claim:owner' })).rejects.toThrow(QueryRefusedError)
		expect(await dues('owner')).toEqual([t1.getTime()])
		expect(await wakes.pending('thief')).toEqual([])
	})

	test('a wake written in a transaction that rolls back is not pending', async () => {
		const failed = sessionOf({ database }).transaction(async (transaction) => {
			await wakes.schedule({ job: 'rolled-back', reason: 'kick', dueAt: at(0) }, transaction)
			throw new Error('the mutation failed')
		})
		await expect(failed).rejects.toThrow('the mutation failed')
		expect(await wakes.pending('rolled-back')).toEqual([])
	})

	test('two delayed kicks at T1 < T2: the run that started after T1 consumes T1 and leaves T2', async () => {
		const t1 = at(-MINUTE)
		const t2 = at(HOUR)
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t2 })
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t1 })
		const run = await lease('remind')
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect(await dues('remind')).toEqual([t2.getTime()])
	})

	test('nothing is consumed before the fenced, successful finish of the run that owns it', async () => {
		const due = at(-MINUTE)
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: due })
		const run = await lease('drain')
		expect(await dues('drain')).toEqual([due.getTime()])
		await fencedTransaction(sessionOf({ database }), run, async (transaction) => {
			await runFixedStatement(transaction, `select 1`, [])
		})
		expect(await dues('drain')).toEqual([due.getTime()])
		const during = at(1000)
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: during })
		expect(await leases.finish(run, 'failed')).toBe(true)
		expect(await dues('drain')).toEqual([due.getTime(), during.getTime()])
		const retry = await lease('drain', 'retry')
		expect(await leases.finish(retry, 'succeeded')).toBe(true)
		expect(await dues('drain')).toEqual([during.getTime()])
	})
})

interface Fresh {
	readonly leases: JobLeases
	readonly wakes: JobWakes
	expire(job: string): Promise<unknown>
	/** Runs `statement` in the schema, past the data layer. */
	run(statement: string): Promise<unknown>
	close(): Promise<void>
}

/** A schema of its own, where the next wake depends only on what the case wrote. */
async function fresh(): Promise<Fresh> {
	const own = `jx_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${own}`)
		await sql.unsafe(`set search_path to ${own}; ${FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')} ${migration}`)
	})
	const ownDatabase = openPostgres({ url, schema: own, max: 2 })
	const framework = frameworkTablesOf(connected(tables, { database: ownDatabase, capabilities: authority }).database)
	return {
		leases: framework.jobs,
		wakes: framework.wakes,
		expire: (job) => admin((sql) => sql.unsafe(`update ${own}.fabrika_job_leases set expires_at = now() - interval '1 second' where job = $1`, [job])),
		run: (statement) => admin((sql) => sql.unsafe(`set search_path to ${own}; ${statement}`)),
		async close() {
			await ownDatabase.close()
			await admin((sql) => sql.unsafe(`drop schema ${own} cascade`))
		},
	}
}

async function taken(on: Fresh, job: string, holder: string): Promise<LeaseFence> {
	await on.leases.register(job)
	const fence = await on.leases.tryAcquire(job, holder, HOUR, HOUR)
	if (fence === null) throw new Error('no lease')
	return fence
}

describe.skipIf(!hasPostgres)('the next wake on Postgres', () => {
	let on: Fresh

	beforeEach(async () => {
		on = await fresh()
	})

	afterEach(async () => {
		await on.close()
	})

	const next = async (): Promise<number | null> => (await on.wakes.next())?.getTime() ?? null
	const expiryOf = async (job: string): Promise<number> => (await on.leases.state(job))?.expiresAt.getTime() ?? Number.NaN

	test('null with nothing pending; a held lease answers its expiry; a free job its earliest wake', async () => {
		expect(await next()).toBeNull()
		const run = await taken(on, 'nightly', 'run')
		expect(await next()).toBe(await expiryOf('nightly'))
		await on.wakes.schedule({ job: 'nightly', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:nightly:0 3 * * *' })
		expect(await next()).toBe(await expiryOf('nightly'))
		const soon = at(MINUTE)
		await on.wakes.schedule({ job: 'other', reason: 'kick', dueAt: soon })
		expect(await next()).toBe(soon.getTime())
		expect(await on.leases.finish(run, 'succeeded')).toBe(true)
		expect(await next()).toBe(soon.getTime())
		expect(await on.wakes.pending('nightly')).toEqual([])
	})

	test('the projection follows a reap: a held job answers its expiry, the reaped one its wake, and nothing is consumed', async () => {
		const due = at(10 * MINUTE)
		await on.wakes.schedule({ job: 'nightly', reason: 'kick', dueAt: due })
		await taken(on, 'nightly', 'run')
		expect(await next()).toBe(await expiryOf('nightly'))
		await on.expire('nightly')
		const expired = await expiryOf('nightly')
		expect(expired).toBeLessThan(Date.now())
		expect(await next()).toBe(expired)
		expect(await on.leases.reapCrashed('nightly')).toBe(true)
		expect((await on.wakes.pending('nightly')).map((wake) => wake.dueAt.getTime())).toEqual([due.getTime()])
		expect(await next()).toBe(due.getTime())
	})

	test('the projection follows a lost lease: the run that lost it consumes nothing, the run that took it over does', async () => {
		const due = at(-MINUTE)
		await on.wakes.schedule({ job: 'sync', reason: 'kick', dueAt: due })
		const lost = await taken(on, 'sync', 'run-a')
		await on.expire('sync')
		expect(await on.leases.reapCrashed('sync')).toBe(true)
		const current = await taken(on, 'sync', 'run-b')
		expect(await on.leases.finish(lost, 'succeeded')).toBe(false)
		expect((await on.wakes.pending('sync')).map((wake) => wake.dueAt.getTime())).toEqual([due.getTime()])
		expect(await next()).toBe(await expiryOf('sync'))
		const renewed = await on.leases.renew(current, 'run-b2', HOUR, HOUR)
		expect(await on.leases.finish(current, 'succeeded')).toBe(false)
		expect(await on.wakes.pending('sync')).toHaveLength(1)
		if (renewed === null) throw new Error('no renewal')
		expect(await on.leases.finish(renewed, 'succeeded')).toBe(true)
		expect(await on.wakes.pending('sync')).toEqual([])
		expect(await next()).toBeNull()
	})

	test('the finish and the consumption commit together: a consumption that fails leaves the lease held', async () => {
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(-MINUTE) })
		const run = await taken(on, 'drain', 'run')
		await on.run('alter table fabrika_wakes rename to fabrika_wakes_gone')
		await expect(on.leases.finish(run, 'succeeded')).rejects.toThrow()
		await on.run('alter table fabrika_wakes_gone rename to fabrika_wakes')
		expect(await on.leases.state('drain')).toMatchObject({ holder: 'run', generation: run.generation })
		expect(await on.wakes.pending('drain')).toHaveLength(1)
		expect(await on.leases.finish(run, 'succeeded')).toBe(true)
		expect(await on.wakes.pending('drain')).toEqual([])
	})
})

describe.skipIf(!hasPostgres)('the wakes migration', () => {
	test('an existing schema that holds the earlier framework files applies 0009 alone, and the runtime role writes the table', async () => {
		const appId = `wakes-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const earlier = FRAMEWORK_MIGRATIONS.filter((file) => file.name !== '0009_job_wakes.sql')
		expect(earlier).toHaveLength(FRAMEWORK_MIGRATIONS.length - 1)
		const migrationsOf = (framework: typeof FRAMEWORK_MIGRATIONS) =>
			definePostgresApplicationMigrations({ appId, directory: '/nonexistent', framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: framework } })
		try {
			const app = [{ name: '20261024120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY)' }]
			const before = migrationsOf(earlier)
			expect(await before.migrate(url, app)).toEqual([...earlier.map((file) => `fabrika/${file.name}`), `app/${app[0]?.name}`])
			const after = migrationsOf(FRAMEWORK_MIGRATIONS)
			expect(await after.migrate(url, app)).toEqual(['fabrika/0009_job_wakes.sql'])
			const runtime = openPostgres({ url: applicationRuntimeUrl(url, appId), schema: after.schema, max: 1 })
			try {
				const migrated = frameworkTablesOf(connected(tables, { database: runtime, capabilities: authority }).database).wakes
				const due = at(MINUTE)
				await migrated.schedule({ job: 'kept', reason: 'kick', dueAt: due })
				expect((await migrated.next())?.getTime()).toBe(due.getTime())
			} finally {
				await runtime.close()
			}
		} finally {
			await dropApplicationDatabase(url, appId)
		}
	})
})
