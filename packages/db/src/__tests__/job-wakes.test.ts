// The pending wakes of the jobs and their projection over the lease, against a REAL Postgres. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { openPostgres } from '@fabrika/db/postgres'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { Database, runFixedStatement, type Session, sessionOf } from '../database'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf, type JobLeases, type JobWakes } from '../framework'
import { fencedTransaction } from '../job-leases'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
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
	/** The schema's name, for a connection of a test's own past the data layer. */
	readonly schema: string
	readonly database: Database
	readonly leases: JobLeases
	readonly wakes: JobWakes
	/** Another layer over the schema, whose runtime runs `projectWakes`. */
	layer(projectWakes: (transaction: Session) => Promise<void>): { readonly leases: JobLeases; readonly wakes: JobWakes }
	expire(job: string): Promise<unknown>
	/** Runs `statement` in the schema, past the data layer. */
	run(statement: string): Promise<unknown>
	/** The rows of `statement`, run in the schema past the data layer. */
	query(statement: string): Promise<Record<string, unknown>[]>
	/** A time the database sets: the epoch milliseconds of `expression`, evaluated in the schema. */
	epochMs(expression: string): Promise<number>
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
	const query = (statement: string) =>
		admin(async (sql): Promise<Record<string, unknown>[]> => {
			await sql.unsafe(`set search_path to ${own}`)
			return [...(await sql.unsafe(statement))]
		})
	return {
		schema: own,
		database: ownDatabase,
		leases: framework.jobs,
		wakes: framework.wakes,
		layer(projectWakes) {
			const projected = frameworkTablesOf(connected(tables, { database: ownDatabase, capabilities: authority, projectWakes }).database)
			return { leases: projected.jobs, wakes: projected.wakes }
		},
		expire: (job) => admin((sql) => sql.unsafe(`update ${own}.fabrika_job_leases set expires_at = now() - interval '1 second' where job = $1`, [job])),
		run: (statement) => admin((sql) => sql.unsafe(`set search_path to ${own}; ${statement}`)),
		query,
		async epochMs(expression) {
			const [{ ms } = {}] = await query(`select floor(extract(epoch from ${expression}) * 1000)::bigint::text as ms`)
			return Number(ms)
		},
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
		const overdue = at(-MINUTE)
		await on.wakes.schedule({ job: 'nightly', reason: 'cron', dueAt: overdue, dedupe: 'cron:nightly:0 3 * * *' })
		expect(await next()).toBe(overdue.getTime())
		const run = await taken(on, 'nightly', 'run')
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

	test('the expired holders are the jobs held past their expiry, whether or not anything declares them', async () => {
		await taken(on, 'nightly', 'run')
		await taken(on, 'removed', 'run')
		await taken(on, 'live', 'run')
		expect(await on.leases.finish(await taken(on, 'free', 'run'), 'succeeded')).toBe(true)
		expect(await on.wakes.expiredHolders()).toEqual([])
		await on.expire('nightly')
		await on.expire('removed')
		expect(await on.wakes.expiredHolders()).toEqual(['nightly', 'removed'])
		expect(await on.leases.reapCrashed('removed')).toBe(true)
		expect(await on.wakes.expiredHolders()).toEqual(['nightly'])
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

	test("an expiry inside a transaction that is already open counts: next reads the statement's clock", async () => {
		const due = at(-MINUTE)
		await on.wakes.schedule({ job: 'nightly', reason: 'kick', dueAt: due })
		await taken(on, 'nightly', 'run')
		await on.run(`update fabrika_job_leases set expires_at = clock_timestamp() + interval '200 milliseconds' where job = 'nightly'`)
		const seen = await sessionOf({ database: on.database }).transaction(async (transaction) => {
			await runFixedStatement(transaction, 'select 1', [])
			await Bun.sleep(300)
			return (await on.wakes.next(transaction))?.getTime()
		})
		expect(seen).toBe(due.getTime())
	})

	test('a wake written after the run took its lease survives its finish, though due before its start', async () => {
		const before = at(-MINUTE)
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: before })
		const run = await taken(on, 'drain', 'run')
		const start = await on.epochMs(`(select last_started_at from fabrika_job_leases where job = 'drain')`)
		// A delayed kick whose time has passed, and a kick at the start, both committed after the run took its lease.
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: new Date(start - HOUR) })
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: new Date(start) })
		expect((await on.wakes.pending('drain')).map((wake) => wake.owned)).toEqual([false, true, false])
		expect(await on.leases.finish(run, 'succeeded')).toBe(true)
		expect((await on.wakes.pending('drain')).map((wake) => wake.dueAt.getTime())).toEqual([start - HOUR, start])
	})

	test('a later kick merged into a wake the run owns takes it from the run: its finish leaves it to the next run', async () => {
		// A kick due in one second starts a run; a later kick in that second merges into its wake, and its process stops
		// before it starts anything.
		const first = at(-500)
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: first, dedupe: 'kick:drain:s' })
		const run = await taken(on, 'drain', 'run')
		expect(await on.wakes.pending('drain')).toEqual([expect.objectContaining({ owned: true })])
		expect(await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(0), dedupe: 'kick:drain:s' })).toMatchObject({
			dueAt: first,
			owned: false,
		})
		expect(await on.leases.finish(run, 'succeeded')).toBe(true)
		expect((await on.wakes.pending('drain')).map((wake) => wake.dueAt.getTime())).toEqual([first.getTime()])
		expect(await on.leases.finish(await taken(on, 'drain', 'next'), 'succeeded')).toBe(true)
		expect(await on.wakes.pending('drain')).toEqual([])
	})

	test("a cron wake scheduled again under its run stays the run's: the finish consumes it and schedules the next fire", async () => {
		const fire = at(-MINUTE)
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: fire, dedupe: 'cron:digest:0 * * * *' })
		const run = await taken(on, 'digest', 'run')
		// A repair tick while the run holds the lease schedules the job's next fire under the same key.
		expect(await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(HOUR), dedupe: 'cron:digest:0 * * * *' })).toMatchObject({
			dueAt: fire,
			owned: true,
		})
		const nextFire = at(HOUR)
		expect(await on.leases.finish(run, 'succeeded', { kind: 'completed', nextCron: { expression: '0 * * * *', dueAt: nextFire } })).toBe(true)
		expect((await on.wakes.pending('digest')).map((wake) => wake.dueAt.getTime())).toEqual([nextFire.getTime()])
	})

	test('a reap and a finish leave no wake owned', async () => {
		await on.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(-MINUTE) })
		await taken(on, 'drain', 'crashed')
		await on.expire('drain')
		expect(await on.leases.reapCrashed('drain')).toBe(true)
		expect((await on.wakes.pending('drain')).map((wake) => wake.owned)).toEqual([false])
		const lost = await taken(on, 'drain', 'failed')
		expect((await on.wakes.pending('drain')).map((wake) => wake.owned)).toEqual([true])
		expect(await on.leases.finish(lost, 'failed')).toBe(true)
		expect((await on.wakes.pending('drain')).map((wake) => wake.owned)).toEqual([false])
	})

	test('the earliest eligible wake is an index scan of fabrika_wakes_due over a populated table', async () => {
		await on.run(`insert into fabrika_job_leases (job, generation, holder, expires_at, attempt_deadline, first_seen_at)
			select 'job-' || n, 1, case when n % 2 = 0 then 'holder' end, now() + interval '1 hour', now() + interval '1 hour', now()
			from generate_series(0, 49) n;
			insert into fabrika_wakes (id, job, due_at, reason)
			select gen_random_uuid(), 'job-' || (n % 50), ${Date.now()} + n * 1000, 'kick' from generate_series(1, 10000) n;
			analyze fabrika_wakes; analyze fabrika_job_leases;`)
		const recording = new RecordingDialect()
		await frameworkTablesOf(connected(tables, { database: Database.fromDialect(recording), capabilities: authority }).database).wakes.next()
		expect(recording.log).toHaveLength(1)
		// Without a list of jobs the statement's one parameter is null.
		const text = recording.log[0]?.sql.replaceAll('$1', 'null')
		const plan = (await on.query(`explain ${text}`)).map((row) => String(Object.values(row)[0])).join('\n')
		expect(plan).toContain('Index Scan using fabrika_wakes_due on fabrika_wakes')
		expect(plan).not.toContain('Seq Scan on fabrika_wakes')
		const earliestFree = await on.epochMs(
			`'epoch'::timestamptz + interval '1 millisecond' * (select min(due_at) from fabrika_wakes where job ~ '[13579]$')`,
		)
		expect((await on.wakes.next())?.getTime()).toBe(earliestFree)
	})
})

