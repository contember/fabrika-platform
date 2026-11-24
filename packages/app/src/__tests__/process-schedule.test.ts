// The serving process keeps the job schedule where no crontab runs (ADR-0080), through `boot`'s real job runner on a REAL
// Postgres: the deploy of the highest generation seeds one cron wake per job and reconciles what an older contract left;
// replicas whose timers fire together run one due fire once; a fire due while a run holds the lease stays due without the
// pending flag; an older deploy's run writes no next fire; a stopped run keeps its wake. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import type { ContractApp } from '@fabrika/app/implement'
import { applicationSchema, type Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ProcessSchedule } from '../jobs/runner'
import { bootApp, environment, frameworkEnvFor, workloadTokensFor } from './fixtures/implement/harness'
import { awayFromMinuteEdge } from './fixtures/minute-edge'
import { migration } from './fixtures/public-kick/migration'
import { signupApp } from './fixtures/public-kick/src/app'
import type { SignupWorld } from './fixtures/public-kick/src/world'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`process-schedule.test.ts skipped: set ${URL_VAR} to run it (the wakes, the leases and the schedule live in @fabrika/db)`)
}

const schema = applicationSchema(`sched-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const OLDER = '019a0000-0000-7000-8000-000000000001'
const NEWER = '019a0000-0000-7000-8000-000000000002'
const MINUTE = 60_000
const CRON_KEY = 'cron:welcome:* * * * *'
const opened: Database[] = []
const instances: Instance[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.signups, ${schema}.applications, ${schema}.notices; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_job_kicks; delete from ${schema}.fabrika_wakes; delete from ${schema}.fabrika_job_schedule`,
		)
	)
})

afterEach(async () => {
	for (const held of gates.splice(0)) held.open()
	await Promise.race([Promise.all(instances.splice(0).map((instance) => instance.settled())), Bun.sleep(3_000)])
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

interface Gate {
	readonly reached: Promise<void>
	open(): void
	wait(): Promise<void>
}

const gates: Gate[] = []

function gate(): Gate {
	const reached = Promise.withResolvers<void>()
	const opened = Promise.withResolvers<void>()
	const held: Gate = {
		reached: reached.promise,
		open: () => opened.resolve(),
		wait: async () => {
			reached.resolve()
			await opened.promise
		},
	}
	gates.push(held)
	return held
}

class World implements SignupWorld {
	readonly runs: string[] = []
	holdStart: Gate | null = null

	async started(run: { readonly runId: string }): Promise<void> {
		this.runs.push(run.runId)
		const hold = this.holdStart
		this.holdStart = null
		await hold?.wait()
	}

	async taken(): Promise<void> {}

	welcomed(): void {}
}

interface Instance {
	readonly app: ContractApp
	readonly world: World
	/** One look of the wake timer; the runs it starts are tracked until `settled`. */
	wake(): Promise<number | null>
	settled(): Promise<void>
}

/** A serving process of the deploy of `generation` over the shared schema. */
function start(generation: string): Instance {
	const world = new World()
	const { implementation, variables } = signupApp(world)
	const connection = openPostgres({ url, schema, max: 4 })
	opened.push(connection)
	const schedule: ProcessSchedule = { generation }
	const app = bootApp(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), ...variables, TURNSTILE_SECRET: 'turnstile-secret-1' }),
		workloadTokens: workloadTokensFor(implementation),
		database: connection,
		jobSchedule: schedule,
	})
	const runs = new Set<Promise<void>>()
	const instance: Instance = {
		app,
		world,
		wake: () => app.jobs.wake((run) => runs.add(run)),
		async settled() {
			while (runs.size > 0) {
				const pending = [...runs]
				runs.clear()
				await Promise.all(pending)
			}
		},
	}
	instances.push(instance)
	return instance
}

interface StoredWake {
	readonly job: string
	readonly reason: string
	readonly dedupe: string | null
	readonly due: number
	readonly owned: boolean
}

async function wakes(): Promise<StoredWake[]> {
	const rows = await admin((sql) =>
		sql.unsafe(`select job, reason, dedupe, due_at::text as due, owned from ${schema}.fabrika_wakes order by job, dedupe nulls last, due_at`)
	)
	return [...rows].map((row) => ({ job: row.job, reason: row.reason, dedupe: row.dedupe, due: Number(row.due), owned: row.owned }))
}

