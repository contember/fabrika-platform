// The job lease and the fence on every mutation of a job attempt, on SQLite (a bun:sqlite stand-in for a Durable
// Object's storage). Postgres' row lock and backend cancellation have no SQLite form: while a transaction is open the
// object serves no other event, so the fence is the check before the work and the check before the commit.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { runFixedStatement, sessionOf } from '../database'
import { LeaseLostError } from '../errors'
import { frameworkTablesOf, type JobLeases } from '../framework'
import { databaseNow, fencedTransaction } from '../job-leases'
import { TestAuthority } from './fixtures/authority'
import { type SqliteFramework, sqliteFramework } from './fixtures/sqlite-framework'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const HOUR = 3_600_000
const APP = `CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;`

let db: SqliteFramework
let leases: JobLeases

beforeEach(async () => {
	db = await sqliteFramework(APP)
	leases = frameworkTablesOf(connected(tables, { database: db.database, capabilities: new TestAuthority('job:purge') }).database).jobs
})

async function lease(job: string, attemptMs = HOUR): Promise<LeaseFence> {
	const fence = await leases.acquire(job, `holder-${job}`, attemptMs, HOUR)
	if (fence === null) throw new Error('no lease')
	return fence
}

/** Moves a lease column `seconds` into the past, as time passing would. */
function backdate(job: string, column: string, seconds: number): void {
	db.exec(`update fabrika_job_leases set ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) where job = ?`, `-${seconds} seconds`, job)
}

/** Writes a note under `fence`, as a job's `ctx.transaction` does; `during` runs after the write, before the commit. */
function write(fence: LeaseFence, id: string, during: () => Promise<void> = async () => {}): Promise<void> {
	return fencedTransaction(sessionOf({ database: db.database }), fence, async (transaction) => {
		await runFixedStatement(transaction, `insert into notes (id, title) values (?1, 'note')`, [id])
		await during()
	})
}

const notes = () => db.exec('select id from notes order by id').map((row) => row['id'])

describe('the job lease on SQLite', () => {
	test("the database's clock and every lease time come back as Dates", async () => {
		const before = Date.now()
		const now = await leases.now()
		expect(now).toBeInstanceOf(Date)
		expect(now.getTime()).toBeGreaterThanOrEqual(before - 5)
		expect(now.getTime()).toBeLessThanOrEqual(Date.now() + 5)
		await lease('clocked')
		const state = await leases.state('clocked')
		expect(state?.expiresAt.getTime()).toBeGreaterThan(now.getTime() + HOUR - 1000)
		expect(state?.firstSeenAt).toBeInstanceOf(Date)
		expect(state?.lastStartedAt).toBeInstanceOf(Date)
		expect(await sessionOf({ database: db.database }).transaction((session) => databaseNow(session))).toBeInstanceOf(Date)
	})

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
		backdate('nightly', 'expires_at', 1)
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
		backdate('retrying', 'last_started_at', 2)
		expect(await leases.finish(second, 'succeeded')).toBe(true)
		const state = await leases.state('retrying')
		expect(state).toMatchObject({ generation: second.generation, holder: null, lastStatus: 'succeeded' })
		expect(state?.lastDurationMs).toBeGreaterThanOrEqual(2000)
		expect(state?.lastDurationMs).toBeLessThan(3000)
		expect(state?.lastSucceededAt).toEqual(state?.lastFinishedAt ?? null)
		expect(await leases.acquire('retrying', 'next-run', HOUR, HOUR)).toEqual({ job: 'retrying', holder: 'next-run', generation: second.generation + 1 })
	})

	test('a lease past its expiry cannot be renewed', async () => {
		const fence = await lease('expired')
		backdate('expired', 'expires_at', 1)
		expect(await leases.renew(fence, 'attempt-2', HOUR, HOUR)).toBeNull()
	})

	test('a failed run keeps the last success', async () => {
		const run = await lease('flaky')
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		const succeeded = (await leases.state('flaky'))?.lastSucceededAt
		expect(succeeded).toBeInstanceOf(Date)
		expect(await leases.finish(await lease('flaky'), 'failed')).toBe(true)
		expect(await leases.state('flaky')).toMatchObject({ lastStatus: 'failed', lastSucceededAt: succeeded })
	})

	test('a kick sets the pending flag whoever holds the lease, and one caller takes it', async () => {
		expect(await leases.takePending('kicked')).toBe(false)
		await Promise.all([1, 2, 3].map(() => leases.markPending('kicked')))
		expect((await Promise.all([leases.takePending('kicked'), leases.takePending('kicked')])).sort()).toEqual([false, true])
		const run = await lease('kicked')
		await leases.markPending('kicked')
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect(await leases.takePending('kicked')).toBe(true)
		expect(await leases.takePending('kicked')).toBe(false)
	})

	test('tryAcquire takes a free lease of a registered job once, and none while a run holds it', async () => {
		expect(await leases.tryAcquire('kicked-now', 'k0', HOUR, HOUR)).toBeNull()
		await leases.register('kicked-now')
		const taken = await Promise.all(['k1', 'k2', 'k3'].map((holder) => leases.tryAcquire('kicked-now', holder, HOUR, HOUR)))
		expect(taken.filter((fence) => fence !== null)).toHaveLength(1)
		const [fence] = taken.filter((candidate) => candidate !== null)
		if (fence === undefined || fence === null) throw new Error('no lease')
		expect(fence.generation).toBe(1)
		expect(await leases.tryAcquire('kicked-now', 'k4', HOUR, HOUR)).toBeNull()
		expect(await leases.finish(fence, 'succeeded')).toBe(true)
		expect(await leases.tryAcquire('kicked-now', 'k4', HOUR, HOUR)).toMatchObject({ holder: 'k4', generation: 2 })
	})

	test('an overdue job is claimed for one report per period, by one of many concurrent claimers', async () => {
		await leases.register('stalled')
		expect(await leases.claimOverdue('stalled', HOUR)).toBeNull()
		backdate('stalled', 'first_seen_at', 3 * 3600)
		const claims = await Promise.all([1, 2, 3, 4, 5].map(() => leases.claimOverdue('stalled', HOUR)))
		expect(claims.filter((claim) => claim !== null)).toEqual([{ lastSucceededAt: null, firstSeenAt: expect.any(Date) }])
		expect(await leases.claimOverdue('stalled', HOUR)).toBeNull()
		backdate('stalled', 'last_missed_reported_at', 61 * 60)
		expect(await leases.claimOverdue('stalled', HOUR)).not.toBeNull()
	})

	test('refuses a duration that is no whole number of milliseconds', async () => {
		await expect(leases.acquire('bad', 'h', 0, HOUR)).rejects.toThrow('whole number of milliseconds')
		await expect(leases.claimOverdue('bad', 1.5)).rejects.toThrow('whole number of milliseconds')
	})
})

