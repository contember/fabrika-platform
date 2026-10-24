// The pending wakes of the jobs and their projection over the lease, on SQLite (a bun:sqlite stand-in for a Durable
// Object's storage): deduplication, the T1 < T2 rule, consumption only at a fenced successful finish, and the earliest
// due time across a reap and a lost lease.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { runFixedStatement, type Session, sessionOf } from '../database'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf, type JobLeases, type JobWakes } from '../framework'
import { fencedTransaction } from '../job-leases'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '../migrations-sqlite'
import { openSqlite, type SqliteStorage } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { migrateSqlite } from '../sqlite-migrate'
import { TestAuthority } from './fixtures/authority'
import { type SqliteFramework, sqliteFramework } from './fixtures/sqlite-framework'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const HOUR = 3_600_000
const MINUTE = 60_000
const APP = `CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;`

let db: SqliteFramework
let leases: JobLeases
let wakes: JobWakes

/** The framework tables of a layer over `db`, with the runtime's projection when given. */
function layer(projectWakes?: (transaction: Session) => Promise<void>): { readonly leases: JobLeases; readonly wakes: JobWakes } {
	const runtime = { database: db.database, capabilities: new TestAuthority('job:purge'), ...(projectWakes === undefined ? {} : { projectWakes }) }
	const framework = frameworkTablesOf(connected(tables, runtime).database)
	return { leases: framework.jobs, wakes: framework.wakes }
}

beforeEach(async () => {
	db = await sqliteFramework(APP)
	;({ leases, wakes } = layer())
})

const at = (offsetMs: number): Date => new Date(Date.now() + offsetMs)

async function lease(job: string, holder = `holder-${job}`): Promise<LeaseFence> {
	await leases.register(job)
	const fence = await leases.tryAcquire(job, holder, HOUR, HOUR)
	if (fence === null) throw new Error('no lease')
	return fence
}

/** Moves the lease's expiry `seconds` into the past, as time passing would. */
function expire(job: string, seconds = 1): void {
	db.exec(`update fabrika_job_leases set expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) where job = ?`, `-${seconds} seconds`, job)
}

const dues = async (job: string): Promise<number[]> => (await wakes.pending(job)).map((wake) => wake.dueAt.getTime())