/** The database's now, in epoch milliseconds. */
async function databaseNow(): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now`))
	return Number(row?.now)
}

/** Moves every wake of the welcome job `ms` into the past of the database's clock. */
async function overdue(ms = MINUTE): Promise<void> {
	const now = await databaseNow()
	await admin((sql) => sql.unsafe(`update ${schema}.fabrika_wakes set due_at = ${now - ms} where job = 'welcome'`))
}

async function insertWake(job: string, reason: string, due: number, dedupe: string | null): Promise<void> {
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.fabrika_wakes (id, job, due_at, reason, dedupe) values (gen_random_uuid(), '${job}', ${due}, '${reason}', ${
				dedupe === null ? 'null' : `'${dedupe}'`
			})`,
		)
	)
}

async function leaseOf(): Promise<{ readonly holder: string | null; readonly pending: boolean } | undefined> {
	const [row] = await admin((sql) =>
		sql.unsafe(
			`select holder, coalesce(k.pending, false) as pending from ${schema}.fabrika_job_leases l left join ${schema}.fabrika_job_kicks k using (job) where job = 'welcome'`,
		)
	)
	return row === undefined ? undefined : { holder: row.holder, pending: row.pending }
}

async function storedGeneration(): Promise<string | null> {
	const [row] = await admin((sql) => sql.unsafe(`select generation from ${schema}.fabrika_job_schedule`))
	return row === undefined ? null : String(row.generation)
}

const runsOf = (...of: readonly Instance[]): number => of.reduce((sum, instance) => sum + instance.world.runs.length, 0)

function quietly<T>(work: () => Promise<T>): Promise<T> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	return work().finally(() => log.mockRestore())
}