describe('every mutation of an attempt is fenced by its lease on SQLite', () => {
	test('a live fence lets the write commit', async () => {
		await write(await lease('live-writer'), 'n-live')
		expect(notes()).toEqual(['n-live'])
	})

	test('a run that lost its lease writes nothing', async () => {
		const stale = await lease('lost-writer')
		await leases.renew(stale, 'the-next-attempt', HOUR, HOUR)
		await expect(write(stale, 'n-lost')).rejects.toBeInstanceOf(LeaseLostError)
		expect(notes()).toEqual([])
	})

	test('an attempt past its deadline writes nothing, even before anyone takes the lease over', async () => {
		const fence = await lease('late-writer', 1)
		await Bun.sleep(20)
		await expect(write(fence, 'n-late')).rejects.toThrow("job 'late-writer' lost its lease or its attempt's deadline")
		expect(notes()).toEqual([])
	})

	// Postgres cancels such a statement at the deadline; SQLite has no statement to cancel, so the commit is refused.
	test('a write that passed the fence and runs past the deadline commits nothing', async () => {
		const fence = await lease('slow-writer', 200)
		await expect(write(fence, 'n-slow', () => Bun.sleep(300))).rejects.toBeInstanceOf(LeaseLostError)
		expect(notes()).toEqual([])
	})

	test('a generation that changed while the attempt worked makes its commit refused', async () => {
		const fence = await lease('taken-writer')
		await expect(write(fence, 'n-taken', async () => {
			db.exec(`update fabrika_job_leases set generation = generation + 1 where job = 'taken-writer'`)
		})).rejects.toBeInstanceOf(LeaseLostError)
		expect(notes()).toEqual([])
	})

	test('ending the attempt rolls its open transaction back and refuses every further write', async () => {
		const fence = await lease('cancelled-writer')
		const hold = Promise.withResolvers<void>()
		const running = write(fence, 'n-cancelled', () => hold.promise)
		const outcome = running.then(() => 'committed', (error: unknown) => error)
		await Bun.sleep(50)
		await leases.cancelInFlight(fence)
		expect(await outcome).toBeInstanceOf(LeaseLostError)
		hold.resolve()
		expect(notes()).toEqual([])
		expect(await leases.finish(fence, 'failed')).toBe(true)
		await expect(write(fence, 'n-after')).rejects.toThrow('has ended; it writes nothing more')
		expect(notes()).toEqual([])
	})
})
