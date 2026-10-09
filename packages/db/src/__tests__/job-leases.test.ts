// The job lease and the fence on every mutation, against a REAL Postgres. Skips cleanly when FABRIKA_TEST_POSTGRES_URL
// is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { Database } from '../database'
import { LeaseLostError } from '../errors'
import { frameworkTablesOf, type JobLeases } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { connected, defineStores } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`job-leases.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `jl_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const HOUR = 3_600_000
let database: Database
let leases: JobLeases
const authority = new TestAuthority('job:purge')

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

const stores = () => defineStores({ database, capabilities: authority })
const n1 = () => authority.ref('note', 'notes.delete', 'n1', { workspace: 'w1', organization: 'o1' })

async function noteExists(): Promise<boolean> {
	return (await admin((sql) => sql.unsafe(`select id from ${schema}.notes where id = 'n1'`))).length > 0
}

async function lease(job: string, attemptMs = HOUR): Promise<LeaseFence> {
	const fence = await leases.acquire(job, `holder-${job}`, attemptMs, HOUR)
	if (fence === null) throw new Error('no lease')
	return fence
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
	database = Database.postgres({ url: url ?? '', schema, max: 4 })
	leases = frameworkTablesOf(connected(tables, { database, capabilities: authority }).database).jobs
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe('the lease tables exist only as a migration', () => {
	test('the framework side refuses a layer scoped(tables) did not create', () => {
		expect(() => frameworkTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
		const unbound = frameworkTablesOf(connected(tables, { database: Database.fromDialect(new RecordingDialect()), capabilities: authority }).database)
		expect(typeof unbound.jobs.acquire).toBe('function')
	})
})

describe.skipIf(!hasPostgres)('the job lease on Postgres', () => {
	test('registering a job records when it was first seen, once', async () => {
		expect(await leases.state('fresh')).toBeNull()
		await leases.register('fresh')
		const first = await leases.state('fresh')
		await leases.register('fresh')
		expect(await leases.state('fresh')).toEqual(first)
		expect(first).toMatchObject({ generation: 0, holder: null, lastStatus: null, lastSucceededAt: null })
	})

	test('an overlapping run does not get the lease; an expired one is reaped as crashed, once, then taken over', async () => {
		const first = await leases.acquire('nightly', 'run-a', HOUR, HOUR)
		expect(first).toEqual({ job: 'nightly', holder: 'run-a', generation: 1 })
		expect(await leases.acquire('nightly', 'run-b', HOUR, HOUR)).toBeNull()
		expect(await leases.reapCrashed('nightly')).toBe(false)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set expires_at = now() - interval '1 second' where job = 'nightly'`))
		expect(await leases.acquire('nightly', 'run-b', HOUR, HOUR)).toBeNull()
		expect((await Promise.all([leases.reapCrashed('nightly'), leases.reapCrashed('nightly')])).sort()).toEqual([false, true])
		expect(await leases.state('nightly')).toMatchObject({ holder: null, lastStatus: 'failed', lastDurationMs: expect.any(Number) })
		expect(await leases.acquire('nightly', 'run-b', HOUR, HOUR)).toEqual({ job: 'nightly', holder: 'run-b', generation: 2 })
		if (first === null) throw new Error('no lease')
		expect(await leases.finish(first, 'succeeded')).toBe(false)
	})

	test('concurrent runs: exactly one takes a free lease', async () => {
		const runs = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((holder) => leases.acquire('race', holder, HOUR, HOUR)))
		expect(runs.filter((fence) => fence !== null)).toHaveLength(1)
	})

	test('renew hands the lease to the next attempt; the previous attempt can neither renew nor finish', async () => {
		const first = await lease('retrying')
		const second = await leases.renew(first, 'attempt-2', HOUR, HOUR)
		expect(second).toEqual({ job: 'retrying', holder: 'attempt-2', generation: first.generation + 1 })
		expect(await leases.renew(first, 'attempt-3', HOUR, HOUR)).toBeNull()
		expect(await leases.finish(first, 'failed')).toBe(false)
		if (second === null) throw new Error('no renewal')
		expect(await leases.finish(second, 'succeeded')).toBe(true)
		const state = await leases.state('retrying')
		expect(state).toMatchObject({ generation: second.generation, holder: null, lastStatus: 'succeeded', lastDurationMs: expect.any(Number) })
		expect(state?.lastSucceededAt).toEqual(state?.lastFinishedAt ?? null)
		expect(await leases.acquire('retrying', 'next-run', HOUR, HOUR)).toEqual({ job: 'retrying', holder: 'next-run', generation: second.generation + 1 })
	})

	test('an overdue job is claimed for one report per period, by one of many concurrent claimers', async () => {
		await leases.register('stalled')
		expect(await leases.claimOverdue('stalled', HOUR)).toBeNull()
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set first_seen_at = now() - interval '3 hours' where job = 'stalled'`))
		const claims = await Promise.all([1, 2, 3, 4, 5].map(() => leases.claimOverdue('stalled', HOUR)))
		expect(claims.filter((claim) => claim !== null)).toEqual([{ lastSucceededAt: null, firstSeenAt: expect.any(Date) }])
		expect(await leases.claimOverdue('stalled', HOUR)).toBeNull()
		await admin((sql) =>
			sql.unsafe(`update ${schema}.fabrika_job_leases set last_missed_reported_at = now() - interval '61 minutes' where job = 'stalled'`)
		)
		expect(await leases.claimOverdue('stalled', HOUR)).not.toBeNull()
	})
})