describe('the wakes of a job on SQLite', () => {
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
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t2 })
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t1 })
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t1, dedupe: 'kick:remind:1' })
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t1, dedupe: 'kick:remind:2' })
		expect(await dues('remind')).toEqual([t1.getTime(), t1.getTime(), t1.getTime(), t2.getTime()])
	})

	test("a key another job holds is refused, and the other job's wake is untouched", async () => {
		const t1 = at(MINUTE)
		await wakes.schedule({ job: 'a', reason: 'claim', dueAt: t1, dedupe: 'claim:a' })
		await expect(wakes.schedule({ job: 'b', reason: 'claim', dueAt: at(-MINUTE), dedupe: 'claim:a' })).rejects.toThrow(QueryRefusedError)
		expect(await dues('a')).toEqual([t1.getTime()])
		expect(await wakes.pending('b')).toEqual([])
	})

	test('a malformed wake is refused before it reaches the table', async () => {
		await expect(wakes.schedule({ job: '', reason: 'kick', dueAt: at(0) })).rejects.toThrow(QueryRefusedError)
		await expect(wakes.schedule({ job: 'j', reason: 'kick', dueAt: new Date(Number.NaN) })).rejects.toThrow(QueryRefusedError)
		await expect(wakes.schedule({ job: 'j', reason: 'kick', dueAt: at(0), dedupe: '' })).rejects.toThrow(QueryRefusedError)
		expect(db.exec('select count(*) as n from fabrika_wakes')).toEqual([{ n: 0 }])
	})

	test('a wake written in a transaction that rolls back is not pending', async () => {
		const failed = sessionOf({ database: db.database }).transaction(async (transaction) => {
			await wakes.schedule({ job: 'kicked', reason: 'kick', dueAt: at(0) }, transaction)
			throw new Error('the mutation failed')
		})
		await expect(failed).rejects.toThrow('the mutation failed')
		expect(await wakes.pending('kicked')).toEqual([])
	})

	test('two delayed kicks at T1 < T2: the run that started after T1 consumes T1 and leaves T2', async () => {
		const t1 = at(-MINUTE)
		const t2 = at(HOUR)
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t2 })
		await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: t1 })
		const run = await lease('remind')
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect(await dues('remind')).toEqual([t2.getTime()])
		expect((await wakes.next())?.getTime()).toBe(t2.getTime())
	})

	test('nothing is consumed before the fenced, successful finish of the run that owns it', async () => {
		const due = at(-MINUTE)
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: due })
		const run = await lease('drain')
		expect(await dues('drain')).toEqual([due.getTime()])
		await fencedTransaction(sessionOf({ database: db.database }), run, async (transaction) => {
			await runFixedStatement(transaction, `insert into notes (id, title) values ('n1', 'note')`, [])
		})
		expect(await dues('drain')).toEqual([due.getTime()])
		// A kick that arrives while the run is in flight is due after the run started: the next run owns it.
		const during = at(1000)
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: during })
		expect(await leases.finish(run, 'failed')).toBe(true)
		expect(await dues('drain')).toEqual([due.getTime(), during.getTime()])
		const retry = await lease('drain', 'retry')
		expect(await leases.finish(retry, 'succeeded')).toBe(true)
		expect(await dues('drain')).toEqual([during.getTime()])
	})

	test('the finish and the consumption commit together: a consumption that fails leaves the lease held', async () => {
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(-MINUTE) })
		const run = await lease('drain')
		db.exec('alter table fabrika_wakes rename to fabrika_wakes_gone')
		await expect(leases.finish(run, 'succeeded')).rejects.toThrow()
		db.exec('alter table fabrika_wakes_gone rename to fabrika_wakes')
		expect(await leases.state('drain')).toMatchObject({ holder: 'holder-drain', generation: run.generation })
		expect(await wakes.pending('drain')).toHaveLength(1)
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect(await wakes.pending('drain')).toEqual([])
	})

	test('the next wake is null with nothing pending, and a held lease alone answers its expiry', async () => {
		expect(await wakes.next()).toBeNull()
		await lease('nightly')
		const expiry = (await leases.state('nightly'))?.expiresAt
		expect(expiry).toBeInstanceOf(Date)
		expect((await wakes.next())?.getTime()).toBe(expiry?.getTime() ?? Number.NaN)
	})

	test('the next wake is the earliest of free jobs and held expiries, across jobs', async () => {
		const soon = at(MINUTE)
		await wakes.schedule({ job: 'later', reason: 'kick', dueAt: at(2 * MINUTE) })
		await wakes.schedule({ job: 'sooner', reason: 'cron', dueAt: soon, dedupe: 'cron:sooner:* * * * *' })
		expect((await wakes.next())?.getTime()).toBe(soon.getTime())
	})

	test('the projection follows a reap: a held job answers its expiry, the reaped one its wake, and nothing is consumed', async () => {
		const due = at(10 * MINUTE)
		await wakes.schedule({ job: 'nightly', reason: 'kick', dueAt: due })
		await lease('nightly')
		const held = (await leases.state('nightly'))?.expiresAt.getTime()
		expect((await wakes.next())?.getTime()).toBe(held ?? Number.NaN)
		expire('nightly')
		const expired = (await leases.state('nightly'))?.expiresAt.getTime() ?? Number.NaN
		expect(expired).toBeLessThan(Date.now())
		expect((await wakes.next())?.getTime()).toBe(expired)
		expect(await leases.reapCrashed('nightly')).toBe(true)
		expect(await dues('nightly')).toEqual([due.getTime()])
		expect((await wakes.next())?.getTime()).toBe(due.getTime())
	})

	test('the projection follows a lost lease: the run that lost it consumes nothing, the run that took it over does', async () => {
		const due = at(-MINUTE)
		await wakes.schedule({ job: 'sync', reason: 'kick', dueAt: due })
		const lost = await lease('sync', 'run-a')
		expire('sync')
		expect(await leases.reapCrashed('sync')).toBe(true)
		const current = await lease('sync', 'run-b')
		expect(await leases.finish(lost, 'succeeded')).toBe(false)
		expect(await dues('sync')).toEqual([due.getTime()])
		expect((await wakes.next())?.getTime()).toBe((await leases.state('sync'))?.expiresAt.getTime() ?? Number.NaN)
		const renewed = await leases.renew(current, 'run-b2', HOUR, HOUR)
		expect(await leases.finish(current, 'succeeded')).toBe(false)
		expect(await dues('sync')).toEqual([due.getTime()])
		if (renewed === null) throw new Error('no renewal')
		expect(await leases.finish(renewed, 'succeeded')).toBe(true)
		expect(await wakes.pending('sync')).toEqual([])
		expect(await wakes.next()).toBeNull()
	})
})