describe.skipIf(!hasPostgres)('the serving process keeps the job schedule (FABRIKA_JOBS_SCHEDULE=process)', () => {
	test("the deploy's process seeds one cron wake per job at its next fire; an older deploy's process seeds none", async () => {
		await awayFromMinuteEdge(url)
		const newer = start(NEWER)
		const older = start(OLDER)
		const before = await databaseNow()
		const delay = await newer.wake()
		const [seeded, ...rest] = await wakes()
		expect(rest).toEqual([])
		expect(seeded).toMatchObject({ job: 'welcome', reason: 'cron', dedupe: CRON_KEY, owned: false })
		expect(seeded?.due).toBeGreaterThan(before)
		expect(seeded?.due).toBeLessThanOrEqual(before + MINUTE)
		expect((seeded?.due ?? 1) % MINUTE).toBe(0)
		expect(delay).toBeGreaterThan(0)
		expect(delay).toBeLessThanOrEqual(MINUTE)
		expect(await storedGeneration()).toBe(NEWER)

		await admin((sql) => sql.unsafe(`delete from ${schema}.fabrika_wakes`))
		expect(await older.wake()).toBeNull()
		expect(await wakes()).toEqual([])
		expect(await storedGeneration()).toBe(NEWER)
		expect(runsOf(newer, older)).toBe(0)
	})

	test('replicas whose timers fire together run one due fire once, and the run schedules the next fire', async () => {
		await awayFromMinuteEdge(url)
		const replicas = [start(NEWER), start(NEWER), start(NEWER)]
		await replicas[0]?.wake()
		await overdue()
		await Promise.all(replicas.map((replica) => replica.wake()))
		await Promise.all(replicas.map((replica) => replica.settled()))
		expect(runsOf(...replicas)).toBe(1)
		const [next, ...rest] = await wakes()
		expect(rest).toEqual([])
		expect(next).toMatchObject({ job: 'welcome', reason: 'cron', dedupe: CRON_KEY, owned: false })
		expect(next?.due).toBeGreaterThan(await databaseNow())
		expect(await leaseOf()).toEqual({ holder: null, pending: false })

		await Promise.all(replicas.map((replica) => replica.wake()))
		await Promise.all(replicas.map((replica) => replica.settled()))
		expect(runsOf(...replicas)).toBe(1)
	})

	test('a fire due while a run holds the lease stays due, without the pending flag, and runs once the lease is free', async () => {
		await awayFromMinuteEdge(url)
		const first = start(NEWER)
		const second = start(NEWER)
		await first.wake()
		await overdue()
		const held = gate()
		first.world.holdStart = held
		await first.wake()
		await held.reached
		const now = await databaseNow()
		await insertWake('welcome', 'kick', now - 1_000, null)
		await second.wake()
		expect(await leaseOf()).toMatchObject({ pending: false })
		expect(runsOf(first, second)).toBe(1)
		const kicked = (await wakes()).filter((wake) => wake.reason === 'kick')
		expect(kicked).toEqual([expect.objectContaining({ owned: false })])

		held.open()
		await first.settled()
		expect(runsOf(first, second)).toBe(1)
		expect((await wakes()).filter((wake) => wake.reason === 'kick')).toHaveLength(1)
		expect(await second.wake()).toBeGreaterThanOrEqual(0)
		await second.settled()
		expect(runsOf(first, second)).toBe(2)
		expect((await wakes()).map((wake) => wake.reason)).toEqual(['cron'])
	})

	test("an older deploy's run of a due fire writes no next fire; the deploy's process seeds it", async () => {
		await awayFromMinuteEdge(url)
		const newer = start(NEWER)
		const older = start(OLDER)
		await newer.wake()
		await overdue()
		await older.wake()
		await older.settled()
		expect(runsOf(newer, older)).toBe(1)
		expect(await wakes()).toEqual([])
		await newer.wake()
		const [seeded, ...rest] = await wakes()
		expect(rest).toEqual([])
		expect(seeded).toMatchObject({ job: 'welcome', reason: 'cron', dedupe: CRON_KEY })
		expect(seeded?.due).toBeGreaterThan(await databaseNow())
	})

	test("the deploy's process reconciles what an older contract left; an older process neither restores it nor waits on it", async () => {
		await awayFromMinuteEdge(url)
		const newer = start(NEWER)
		const older = start(OLDER)
		await newer.wake()
		const now = await databaseNow()
		await insertWake('welcome', 'cron', now + 10 * MINUTE, 'cron:welcome:0 3 * * *')
		await insertWake('gone', 'cron', now - MINUTE, 'cron:gone:* * * * *')
		const delay = await older.wake()
		// The removed job's overdue wake would answer 0 and spin the timer at the retry.
		expect(delay).toBeGreaterThan(0)
		expect((await wakes()).map((wake) => wake.dedupe ?? '').sort()).toEqual(['cron:gone:* * * * *', CRON_KEY, 'cron:welcome:0 3 * * *'])
		await newer.wake()
		expect((await wakes()).map((wake) => wake.dedupe)).toEqual([CRON_KEY])
		expect(runsOf(newer, older)).toBe(0)
	})

	test('a later deploy takes the schedule over, and the earlier one never takes it back', async () => {
		const older = start(OLDER)
		const newer = start(NEWER)
		await older.wake()
		expect(await storedGeneration()).toBe(OLDER)
		await newer.wake()
		expect(await storedGeneration()).toBe(NEWER)
		await older.wake()
		expect(await storedGeneration()).toBe(NEWER)
	})

	test('stopping the process aborts a scheduled run, which keeps its wake for the next process', async () => {
		await awayFromMinuteEdge(url)
		const stopping = start(NEWER)
		await stopping.wake()
		await overdue()
		const held = gate()
		stopping.world.holdStart = held
		await stopping.wake()
		await held.reached
		// The stop comes first, so the attempt sees it before the handler goes on.
		stopping.app.stopKicks()
		held.open()
		await quietly(() => stopping.settled())
		expect(await leaseOf()).toMatchObject({ holder: null })
		const [kept, ...rest] = await wakes()
		expect(rest).toEqual([])
		expect(kept).toMatchObject({ reason: 'cron', dedupe: CRON_KEY, owned: false })
		expect(kept?.due).toBeLessThan(await databaseNow())

		const next = start(NEWER)
		await next.wake()
		await next.settled()
		expect(runsOf(next)).toBe(1)
		expect((await wakes())[0]?.due).toBeGreaterThan(await databaseNow())
	})
})