describe.skipIf(!hasPostgres)('every mutation checks the fence of the attempt running it', () => {
	beforeEach(async () => {
		authority.lease = null
		await admin((sql) =>
			sql.unsafe(`set search_path to ${schema}; delete from notes;
				insert into notes (id, workspace_id, organization_id, title, created_by, version) values ('n1', 'w1', 'o1', 'One', 'u', 1)`)
		)
	})

	test('a live fence lets the write commit', async () => {
		authority.lease = await lease('live-writer')
		await stores().organizations.create(authority.ref('organization', 'organizations.create', 'o-live'), 'Live')
		const rows = await admin((sql) => sql.unsafe(`select id from ${schema}.organizations where id = 'o-live'`))
		expect([...rows]).toEqual([{ id: 'o-live' }])
	})

	test('a run that lost its lease cannot commit an insert, an update or a delete', async () => {
		const stale = await lease('lost-writer')
		await leases.renew(stale, 'the-next-attempt', HOUR, HOUR)
		authority.lease = stale
		const { organizations, workspaces, notes } = stores()
		await expect(organizations.create(authority.ref('organization', 'organizations.create', 'o-lost'), 'Lost')).rejects.toBeInstanceOf(
			LeaseLostError,
		)
		await expect(workspaces.rename(authority.ref('workspace', 'workspaces.admin', 'w1', { organization: 'o1' }), 'Renamed')).rejects.toBeInstanceOf(
			LeaseLostError,
		)
		await expect(notes.remove(n1())).rejects.toBeInstanceOf(LeaseLostError)
		const state = await admin(async (sql) => ({
			organizations: [...(await sql.unsafe(`select id from ${schema}.organizations where id = 'o-lost'`))],
			workspace: [...(await sql.unsafe(`select name from ${schema}.workspaces where id = 'w1'`))],
		}))
		expect(state).toEqual({ organizations: [], workspace: [{ name: 'W1' }] })
		expect(await noteExists()).toBe(true)
	})

	test('an attempt past its deadline writes nothing, even before anyone takes the lease over', async () => {
		authority.lease = await lease('late-writer', 1)
		await Bun.sleep(20)
		await expect(stores().notes.remove(n1())).rejects.toThrow("job 'late-writer' lost its lease or its attempt's deadline")
		expect(await noteExists()).toBe(true)
	})

	test('a write that passed the fence and then blocks past the deadline is cancelled and commits nothing', async () => {
		authority.lease = await lease('blocked-writer', 800)
		await admin(async (sql) => {
			await sql.unsafe('begin')
			await sql.unsafe(`select id from ${schema}.notes where id = 'n1' for update`)
			const started = Date.now()
			await expect(stores().notes.remove(n1())).rejects.toBeInstanceOf(LeaseLostError)
			expect(Date.now() - started).toBeLessThan(5_000)
			await sql.unsafe('rollback')
		})
		expect(await noteExists()).toBe(true)
	})

	test('ending the attempt cancels its blocked statement and refuses every further write', async () => {
		const fence = await lease('cancelled-writer')
		authority.lease = fence
		await admin(async (sql) => {
			await sql.unsafe('begin')
			await sql.unsafe(`select id from ${schema}.notes where id = 'n1' for update`)
			const removal = stores().notes.remove(n1())
			await Bun.sleep(150)
			await leases.cancelInFlight(fence)
			await expect(removal).rejects.toBeInstanceOf(LeaseLostError)
			await sql.unsafe('rollback')
		})
		await expect(stores().notes.remove(n1())).rejects.toThrow('has ended; it writes nothing more')
		expect(await noteExists()).toBe(true)
	})

	test('the fence holds the lease row until the write commits, so a takeover waits for it', async () => {
		const fence = await lease('slow-writer')
		const order: string[] = []
		await admin(async (sql) => {
			await sql.unsafe('begin')
			await sql.unsafe(`select job from ${schema}.fabrika_job_leases where job = 'slow-writer' for share`)
			const renewal = leases.renew(fence, 'next', HOUR, HOUR).then((next) => {
				order.push('renewed')
				return next
			})
			await Bun.sleep(100)
			order.push('committed')
			await sql.unsafe('commit')
			expect(await renewal).not.toBeNull()
		})
		expect(order).toEqual(['committed', 'renewed'])
	})
})