describe('the wakes migration', () => {
	test('an existing database that holds 0001 applies 0002 alone, and keeps its rows', async () => {
		const storage = bunSqliteStorage()
		const port = { exec: storage.sql.exec, transactionSync: <T>(fn: () => T): T => storage.transactionSync(fn) }
		const first = SQLITE_FRAMEWORK_MIGRATIONS.filter((migration) => migration.name === '0001_framework.sql')
		expect(first).toHaveLength(1)
		expect((await migrateSqlite(port, [{ bundle: 'fabrika', migrations: first }])).applied).toEqual(['fabrika/0001_framework.sql'])
		storage.sql.exec(`insert into fabrika_job_kicks (job, pending) values ('kept', 1)`)
		const result = await migrateSqlite(port, [{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS }])
		expect(result.applied).toEqual(['fabrika/0002_job_wakes.sql'])
		expect(storage.sql.exec('select bundle, name from fabrika_migrations order by name').toArray()).toEqual([
			{ bundle: 'fabrika', name: '0001_framework.sql' },
			{ bundle: 'fabrika', name: '0002_job_wakes.sql' },
		])
		expect(storage.sql.exec('select job, pending from fabrika_job_kicks').toArray()).toEqual([{ job: 'kept', pending: 1 }])
		const migrated = frameworkTablesOf(connected(tables, { database: openSqlite(storage), capabilities: new TestAuthority() }).database).wakes
		const due = at(MINUTE)
		await migrated.schedule({ job: 'kept', reason: 'kick', dueAt: due })
		expect((await migrated.next())?.getTime()).toBe(due.getTime())
	})
})

const shapes = async (job: string) =>
	(await wakes.pending(job)).map(({ reason, dueAt, attempt, dedupe }) => ({ reason, due: dueAt.getTime(), attempt, dedupe }))