describe.skipIf(!hasPostgres)('a finish tells the wakes what its run did with them, on Postgres', () => {
	let on: Fresh

	beforeEach(async () => {
		on = await fresh()
	})

	afterEach(async () => {
		await on.close()
	})

	const shapes = async (job: string) =>
		(await on.wakes.pending(job)).map(({ reason, dueAt, attempt, dedupe }) => ({ reason, due: dueAt.getTime(), attempt, dedupe }))

	test('completed: the owned wakes are consumed and the next cron run is scheduled under its key, later wakes stay', async () => {
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:digest:0 * * * *' })
		const run = await taken(on, 'digest', 'run')
		const later = at(10 * MINUTE)
		await on.wakes.schedule({ job: 'digest', reason: 'kick', dueAt: later })
		const nextFire = at(HOUR)
		expect(await on.leases.finish(run, 'succeeded', { kind: 'completed', nextCron: { expression: '0 * * * *', dueAt: nextFire } })).toBe(true)
		expect(await shapes('digest')).toEqual([
			{ reason: 'kick', due: later.getTime(), attempt: 0, dedupe: null },
			{ reason: 'cron', due: nextFire.getTime(), attempt: 0, dedupe: 'cron:digest:0 * * * *' },
		])
	})

	test('retry: the owned wakes move to its time and count an attempt; a wake due after the start does not move', async () => {
		await on.wakes.schedule({ job: 'sync', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:sync:* * * * *' })
		const first = await taken(on, 'sync', 'run-1')
		const later = at(10 * MINUTE)
		await on.wakes.schedule({ job: 'sync', reason: 'kick', dueAt: later })
		const retryAt = at(30_000)
		expect(await on.leases.finish(first, 'failed', { kind: 'retry', at: retryAt })).toBe(true)
		expect(await shapes('sync')).toEqual([
			{ reason: 'cron', due: retryAt.getTime(), attempt: 1, dedupe: 'cron:sync:* * * * *' },
			{ reason: 'kick', due: later.getTime(), attempt: 0, dedupe: null },
		])
		await on.run(`update fabrika_wakes set due_at = due_at - 3600000 where job = 'sync'`)
		const again = at(60_000)
		expect(await on.leases.finish(await taken(on, 'sync', 'run-2'), 'failed', { kind: 'retry', at: again })).toBe(true)
		expect((await shapes('sync')).map(({ due, attempt }) => ({ due, attempt }))).toEqual([
			{ due: again.getTime(), attempt: 2 },
			{ due: again.getTime(), attempt: 1 },
		])
	})

	test("a lost lease's finish applies neither instruction", async () => {
		const due = at(-MINUTE)
		await on.wakes.schedule({ job: 'sync', reason: 'kick', dueAt: due })
		const lost = await taken(on, 'sync', 'run-a')
		await on.expire('sync')
		expect(await on.leases.reapCrashed('sync')).toBe(true)
		await taken(on, 'sync', 'run-b')
		expect(await on.leases.finish(lost, 'failed', { kind: 'retry', at: at(HOUR) })).toBe(false)
		expect(await on.leases.finish(lost, 'succeeded', { kind: 'completed', nextCron: { expression: '* * * * *', dueAt: at(MINUTE) } })).toBe(false)
		expect(await shapes('sync')).toEqual([{ reason: 'kick', due: due.getTime(), attempt: 0, dedupe: null }])
	})

	test('a cron key another job holds refuses the finish and leaves the lease held', async () => {
		await on.wakes.schedule({ job: 'other', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:digest:0 * * * *' })
		await on.wakes.schedule({ job: 'digest', reason: 'kick', dueAt: at(-MINUTE) })
		const run = await taken(on, 'digest', 'run')
		await expect(on.leases.finish(run, 'succeeded', { kind: 'completed', nextCron: { expression: '0 * * * *', dueAt: at(HOUR) } })).rejects.toThrow(
			QueryRefusedError,
		)
		expect(await on.leases.state('digest')).toMatchObject({ holder: 'run', generation: run.generation })
		expect(await on.wakes.pending('digest')).toHaveLength(1)
	})

	test('reconcile deletes the wakes of the jobs the contract no longer declares, and keeps the declared ones', async () => {
		await on.wakes.schedule({ job: 'kept', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:kept:* * * * *' })
		await on.wakes.schedule({ job: 'gone', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:gone:* * * * *' })
		await on.wakes.schedule({ job: 'gone', reason: 'kick', dueAt: at(MINUTE) })
		expect(await on.wakes.reconcile([{ job: 'kept', expression: '* * * * *' }, { job: 'absent', expression: '0 3 * * *' }])).toBe(2)
		expect(await on.wakes.pending('gone')).toEqual([])
		expect(await on.wakes.pending('kept')).toHaveLength(1)
		expect(await on.wakes.reconcile([])).toBe(1)
	})

	test("reconcile deletes a declared job's cron wake of another expression, a retried one included, and keeps its other wakes", async () => {
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:digest:0 * * * *' })
		await on.wakes.schedule({ job: 'digest', reason: 'kick', dueAt: at(MINUTE) })
		await on.wakes.schedule({ job: 'digest', reason: 'claim', dueAt: at(MINUTE), dedupe: 'claim:digest' })
		await on.wakes.schedule({ job: 'other', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:other:*/5 * * * *' })
		expect(await on.leases.finish(await taken(on, 'digest', 'run'), 'failed', { kind: 'retry', at: at(MINUTE) })).toBe(true)
		expect((await on.wakes.pending('digest')).find((wake) => wake.reason === 'cron')?.attempt).toBe(1)
		const declared = [{ job: 'digest', expression: '30 * * * *' }, { job: 'other', expression: '*/5 * * * *' }]
		expect(await on.wakes.reconcile(declared)).toBe(1)
		expect((await on.wakes.pending('digest')).map((wake) => wake.reason).sort()).toEqual(['claim', 'kick'])
		expect(await on.wakes.pending('other')).toHaveLength(1)
		expect(await on.wakes.reconcile(declared)).toBe(0)
	})

	test("the runtime's projection runs inside every change's transaction, after it, and not for a lost finish", async () => {
		const seen: (number | null)[] = []
		const projected = on.layer(async (transaction) => {
			seen.push((await projected.wakes.next(transaction))?.getTime() ?? null)
		})
		const due = at(-MINUTE)
		await projected.wakes.schedule({ job: 'nightly', reason: 'kick', dueAt: due })
		expect(seen).toEqual([due.getTime()])
		await projected.leases.register('nightly')
		const run = await projected.leases.tryAcquire('nightly', 'run-a', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		expect(seen.at(-1)).toBe((await on.leases.state('nightly'))?.expiresAt.getTime() ?? Number.NaN)
		const renewed = await projected.leases.renew(run, 'run-a2', HOUR, HOUR)
		if (renewed === null) throw new Error('no renewal')
		await on.expire('nightly')
		expect(await projected.leases.reapCrashed('nightly')).toBe(true)
		expect(seen.at(-1)).toBe(due.getTime())
		const current = await projected.leases.acquire('nightly', 'run-b', HOUR, HOUR)
		if (current === null) throw new Error('no lease')
		const before = seen.length
		expect(await projected.leases.finish(renewed, 'succeeded')).toBe(false)
		expect(seen).toHaveLength(before)
		expect(await projected.leases.finish(current, 'succeeded')).toBe(true)
		expect(seen.at(-1)).toBeNull()
		await projected.wakes.schedule({ job: 'gone', reason: 'kick', dueAt: due })
		expect(await projected.wakes.reconcile([{ job: 'nightly', expression: '0 3 * * *' }])).toBe(1)
		expect(seen).toHaveLength(before + 3)
		expect(seen.at(-1)).toBeNull()
	})

	test('a projection that throws rolls back the change it followed', async () => {
		let failing = false
		const projected = on.layer(async () => {
			if (failing) throw new Error('the alarm could not be armed')
		})
		const due = at(-MINUTE)
		await projected.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: due })
		await projected.leases.register('drain')
		failing = true
		await expect(projected.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(MINUTE) })).rejects.toThrow('the alarm could not be armed')
		await expect(projected.leases.tryAcquire('drain', 'run', HOUR, HOUR)).rejects.toThrow('the alarm could not be armed')
		expect(await on.leases.state('drain')).toMatchObject({ holder: null, generation: 0 })
		failing = false
		const run = await projected.leases.tryAcquire('drain', 'run', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		failing = true
		await expect(projected.leases.finish(run, 'succeeded')).rejects.toThrow('the alarm could not be armed')
		await expect(projected.wakes.reconcile([])).rejects.toThrow('the alarm could not be armed')
		expect(await on.leases.state('drain')).toMatchObject({ holder: 'run', generation: run.generation })
		expect((await on.wakes.pending('drain')).map((wake) => wake.dueAt.getTime())).toEqual([due.getTime()])
	})
})

describe.skipIf(!hasPostgres)("hasten, the test kit's, on Postgres", () => {
	test("moves each named wake that is not yet due to the database's now; an overdue one and an unnamed one stay", async () => {
		const later = await wakes.schedule({ job: 'hasten-moves', reason: 'kick', dueAt: at(HOUR) })
		const overdue = await wakes.schedule({ job: 'hasten-moves', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:hasten-moves:0 3 * * *' })
		const unnamed = await wakes.schedule({ job: 'hasten-moves', reason: 'kick', dueAt: at(2 * HOUR) })
		const before = (await leases.now()).getTime()
		expect(await wakes.hasten([later.id, overdue.id])).toBe(1)
		const after = (await leases.now()).getTime()
		const pending = await wakes.pending('hasten-moves')
		expect(pending.map((wake) => wake.id)).toEqual([overdue.id, later.id, unnamed.id])
		expect(pending[0]?.dueAt).toEqual(overdue.dueAt)
		expect(pending[1]?.dueAt.getTime()).toBeGreaterThanOrEqual(before)
		expect(pending[1]?.dueAt.getTime()).toBeLessThanOrEqual(after)
		expect(pending[1]).toMatchObject({ reason: 'kick', attempt: 0, dedupe: null })
		expect(pending[2]?.dueAt).toEqual(unnamed.dueAt)
		expect(await wakes.hasten([later.id])).toBe(0)
		await expect(wakes.hasten([''])).rejects.toThrow(QueryRefusedError)
	})

	test('a run that starts after it owns the hastened wake: its finish consumes it and leaves the later one', async () => {
		const hastened = await wakes.schedule({ job: 'hasten-owned', reason: 'kick', dueAt: at(HOUR) })
		const later = await wakes.schedule({ job: 'hasten-owned', reason: 'kick', dueAt: at(2 * HOUR) })
		await wakes.hasten([hastened.id])
		const run = await lease('hasten-owned')
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect(await dues('hasten-owned')).toEqual([later.dueAt.getTime()])
	})
})

describe.skipIf(!hasPostgres)('the next wake of some jobs, on Postgres', () => {
	test('only the named jobs count: a wake or a held lease of another job does not', async () => {
		const overdue = at(-MINUTE)
		const later = at(2 * MINUTE)
		await wakes.schedule({ job: 'pg-removed', reason: 'cron', dueAt: overdue, dedupe: 'cron:pg-removed:* * * * *' })
		await wakes.schedule({ job: 'pg-digest', reason: 'cron', dueAt: later, dedupe: 'cron:pg-digest:0 * * * *' })
		await lease('pg-held')
		expect((await wakes.next(undefined, ['pg-digest']))?.getTime()).toBe(later.getTime())
		expect((await wakes.next(undefined, ['pg-digest', 'pg-removed']))?.getTime()).toBe(overdue.getTime())
		expect((await wakes.next(undefined, ['pg-held']))?.getTime()).toBeGreaterThan(Date.now() + HOUR - MINUTE)
		expect(await wakes.next(undefined, [])).toBeNull()
		const until = await wakes.untilNext(undefined, ['pg-digest'])
		expect(until).toBeGreaterThan(2 * MINUTE - 2_000)
		expect(until).toBeLessThanOrEqual(2 * MINUTE)
		await expect(wakes.next(undefined, [''])).rejects.toThrow(QueryRefusedError)
	})
})

describe.skipIf(!hasPostgres)('keeping the schedule, on Postgres', () => {
	const older = '019a0000-0000-7000-8000-0000000000f0'
	const newer = '019a0000-0000-7000-8000-0000000000f1'
	let on: Fresh

	beforeEach(async () => {
		on = await fresh()
	})

	afterEach(async () => {
		await on.close()
	})

	const dedupes = async (): Promise<string[]> => (await on.query('select dedupe from fabrika_wakes')).map((row) => String(row['dedupe'])).sort()

	test('the first generation holds it, a later one takes it over, an earlier one never takes it back', async () => {
		for (const refused of ['', older.toUpperCase(), `${older} `, '019a0000-0000-4000-8000-0000000000f0']) {
			await expect(on.wakes.keepSchedule(refused, [])).rejects.toThrow(QueryRefusedError)
		}
		expect(await on.wakes.keepSchedule(older, [])).toBe(true)
		expect(await on.wakes.keepSchedule(newer, [])).toBe(true)
		expect(await on.wakes.keepSchedule(older, [])).toBe(false)
		expect(await on.wakes.keepSchedule(newer, [])).toBe(true)
		expect(await on.query('select id, generation from fabrika_job_schedule')).toEqual([{ id: 1, generation: newer }])
	})

	test('the holder reconciles and seeds in one statement order; an older generation writes nothing', async () => {
		const next = at(MINUTE)
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(HOUR), dedupe: 'cron:digest:0 3 * * *' })
		await on.wakes.schedule({ job: 'removed', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:removed:* * * * *' })
		expect(await on.wakes.keepSchedule(newer, [{ job: 'digest', expression: '0 * * * *', dueAt: next }])).toBe(true)
		expect(await dedupes()).toEqual(['cron:digest:0 * * * *'])
		expect(await on.wakes.keepSchedule(older, [{ job: 'removed', expression: '* * * * *', dueAt: next }])).toBe(false)
		expect(await dedupes()).toEqual(['cron:digest:0 * * * *'])
	})

	test('concurrent holders of two generations leave the later one stored, and only its fires', async () => {
		const fires = (generation: string) => [{ job: generation === newer ? 'fresh' : 'stale', expression: '* * * * *', dueAt: at(MINUTE) }]
		const answers = await Promise.all([older, newer, older, newer, older].map((generation) => on.wakes.keepSchedule(generation, fires(generation))))
		expect(answers.filter((held, index) => held && index % 2 === 1)).toEqual([true, true])
		expect(await on.wakes.keepSchedule(older, fires(older))).toBe(false)
		expect(await on.wakes.keepSchedule(newer, fires(newer))).toBe(true)
		expect(await dedupes()).toEqual(['cron:fresh:* * * * *'])
	})

	test("a lease taken while another replica's seed is open still owns the pending wake: the seed locks no row it finds", async () => {
		const due = at(-MINUTE)
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: due, dedupe: 'cron:digest:* * * * *' })
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const seeding = await sql.reserve()
		try {
			await seeding.unsafe(`set search_path to ${on.schema}`)
			await seeding.unsafe('begin')
			// What keepSchedule runs for an existing key, left open.
			await seeding.unsafe(`insert into fabrika_wakes (id, job, due_at, reason, attempt, dedupe)
				values (gen_random_uuid(), 'digest', ${Date.now() + MINUTE}, 'cron', 0, 'cron:digest:* * * * *')
				on conflict (dedupe) where dedupe is not null do nothing`)
			await on.leases.register('digest')
			const run = await on.leases.tryAcquire('digest', 'replica', HOUR, HOUR)
			expect(run).not.toBeNull()
			expect((await on.wakes.pending('digest')).map((wake) => ({ owned: wake.owned, due: wake.dueAt.getTime() }))).toEqual([
				{ owned: true, due: due.getTime() },
			])
			await seeding.unsafe('commit')
		} finally {
			seeding.release()
			await sql.close()
		}
	})

	test('a guarded finish waits for an open seed of a newer generation, and writes no fire under a key it dropped', async () => {
		expect(await on.wakes.keepSchedule(older, [{ job: 'digest', expression: '0 3 * * *', dueAt: null }])).toBe(true)
		await on.leases.register('digest')
		const run = await on.leases.tryAcquire('digest', 'older-run', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const seeding = await sql.reserve()
		const settled = (promise: Promise<unknown>): Promise<boolean> => Promise.race([promise.then(() => true), Bun.sleep(300).then(() => false)])
		try {
			await seeding.unsafe(`set search_path to ${on.schema}`)
			await seeding.unsafe('begin')
			await seeding.unsafe(`update fabrika_job_schedule set generation = '${newer}', declared = '["cron:digest:0 4 * * *"]'`)
			const finishing = on.leases.finish(run, 'succeeded', {
				kind: 'completed',
				nextCron: { expression: '0 3 * * *', dueAt: at(HOUR), scheduled: true },
			})
			expect(await settled(finishing)).toBe(false)
			await seeding.unsafe('commit')
			expect(await finishing).toBe(true)
			expect(await on.wakes.pending('digest')).toEqual([])
		} finally {
			seeding.release()
			await sql.close()
		}
	})

	test('a released lease frees the job, disowns its wakes and records no run', async () => {
		await on.wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:digest:* * * * *' })
		await on.leases.register('digest')
		const run = await on.leases.tryAcquire('digest', 'replica', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		expect(await on.leases.release(run)).toBe(true)
		expect(await on.leases.release(run)).toBe(false)
		expect(await on.leases.state('digest')).toMatchObject({ holder: null, lastStatus: null, lastFinishedAt: null })
		expect((await on.wakes.pending('digest')).map((wake) => wake.owned)).toEqual([false])
	})

	test("a newer generation waits for an older one's open seed and reconciles after it; an older one behind a newer writes nothing", async () => {
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const seeding = await sql.reserve()
		const settled = (promise: Promise<unknown>): Promise<boolean> => Promise.race([promise.then(() => true), Bun.sleep(300).then(() => false)])
		try {
			// An older deploy's seed, still open: it holds the row it raised.
			await seeding.unsafe(`set search_path to ${on.schema}`)
			await seeding.unsafe('begin')
			await seeding.unsafe(`insert into fabrika_job_schedule (id, generation) values (1, '${older}')
				on conflict (id) do update set generation = greatest(fabrika_job_schedule.generation, excluded.generation)`)
			await seeding.unsafe(`insert into fabrika_wakes (id, job, due_at, reason, dedupe)
				values (gen_random_uuid(), 'stale', ${Date.now() + MINUTE}, 'cron', 'cron:stale:* * * * *')`)
			const taking = on.wakes.keepSchedule(newer, [{ job: 'fresh', expression: '* * * * *', dueAt: at(MINUTE) }])
			expect(await settled(taking)).toBe(false)
			await seeding.unsafe('commit')
			expect(await taking).toBe(true)
			expect(await dedupes()).toEqual(['cron:fresh:* * * * *'])

			// The newer deploy's seed, still open: an older one queued behind it reads the newer and writes nothing.
			await seeding.unsafe('begin')
			await seeding.unsafe(`update fabrika_job_schedule set generation = '${newer}'`)
			const behind = on.wakes.keepSchedule(older, [{ job: 'stale', expression: '* * * * *', dueAt: at(MINUTE) }])
			expect(await settled(behind)).toBe(false)
			await seeding.unsafe('commit')
			expect(await behind).toBe(false)
			expect(await dedupes()).toEqual(['cron:fresh:* * * * *'])
		} finally {
			seeding.release()
			await sql.close()
		}
	})
})

describe.skipIf(!hasPostgres)('the schedule migration', () => {
	test('an existing schema applies 0013 and 0014 alone, and the runtime role holds the schedule', async () => {
		const appId = `sched-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const earlier = FRAMEWORK_MIGRATIONS.filter((file) => file.name < '0013_job_schedule.sql')
		expect(earlier).toHaveLength(FRAMEWORK_MIGRATIONS.length - 2)
		const migrationsOf = (framework: typeof FRAMEWORK_MIGRATIONS) =>
			definePostgresApplicationMigrations({ appId, directory: '/nonexistent', framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: framework } })
		try {
			const app = [{ name: '20261124120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY)' }]
			expect(await migrationsOf(earlier).migrate(url, app)).toEqual([...earlier.map((file) => `fabrika/${file.name}`), `app/${app[0]?.name}`])
			const after = migrationsOf(FRAMEWORK_MIGRATIONS)
			expect(await after.migrate(url, app)).toEqual(['fabrika/0013_job_schedule.sql', 'fabrika/0014_job_schedule_declared.sql'])
			const runtime = openPostgres({ url: applicationRuntimeUrl(url, appId), schema: after.schema, max: 1 })
			try {
				const migrated = frameworkTablesOf(connected(tables, { database: runtime, capabilities: authority }).database).wakes
				const fires = [{ job: 'kept', expression: '* * * * *', dueAt: at(MINUTE) }]
				expect(await migrated.keepSchedule('019a0000-0000-7000-8000-000000000001', fires)).toBe(true)
				expect((await migrated.pending('kept')).map((wake) => wake.dedupe)).toEqual(['cron:kept:* * * * *'])
			} finally {
				await runtime.close()
			}
		} finally {
			await dropApplicationDatabase(url, appId)
		}
	})
})

describe.skipIf(!hasPostgres)('the wakes migration', () => {
	test('an existing schema that holds the earlier framework files applies 0009 and 0010 alone, and the runtime role writes the table', async () => {
		const appId = `wakes-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const throughWakes = FRAMEWORK_MIGRATIONS.filter((file) => file.name <= '0010_job_wakes_owned.sql')
		const earlier = FRAMEWORK_MIGRATIONS.filter((file) => file.name < '0009_job_wakes.sql')
		expect(earlier).toHaveLength(throughWakes.length - 2)
		const migrationsOf = (framework: typeof FRAMEWORK_MIGRATIONS) =>
			definePostgresApplicationMigrations({ appId, directory: '/nonexistent', framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: framework } })
		try {
			const app = [{ name: '20261024120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY)' }]
			const before = migrationsOf(earlier)
			expect(await before.migrate(url, app)).toEqual([...earlier.map((file) => `fabrika/${file.name}`), `app/${app[0]?.name}`])
			const after = migrationsOf(throughWakes)
			expect(await after.migrate(url, app)).toEqual(['fabrika/0009_job_wakes.sql', 'fabrika/0010_job_wakes_owned.sql'])
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