describe('a finish tells the wakes what its run did with them', () => {
	test('completed: the owned wakes are consumed and the next cron run is scheduled under its key, later wakes stay', async () => {
		await wakes.schedule({ job: 'digest', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:digest:0 * * * *' })
		const run = await lease('digest')
		const later = at(10 * MINUTE)
		await wakes.schedule({ job: 'digest', reason: 'kick', dueAt: later })
		const nextFire = at(HOUR)
		expect(await leases.finish(run, 'succeeded', { kind: 'completed', nextCron: { expression: '0 * * * *', dueAt: nextFire } })).toBe(true)
		expect(await shapes('digest')).toEqual([
			{ reason: 'kick', due: later.getTime(), attempt: 0, dedupe: null },
			{ reason: 'cron', due: nextFire.getTime(), attempt: 0, dedupe: 'cron:digest:0 * * * *' },
		])
	})

	test('completed after the last retry failed: a failed outcome consumes them too', async () => {
		await wakes.schedule({ job: 'digest', reason: 'kick', dueAt: at(-MINUTE) })
		expect(await leases.finish(await lease('digest'), 'failed', { kind: 'completed' })).toBe(true)
		expect(await wakes.pending('digest')).toEqual([])
	})

	test('retry: the owned wakes move to its time and count an attempt; a wake due after the start does not move', async () => {
		await wakes.schedule({ job: 'sync', reason: 'cron', dueAt: at(-MINUTE), dedupe: 'cron:sync:* * * * *' })
		const first = await lease('sync')
		const later = at(10 * MINUTE)
		await wakes.schedule({ job: 'sync', reason: 'kick', dueAt: later })
		const retryAt = at(30_000)
		expect(await leases.finish(first, 'failed', { kind: 'retry', at: retryAt })).toBe(true)
		expect(await shapes('sync')).toEqual([
			{ reason: 'cron', due: retryAt.getTime(), attempt: 1, dedupe: 'cron:sync:* * * * *' },
			{ reason: 'kick', due: later.getTime(), attempt: 0, dedupe: null },
		])
		// A run that starts before the moved wake is due owns nothing, so its retry moves nothing.
		expect(await leases.finish(await lease('sync', 'early'), 'failed', { kind: 'retry', at: at(HOUR) })).toBe(true)
		expect((await shapes('sync')).map(({ attempt }) => attempt)).toEqual([1, 0])
		// Time passes: both are due before the next run starts, which owns both.
		db.exec(`update fabrika_wakes set due_at = due_at - 3600000 where job = 'sync'`)
		const again = at(60_000)
		expect(await leases.finish(await lease('sync', 'second'), 'failed', { kind: 'retry', at: again })).toBe(true)
		expect((await shapes('sync')).map(({ due, attempt }) => ({ due, attempt }))).toEqual([
			{ due: again.getTime(), attempt: 2 },
			{ due: again.getTime(), attempt: 1 },
		])
	})

	test("a lost lease's finish applies neither instruction", async () => {
		const due = at(-MINUTE)
		await wakes.schedule({ job: 'sync', reason: 'kick', dueAt: due })
		const lost = await lease('sync', 'run-a')
		expire('sync')
		expect(await leases.reapCrashed('sync')).toBe(true)
		await lease('sync', 'run-b')
		expect(await leases.finish(lost, 'failed', { kind: 'retry', at: at(HOUR) })).toBe(false)
		expect(await leases.finish(lost, 'succeeded', { kind: 'completed', nextCron: { expression: '* * * * *', dueAt: at(MINUTE) } })).toBe(false)
		expect(await shapes('sync')).toEqual([{ reason: 'kick', due: due.getTime(), attempt: 0, dedupe: null }])
	})

	test('a malformed instruction, or a cron key another job holds, refuses the finish and leaves the lease held', async () => {
		await wakes.schedule({ job: 'other', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:digest:0 * * * *' })
		await wakes.schedule({ job: 'digest', reason: 'kick', dueAt: at(-MINUTE) })
		const run = await lease('digest')
		await expect(leases.finish(run, 'succeeded', { kind: 'retry', at: at(MINUTE) })).rejects.toThrow(QueryRefusedError)
		await expect(leases.finish(run, 'failed', { kind: 'retry', at: new Date(Number.NaN) })).rejects.toThrow(QueryRefusedError)
		const nextCron = { expression: '0 * * * *', dueAt: at(HOUR) }
		await expect(leases.finish(run, 'succeeded', { kind: 'completed', nextCron })).rejects.toThrow(QueryRefusedError)
		expect(await leases.state('digest')).toMatchObject({ holder: 'holder-digest', generation: run.generation })
		expect(await wakes.pending('digest')).toHaveLength(1)
	})

	test('a wake due after the run started survives its finish; one due exactly at the start is consumed', async () => {
		const run = await lease('drain')
		const start = (await leases.state('drain'))?.lastStartedAt
		if (start === null || start === undefined) throw new Error('no start')
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: start })
		const between = new Date(start.getTime() + 1)
		await wakes.schedule({ job: 'drain', reason: 'kick', dueAt: between })
		await Bun.sleep(10)
		expect(await leases.finish(run, 'succeeded')).toBe(true)
		expect((await leases.state('drain'))?.lastFinishedAt?.getTime()).toBeGreaterThan(between.getTime())
		expect(await dues('drain')).toEqual([between.getTime()])
	})
})

describe('reconcile', () => {
	test('deletes the wakes of the jobs the contract no longer declares, and keeps the declared ones', async () => {
		await wakes.schedule({ job: 'kept', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:kept:* * * * *' })
		await wakes.schedule({ job: 'gone', reason: 'cron', dueAt: at(MINUTE), dedupe: 'cron:gone:* * * * *' })
		await wakes.schedule({ job: 'gone', reason: 'kick', dueAt: at(MINUTE) })
		expect(await wakes.reconcile(['kept', 'absent'])).toBe(2)
		expect(await wakes.pending('gone')).toEqual([])
		expect(await wakes.pending('kept')).toHaveLength(1)
		expect(await wakes.reconcile(['kept'])).toBe(0)
		await expect(wakes.reconcile([''])).rejects.toThrow(QueryRefusedError)
		expect(await wakes.reconcile([])).toBe(1)
	})
})

/** The holder of `job`'s lease as `transaction` sees it. */
async function holderIn(transaction: Session, job: string): Promise<unknown> {
	const [row] = await runFixedStatement(transaction, 'select holder from fabrika_job_leases where job = ?1', [job])
	return typeof row === 'object' && row !== null ? Object.values(row)[0] : null
}

describe("the runtime's projection", () => {
	test('runs inside the transaction of every wake and lease change, after the change, and not for a lost finish', async () => {
		const seen: { readonly next: number | null; readonly holder: unknown }[] = []
		const projected = layer(async (transaction) => {
			seen.push({ next: (await projected.wakes.next(transaction))?.getTime() ?? null, holder: await holderIn(transaction, 'nightly') })
		})
		const due = at(-MINUTE)
		await projected.wakes.schedule({ job: 'nightly', reason: 'kick', dueAt: due })
		expect(seen).toEqual([{ next: due.getTime(), holder: null }])
		await projected.leases.register('nightly')
		const run = await projected.leases.tryAcquire('nightly', 'run-a', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		expect(seen.at(-1)).toEqual({ next: (await leases.state('nightly'))?.expiresAt.getTime() ?? Number.NaN, holder: 'run-a' })
		const renewed = await projected.leases.renew(run, 'run-a2', HOUR, HOUR)
		if (renewed === null) throw new Error('no renewal')
		expect(seen.at(-1)?.holder).toBe('run-a2')
		expire('nightly')
		expect(await projected.leases.reapCrashed('nightly')).toBe(true)
		expect(seen.at(-1)).toEqual({ next: due.getTime(), holder: null })
		const taken = await projected.leases.acquire('nightly', 'run-b', HOUR, HOUR)
		if (taken === null) throw new Error('no lease')
		expect(seen.at(-1)?.holder).toBe('run-b')
		const before = seen.length
		expect(await projected.leases.finish(renewed, 'succeeded')).toBe(false)
		expect(seen).toHaveLength(before)
		expect(await projected.leases.finish(taken, 'succeeded')).toBe(true)
		expect(seen.at(-1)).toEqual({ next: null, holder: null })
		await projected.wakes.schedule({ job: 'gone', reason: 'kick', dueAt: due })
		expect(seen.at(-1)).toEqual({ next: due.getTime(), holder: null })
		expect(await projected.wakes.reconcile(['nightly'])).toBe(1)
		expect(seen.at(-1)).toEqual({ next: null, holder: null })
		expect(seen).toHaveLength(before + 3)
	})

	test('a projection that throws rolls back the change it followed', async () => {
		let failing = false
		const projected = layer(async () => {
			if (failing) throw new Error('the alarm could not be armed')
		})
		const due = at(-MINUTE)
		await projected.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: due })
		await projected.leases.register('drain')
		failing = true
		await expect(projected.wakes.schedule({ job: 'drain', reason: 'kick', dueAt: at(MINUTE) })).rejects.toThrow('the alarm could not be armed')
		await expect(projected.leases.tryAcquire('drain', 'run', HOUR, HOUR)).rejects.toThrow('the alarm could not be armed')
		expect(await leases.state('drain')).toMatchObject({ holder: null, generation: 0 })
		failing = false
		const run = await projected.leases.tryAcquire('drain', 'run', HOUR, HOUR)
		if (run === null) throw new Error('no lease')
		failing = true
		await expect(projected.leases.finish(run, 'succeeded')).rejects.toThrow('the alarm could not be armed')
		await expect(projected.wakes.reconcile([])).rejects.toThrow('the alarm could not be armed')
		expect(await leases.state('drain')).toMatchObject({ holder: 'run', generation: run.generation })
		expect(await dues('drain')).toEqual([due.getTime()])
	})
})

describe('the next wake reads the due index', () => {
	test('the earliest eligible wake walks fabrika_wakes_due and probes each lease by its key', async () => {
		for (let index = 0; index < 200; index++) {
			await wakes.schedule({ job: `job-${index % 20}`, reason: 'kick', dueAt: at(index * 1000) })
		}
		const issued: string[] = []
		const recording: SqliteStorage = {
			sql: {
				exec: (query, ...bindings) => {
					issued.push(query)
					return db.storage.sql.exec(query, ...bindings)
				},
			},
			transaction: (closure) => db.storage.transaction(closure),
			transactionSync: (closure) => db.storage.transactionSync(closure),
		}
		const recorded = frameworkTablesOf(connected(tables, { database: openSqlite(recording), capabilities: new TestAuthority() }).database).wakes
		expect(await recorded.next()).toEqual(await wakes.next())
		expect(issued).toHaveLength(1)
		const plan = db.exec(`explain query plan ${issued[0]}`).map(({ detail }) => String(detail))
		expect(plan).toContain('SCAN w USING INDEX fabrika_wakes_due')
		expect(plan).toContainEqual(expect.stringMatching(/^SEARCH l USING INDEX sqlite_autoindex_fabrika_job_leases_1 \(job=\?\)( LEFT-JOIN)?$/))
		expect(plan.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false)
	})
})
