// Mutations that kick their job through `boot`'s real pipeline, on a REAL Postgres: a mutation's `ctx.kick` starts a run
// of the job in the background once the mutation's transaction committed, under the job's own key; a refused request kicks
// nothing; a process that stops aborts its kicked runs and frees their lease for the schedule. Every kick is also a
// durable wake written in the mutation's transaction, and `ctx.kick(job, { at })` only that, which the wake timer runs.
// Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { boot, type ContractApp, type WorkloadTokenSource } from '@fabrika/app/implement'
import { ENDPOINT_HEADER, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { applicationSchema, Database } from '@fabrika/db'
import { QueryRefusedError, type Session } from '@fabrika/db/framework'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { WakeTimer } from '../bun'
import { compileContract, ContractError } from '../contract'
import type { RequestExecutionContext } from '../fetch'
import { CapabilityRefusedError } from '../implement/capability'
import { kickRecorder } from '../implement/invocation'
import { testKit } from '../testing'
import {
	endpointHeaderFor,
	environment,
	frameworkEnvFor,
	grant,
	keySource,
	ORIGIN,
	token,
	workloadKey,
	workloadTokensFor,
} from './fixtures/implement/harness'
import { contract } from './fixtures/mutation-kick/fabrika.contract'
import { migration } from './fixtures/mutation-kick/migration'
import { outboxApp } from './fixtures/mutation-kick/src/app'
import { app as outboxKit } from './fixtures/mutation-kick/src/app-kit'
import { tables } from './fixtures/mutation-kick/src/db/tables'
import type { OutboxWorld } from './fixtures/mutation-kick/src/world'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`mutation-kick.test.ts skipped: set ${URL_VAR} to run it (the job's lease and the outbox live in @fabrika/db)`)
}

const schema = applicationSchema(`mkick-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
/** The advisory lock an outbox insert's COMMIT waits for: a test that holds it holds that COMMIT. */
const COMMIT_LOCK = 7_310_221
/** A message whose insert the database refuses at COMMIT. */
const REFUSED_AT_COMMIT = 'refused at commit'
const opened: Database[] = []

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
	// A deferred trigger runs at COMMIT: the advisory lock it takes holds that COMMIT, and its exception fails it.
	const commitHold = `
create function hold_commit() returns trigger language plpgsql as $$ begin
	if new.body = '${REFUSED_AT_COMMIT}' then raise exception 'refused at commit'; end if;
	perform pg_advisory_xact_lock(${COMMIT_LOCK});
	return null;
end $$;
create constraint trigger outbox_commit after insert on outbox deferrable initially deferred for each row execute function hold_commit();
`
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration} ${commitHold}`))
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.outbox; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_job_kicks; delete from ${schema}.fabrika_wakes`,
		)
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

/** A point a test holds a run at, and the signal that the run got there. */
interface Gate {
	readonly reached: Promise<void>
	open(): void
	wait(signal: AbortSignal): Promise<void>
}

function gate(): Gate {
	const reached = Promise.withResolvers<void>()
	const opened = Promise.withResolvers<void>()
	return {
		reached: reached.promise,
		open: () => opened.resolve(),
		wait: async (signal) => {
			reached.resolve()
			const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
			await Promise.race([opened.promise, aborted])
		},
	}
}

/** Every run of the job, what it delivered, and the one run a test holds before it reads. */
class World implements OutboxWorld {
	readonly runs: { readonly principal: string; readonly runId: string }[] = []
	readonly deliveredBodies: string[] = []
	/** The runs whose signal aborted while they were held. */
	aborted = 0
	holdStart: Gate | null = null
	/** Fail the next run after its hold, as a handler error does. */
	failNext = false

	async started(run: { readonly principal: string; readonly runId: string; readonly signal: AbortSignal }): Promise<void> {
		this.runs.push({ principal: run.principal, runId: run.runId })
		const hold = this.holdStart
		this.holdStart = null
		await hold?.wait(run.signal)
		if (run.signal.aborted) {
			this.aborted++
			throw new Error('the run was stopped')
		}
		if (this.failNext) {
			this.failNext = false
			throw new Error('the run failed')
		}
	}

	delivered(bodies: readonly string[]): void {
		this.deliveredBodies.push(...bodies)
	}
}

interface Answer {
	readonly status: number
	readonly body: unknown
}

interface Running {
	readonly app: ContractApp
	readonly world: World
	/** The keys the application exchanged for a token: only workload keys, never a request's credential. */
	readonly exchanged: string[]
	/** Holds the next exchange of a workload key until the test opens it. */
	holdExchange: Gate | null
	call(
		path: '/api/outbox.enqueue' | '/api/outbox.refuse' | '/api/outbox.post' | '/api/outbox.remind' | '/api/outbox.peek',
		body: unknown,
	): Promise<Answer>
	/** The wake timer's step, once: kicks each job whose wake is due; answers the delay to the next wake. */
	wake(): Promise<number | null>
	/** Resolves once every kick the requests and `wake` started has ended. */
	settled(): Promise<void>
}

/**
 * An instance of the application over the shared schema, booted as the proxy fronts it; `projectWakes` is the runtime's
 * projection of every wake and lease change.
 */
function start(
	options: { readonly projectWakes?: (transaction: Session) => Promise<void>; readonly kickRuns?: 'inline' | 'scheduler' } = {},
): Running {
	const world = new World()
	const { implementation, variables } = outboxApp(world)
	const connection = openPostgres({ url, schema, max: 4 })
	opened.push(connection)
	const exchanged: string[] = []
	const tokens = workloadTokensFor(implementation)
	const recording: WorkloadTokenSource = {
		exchange: async (input) => {
			exchanged.push(input.key)
			const hold = running.holdExchange
			running.holdExchange = null
			await hold?.wait(new AbortController().signal)
			return tokens.exchange(input)
		},
	}
	const app = boot(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), ...variables }),
		iam: keySource,
		workloadTokens: recording,
		database: connection,
		...(options.projectWakes === undefined ? {} : { projectWakes: options.projectWakes }),
		...(options.kickRuns === undefined ? {} : { kickRuns: options.kickRuns }),
	})
	const background = new Set<Promise<unknown>>()
	const exec: RequestExecutionContext = {
		waitUntil: (promise) => {
			background.add(promise)
		},
	}
	const staff = token('user', [grant('outbox.read'), grant('outbox.write')])
	const running: Running = {
		app,
		world,
		exchanged,
		holdExchange: null,
		async call(path, body) {
			const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', [PROXY_TOKEN_HEADER]: await staff })
			const endpoint = endpointHeaderFor(implementation, 'POST', path)
			if (endpoint !== null) headers.set(ENDPOINT_HEADER, endpoint)
			const response = await app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), exec)
			return { status: response.status, body: JSON.parse(await response.text()) }
		},
		wake: () => app.jobs.wake((kick) => void background.add(kick)),
		async settled() {
			while (background.size > 0) {
				const pending = [...background]
				background.clear()
				await Promise.all(pending)
			}
		},
	}
	return running
}

function quietly<T>(work: () => Promise<T>): Promise<T> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	return work().finally(() => log.mockRestore())
}

/** `work` within `ms`, or the test fails. */
function inTime<T>(ms: number, work: Promise<T>): Promise<T> {
	return Promise.race([
		work,
		Bun.sleep(ms).then((): never => {
			throw new Error(`still waiting after ${ms} ms`)
		}),
	])
}

async function until(condition: () => boolean | Promise<boolean>, ms: number): Promise<void> {
	const deadline = performance.now() + ms
	while (!(await condition())) {
		if (performance.now() > deadline) throw new Error(`still waiting after ${ms} ms`)
		await Bun.sleep(5)
	}
}

async function leaseOf(): Promise<{ readonly holder: string | null; readonly pending: boolean } | undefined> {
	const [row] = await admin((sql) =>
		sql.unsafe(
			`select holder, coalesce(k.pending, false) as pending from ${schema}.fabrika_job_leases l left join ${schema}.fabrika_job_kicks k using (job) where job = 'deliver'`,
		)
	)
	return row
}

interface WakeRow {
	readonly reason: string
	readonly due_at: number
	readonly dedupe: string | null
}

async function wakes(): Promise<WakeRow[]> {
	const rows: { readonly reason: string; readonly due_at: string; readonly dedupe: string | null }[] = await admin((sql) =>
		sql.unsafe(`select reason, due_at::text, dedupe from ${schema}.fabrika_wakes where job = 'deliver' order by due_at, id`)
	)
	return rows.map((row) => ({ ...row, due_at: Number(row.due_at) }))
}

const kickKey = (at: number): string => `kick:deliver:${Math.floor(at / 1_000)}`

/** The database's clock, in epoch milliseconds. */
async function databaseNow(): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now`))
	return Number(row?.now)
}

async function outbox(): Promise<string[]> {
	const rows: { readonly body: string }[] = await admin((sql) => sql.unsafe(`select body from ${schema}.outbox order by body`))
	return rows.map((row) => row.body)
}

/** Whether a connection waits for `COMMIT_LOCK`: an outbox insert's COMMIT the test holds. */
async function commitWaiting(): Promise<boolean> {
	const [row] = await admin((sql) =>
		sql.unsafe(`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${COMMIT_LOCK} and not granted`)
	)
	return Number(row?.n) > 0
}

describe('a mutation with kicks in the artifact', () => {
	test('kicks names the jobs a site may kick, under the endpoint and under the job; a site without kicks carries none', () => {
		const declared = compileContract(contract, tables).declared ?? {}
		expect(declared['api.outbox.enqueue']?.kicks).toEqual(['deliver'])
		expect(declared['api.outbox.post']?.kicks).toEqual(['deliver'])
		expect(declared['api.outbox.peek']).toEqual({ sql: 'read', unscoped: {}, connect: [], issues: null })
		expect(declared['job:sweep']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, kicks: ['deliver'] })
	})
})

function problemsOf(build: () => unknown): readonly string[] {
	try {
		build()
	} catch (error) {
		if (error instanceof ContractError) return error.problems
		throw error
	}
	return []
}

describe('the kick edges a contract declares', () => {
	const options = { actions: ['outbox.read'] } as const

	test('a kick names a cron job of the contract', () => {
		const sweep = outboxKit.cron('0 * * * *', { ...options, kicks: ['delivr'] }).handle(() => {})
		const contract = outboxKit.contract(() => ({ jobs: { sweep } }))
		expect(problemsOf(() => compileContract(contract, tables))).toEqual([
			"job 'sweep': kicks 'delivr' is not a job of the contract (jobs: sweep)",
		])
	})

	test('the edges between jobs are acyclic', () => {
		const a = outboxKit.cron('0 * * * *', { ...options, kicks: ['b'] }).handle(() => {})
		const b = outboxKit.cron('0 * * * *', { ...options, kicks: ['c'] }).handle(() => {})
		const c = outboxKit.cron('0 * * * *', { ...options, kicks: ['a'] }).handle(() => {})
		const d = outboxKit.cron('0 * * * *', { ...options, kicks: ['a'] }).handle(() => {})
		const contract = outboxKit.contract(() => ({ jobs: { a, b, c, d } }))
		expect(problemsOf(() => compileContract(contract, tables))).toEqual(["job 'a': kicks itself around the cycle a → b → c → a"])
	})
})

describe.skipIf(!hasPostgres)('a site with kicks kicks a job when its handler asks', () => {
	test('ctx.kick starts a run after the commit; a declared kick the handler does not send starts none', async () => {
		const running = start()
		expect((await running.call('/api/outbox.post', { body: 'later' })).status).toBe(200)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect((await running.call('/api/outbox.post', { body: 'now' })).status).toBe(200)
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect([...running.world.deliveredBodies].sort()).toEqual(['later', 'now'])
	})

	test('a kick the handler sent before it threw is dropped with its transaction', async () => {
		const running = start()
		expect((await running.call('/api/outbox.post', { body: 'refused' })).status).toBe(409)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await leaseOf()).toBeUndefined()
	})

	test("a job's kick starts the kicked job once its own run succeeded", async () => {
		const running = start()
		expect((await running.call('/api/outbox.post', { body: 'later too' })).status).toBe(200)
		expect(await running.app.jobs.run('sweep')).toEqual({ status: 'succeeded', attempts: 1 })
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect(running.world.deliveredBodies).toEqual(['later too'])
	})
})

describe.skipIf(!hasPostgres)('a mutation that kicks its job', () => {
	test('a queued message is delivered within a second, by a run under the job’s own key, without waiting for cron', async () => {
		const running = start()
		const sent = performance.now()
		expect((await running.call('/api/outbox.enqueue', { body: 'ada' })).status).toBe(200)
		await until(() => running.world.deliveredBodies.includes('ada'), 1_000)
		expect(performance.now() - sent).toBeLessThan(1_000)
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect(new Set(running.exchanged)).toEqual(new Set([workloadKey('job', 'deliver')]))
		expect(await outbox()).toEqual([])
	})

	test('the run starts only after the mutation’s transaction committed', async () => {
		const running = start()
		const holder = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			await holder.unsafe(`select pg_advisory_lock(${COMMIT_LOCK})`)
			const answer = running.call('/api/outbox.enqueue', { body: 'bo' })
			await until(commitWaiting, 2_000)
			await Bun.sleep(200)
			// The handler returned and its COMMIT waits: nothing has started a run.
			expect(running.world.runs).toEqual([])
			await holder.unsafe(`select pg_advisory_unlock(${COMMIT_LOCK})`)
			expect((await answer).status).toBe(200)
		} finally {
			await holder.close()
		}
		await running.settled()
		expect(running.world.runs).toHaveLength(1)
		expect(running.world.deliveredBodies).toEqual(['bo'])
	})

	test('a refused request kicks nothing: a handler that throws, an input that is refused', async () => {
		const running = start()
		expect((await running.call('/api/outbox.refuse', { body: 'cy' })).status).toBe(409)
		expect((await running.call('/api/outbox.enqueue', { body: '' })).status).toBe(400)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await outbox()).toEqual([])
		expect(await leaseOf()).toBeUndefined()
	})

	test('a COMMIT the database refuses answers 500 and kicks nothing', async () => {
		const running = start()
		expect((await quietly(() => running.call('/api/outbox.enqueue', { body: REFUSED_AT_COMMIT }))).status).toBe(500)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await outbox()).toEqual([])
		expect(await leaseOf()).toBeUndefined()
	})

	test('a query answers without a kick', async () => {
		const running = start()
		expect(await running.call('/api/outbox.peek', {})).toEqual({ status: 200, body: { result: { waiting: 0 } } })
		await running.settled()
		expect(running.world.runs).toEqual([])
	})

	test('stopKicks ends a held kicked run at once, reports nothing and frees the lease for the schedule', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		expect((await running.call('/api/outbox.enqueue', { body: 'di' })).status).toBe(200)
		await held.reached
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			running.app.stopKicks()
			await inTime(1_000, running.settled())
			expect(log.mock.calls.map(([line]) => line)).toEqual([
				"fabrika: job 'deliver' stopped: the process is shutting down; its schedule runs it again",
			])
		} finally {
			log.mockRestore()
		}
		expect(running.world.aborted).toBe(1)
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
		// A kick after the stop starts no run; it leaves the flag for a process that is not stopping.
		expect((await running.call('/api/outbox.enqueue', { body: 'ed' })).status).toBe(200)
		await running.settled()
		expect(running.world.runs).toHaveLength(1)
		expect(await leaseOf()).toEqual({ holder: null, pending: true })
		expect(await outbox()).toEqual(['di', 'ed'])
		expect(await quietly(() => running.app.jobs.run('deliver'))).toEqual({ status: 'succeeded', attempts: 1 })
		expect([...running.world.deliveredBodies].sort()).toEqual(['di', 'ed'])
		expect(await outbox()).toEqual([])
	})

	test('stopKicks during the wait before a retry ends the run as stopped, with no further attempt', async () => {
		const running = start()
		running.world.failNext = true
		const log = spyOn(console, 'error').mockImplementation(() => {})
		const lines = () => log.mock.calls.map(([line]) => line)
		try {
			expect((await running.call('/api/outbox.enqueue', { body: 'fi' })).status).toBe(200)
			await until(() => lines().length > 0, 2_000)
			running.app.stopKicks()
			// The backoff before attempt 2 is at least 500 ms: the stop ends it.
			await inTime(450, running.settled())
			expect(lines()).toEqual([
				"fabrika: job 'deliver' attempt 1 of 2 failed: handler_failed",
				"fabrika: job 'deliver' stopped: the process is shutting down; its schedule runs it again",
			])
		} finally {
			log.mockRestore()
		}
		expect(running.world.runs).toHaveLength(1)
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
		expect(await outbox()).toEqual(['fi'])
	})

	test('stopKicks while the attempt asks IAM for its token starts no handler', async () => {
		const running = start()
		const exchange = gate()
		running.holdExchange = exchange
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await running.call('/api/outbox.enqueue', { body: 'go' })).status).toBe(200)
			await exchange.reached
			running.app.stopKicks()
			exchange.open()
			await inTime(1_000, running.settled())
			expect(log.mock.calls.map(([line]) => line)).toEqual([
				"fabrika: job 'deliver' stopped: the process is shutting down; its schedule runs it again",
			])
		} finally {
			log.mockRestore()
		}
		expect(running.world.runs).toEqual([])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
		expect(await outbox()).toEqual(['go'])
	})

	test("the test kit's drain waits for the run a mutation kicked", async () => {
		const world = new World()
		const { implementation, variables } = outboxApp(world)
		const connection = openPostgres({ url, schema, max: 4 })
		opened.push(connection)
		const kit = testKit(implementation, { database: connection, env: variables })
		const held = gate()
		world.holdStart = held
		const staff = kit.browser(kit.testCaller([{ action: 'outbox.write' }]))
		const answer = await staff('/api/outbox.enqueue', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ body: 'fy' }),
		})
		expect(answer.status).toBe(200)
		await held.reached
		let drained = false
		const draining = kit.drain().then(() => {
			drained = true
		})
		await Bun.sleep(50)
		expect(drained).toBe(false)
		held.open()
		await draining
		expect(world.runs).toHaveLength(1)
		expect(world.deliveredBodies).toEqual(['fy'])
	})
})

describe('ctx.kick records a job and when it runs, and nothing else', () => {
	test('a declared job, now or at a Date; one wake per job and due second; a payload, a bad time or another job is refused', () => {
		const kicks = kickRecorder("'api.outbox.remind'", ['deliver'])
		const second = Math.floor(Date.now() / 1_000) * 1_000 + 60_000
		kicks.kick('deliver')
		kicks.kick('deliver')
		kicks.kick('deliver', { at: new Date(second + 900) })
		kicks.kick('deliver', { at: new Date(second + 100) })
		kicks.kick('deliver', { at: new Date(second + 1_000) })
		for (const options of [{ at: new Date(second), id: 'm1' }, { at: second }, { at: new Date(Number.NaN) }, 'm1', null, {}]) {
			expect(() => kicks.kick('deliver', options)).toThrow(QueryRefusedError)
		}
		expect(() => kicks.kick('sweep')).toThrow(CapabilityRefusedError)
		expect(kicks.kicked()).toEqual(['deliver'])
		const now = new Date(second - 30_000)
		expect(kicks.wakes(now)).toEqual([
			{ job: 'deliver', reason: 'kick', dueAt: now, dedupe: kickKey(now.getTime()) },
			{ job: 'deliver', reason: 'kick', dueAt: new Date(second + 100), dedupe: kickKey(second) },
			{ job: 'deliver', reason: 'kick', dueAt: new Date(second + 1_000), dedupe: kickKey(second + 1_000) },
		])
	})
})

describe.skipIf(!hasPostgres)('a kick is a durable wake written in the site’s transaction', () => {
	test('a kick’s wake commits with the mutation, and the run it starts after the commit consumes it', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		const before = Date.now()
		expect((await running.call('/api/outbox.enqueue', { body: 'ka' })).status).toBe(200)
		await held.reached
		const [wake, ...more] = await wakes()
		expect(more).toEqual([])
		expect(wake).toEqual({ reason: 'kick', due_at: expect.any(Number), dedupe: kickKey(wake?.due_at ?? 0) })
		expect(wake?.due_at).toBeGreaterThanOrEqual(before)
		expect(wake?.due_at).toBeLessThanOrEqual(Date.now())
		held.open()
		await running.settled()
		expect(running.world.deliveredBodies).toEqual(['ka'])
		expect(await wakes()).toEqual([])
	})

	test('a rolled-back mutation leaves no durable kick: a thrown handler, a refused COMMIT, a refused delayed kick', async () => {
		const running = start()
		expect((await running.call('/api/outbox.refuse', { body: 'kb' })).status).toBe(409)
		expect((await running.call('/api/outbox.remind', { body: 'refused', at: [Date.now() + 3_600_000] })).status).toBe(409)
		expect((await quietly(() => running.call('/api/outbox.enqueue', { body: REFUSED_AT_COMMIT }))).status).toBe(500)
		await running.settled()
		expect(await wakes()).toEqual([])
		expect(await outbox()).toEqual([])
		expect(running.world.runs).toEqual([])
	})

	test('a delayed kick starts nothing after the commit; kicks in one second are one wake, and the run at T1 leaves T2', async () => {
		const running = start()
		// Two kicks inside the second of T1, the earlier one kept, and T2 an hour later.
		const second = (Math.floor(Date.now() / 1_000) + 3_600) * 1_000
		const [t1, t1Later, t2] = [second + 100, second + 700, second + 3_600_000]
		expect((await running.call('/api/outbox.remind', { body: 'kc', at: [t1Later, t2, t1] })).status).toBe(200)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await wakes()).toEqual([
			{ reason: 'kick', due_at: t1, dedupe: kickKey(t1) },
			{ reason: 'kick', due_at: t2, dedupe: kickKey(t2) },
		])
		// Nothing is due yet: the timer kicks nothing and waits for T1.
		expect(await running.wake()).toBeGreaterThan(3_500_000)
		await running.settled()
		expect(running.world.runs).toEqual([])
		// T1 comes due, as time passing would make it.
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_wakes set due_at = due_at - 3700000 where dedupe = '${kickKey(t1)}'`))
		await running.wake()
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect(running.world.deliveredBodies).toEqual(['kc'])
		expect(await wakes()).toEqual([{ reason: 'kick', due_at: t2, dedupe: kickKey(t2) }])
		const next = await running.wake()
		expect(next).toBeGreaterThan(t2 - Date.now() - 5_000)
		expect(next).toBeLessThanOrEqual(t2 - Date.now() + 5_000)
	})

	test("kickRuns 'scheduler': a request's kick only writes its wake, which the projection sees; no run starts in its runtime", async () => {
		const projected: (number | null)[] = []
		const running: Running = start({
			kickRuns: 'scheduler',
			projectWakes: async (transaction) => {
				projected.push(await running.app.jobs.scheduler?.untilNext(transaction) ?? null)
			},
		})
		expect((await running.call('/api/outbox.enqueue', { body: 'ks' })).status).toBe(200)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await wakes()).toEqual([expect.objectContaining({ reason: 'kick' })])
		expect(await leaseOf()).toBeUndefined()
		// The wake was projected in the mutation's transaction, due now.
		expect(projected.length).toBeGreaterThan(0)
		expect(Math.max(0, Math.min(...projected.map((delay) => delay ?? Number.POSITIVE_INFINITY)))).toBe(0)
		// The scheduler (the job object's alarm on Cloudflare) runs it, as any other wake.
		const scheduler = running.app.jobs.scheduler
		if (scheduler === null) throw new Error('no scheduler')
		const taken = await scheduler.take('deliver')
		if (taken.fence === null) throw new Error('nothing taken')
		expect(await scheduler.run('deliver', taken.fence)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.deliveredBodies).toEqual(['ks'])
		// The run consumed the kick; a scheduled run leaves its job's next cron wake.
		expect((await wakes()).map((wake) => wake.reason)).toEqual(['cron'])
	})

	test('a crash between the commit and the kick’s start leaves the wake, and the wake timer runs the job', async () => {
		const running = start()
		// The process stops before the post-commit start reaches the lease: the kick only leaves the shared flag.
		running.app.stopKicks()
		expect((await running.call('/api/outbox.enqueue', { body: 'kd' })).status).toBe(200)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await wakes()).toEqual([expect.objectContaining({ reason: 'kick' })])
		const next = start()
		expect(await next.wake()).not.toBeNull()
		await next.settled()
		expect(next.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect(next.world.deliveredBodies).toEqual(['kd'])
		expect(await wakes()).toEqual([])
		expect(await outbox()).toEqual([])
	})

	test("a job's kick is a wake its run writes once it succeeded, consumed by the run it starts", async () => {
		const running = start()
		expect(await running.app.jobs.run('sweep')).toEqual({ status: 'succeeded', attempts: 1 })
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:deliver'])
		expect(await wakes()).toEqual([])
	})

	test('the serving process’s wake timer runs a delayed kick at its time, lowered by the write that recorded it', async () => {
		const kicks: Promise<void>[] = []
		const timer = new WakeTimer((kick) => void kicks.push(kick))
		try {
			const running = start({ projectWakes: timer.project })
			timer.attach(running.app.jobs)
			const at = Date.now() + 400
			expect((await running.call('/api/outbox.remind', { body: 'ke', at: [at] })).status).toBe(200)
			expect(running.world.runs).toEqual([])
			await until(() => running.world.deliveredBodies.includes('ke'), 3_000)
			expect(Date.now()).toBeGreaterThanOrEqual(at)
			expect(running.world.runs).toHaveLength(1)
			await Promise.all(kicks)
			expect(kicks).toHaveLength(1)
			expect(await wakes()).toEqual([])
		} finally {
			await timer.stop()
		}
	})

	test('a delayed kick whose time passed, written while a run holds the lease, is left to the next run', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		expect((await running.call('/api/outbox.enqueue', { body: 'kp1' })).status).toBe(200)
		await held.reached
		// Due an hour before the held run started, but committed after it took the lease: the run never owned it.
		const past = (await databaseNow()) - 3_600_000
		expect((await running.call('/api/outbox.remind', { body: 'kp2', at: [past] })).status).toBe(200)
		held.open()
		await running.settled()
		expect(await wakes()).toEqual([{ reason: 'kick', due_at: past, dedupe: kickKey(past) }])
		await running.wake()
		await running.settled()
		expect(running.world.runs).toHaveLength(2)
		expect(await wakes()).toEqual([])
	})

	test("an application clock an hour ahead: a kick is due by the database's clock, and the run it starts consumes it", async () => {
		setSystemTime(new Date(Date.now() + 3_600_000))
		const running = start()
		const held = gate()
		running.world.holdStart = held
		try {
			const before = await databaseNow()
			expect((await running.call('/api/outbox.enqueue', { body: 'kq' })).status).toBe(200)
			await held.reached
			const [wake] = await wakes()
			expect(wake?.due_at).toBeGreaterThanOrEqual(before)
			expect(wake?.due_at).toBeLessThanOrEqual(await databaseNow())
			held.open()
			await running.settled()
		} finally {
			setSystemTime()
		}
		expect(running.world.deliveredBodies).toEqual(['kq'])
		expect(await wakes()).toEqual([])
	})

	test("an application clock an hour behind: the wake timer waits for a delayed kick by the database's clock", async () => {
		const kicks: Promise<void>[] = []
		const timer = new WakeTimer((kick) => void kicks.push(kick))
		setSystemTime(new Date(Date.now() - 3_600_000))
		try {
			const running = start({ projectWakes: timer.project })
			timer.attach(running.app.jobs)
			const at = (await databaseNow()) + 400
			expect((await running.call('/api/outbox.remind', { body: 'kr', at: [at] })).status).toBe(200)
			await until(() => running.world.deliveredBodies.includes('kr'), 3_000)
			expect(await databaseNow()).toBeGreaterThanOrEqual(at)
			await Promise.all(kicks)
			expect(await wakes()).toEqual([])
		} finally {
			setSystemTime()
			await timer.stop()
		}
	})

	test('the wake timer fired before the write that lowered it committed: it looks again and runs the kick', async () => {
		const kicks: Promise<void>[] = []
		const timer = new WakeTimer((kick) => void kicks.push(kick))
		const lock = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const running = start({ projectWakes: timer.project })
			timer.attach(running.app.jobs)
			await lock.unsafe(`select pg_advisory_lock(${COMMIT_LOCK})`)
			const at = Date.now() + 200
			const call = running.call('/api/outbox.remind', { body: 'ks', at: [at] })
			await until(commitWaiting, 3_000)
			// The timer fires at the kick's time while its COMMIT still waits, and finds nothing.
			await Bun.sleep(Math.max(0, at - Date.now()) + 300)
			expect(running.world.runs).toEqual([])
			await lock.unsafe(`select pg_advisory_unlock(${COMMIT_LOCK})`)
			expect((await call).status).toBe(200)
			await until(() => running.world.deliveredBodies.includes('ks'), 3_000)
			await Promise.all(kicks)
			expect(await wakes()).toEqual([])
		} finally {
			await lock.close()
			await timer.stop()
		}
	})

	test('stopping the wake timer waits for the refresh under way, and nothing it starts comes after', async () => {
		const kicks: Promise<void>[] = []
		const timer = new WakeTimer((kick) => void kicks.push(kick))
		const running = start({ projectWakes: timer.project })
		const jobs = running.app.jobs
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		timer.attach({
			...jobs,
			wake: async (track) => {
				entered.resolve()
				await release.promise
				return jobs.wake(track)
			},
		})
		const due = (await databaseNow()) - 1_000
		await admin((sql) =>
			sql.unsafe(`insert into ${schema}.fabrika_wakes (id, job, due_at, reason) values (gen_random_uuid(), 'deliver', ${due}, 'kick')`)
		)
		const refreshing = timer.refresh()
		await entered.promise
		let stopped = false
		const stopping = Promise.resolve(timer.stop()).then(() => {
			stopped = true
		})
		await Bun.sleep(50)
		expect(stopped).toBe(false)
		release.resolve()
		await stopping
		const started = kicks.length
		expect(started).toBe(1)
		await refreshing
		await timer.refresh()
		await Bun.sleep(50)
		expect(kicks).toHaveLength(started)
		await Promise.all(kicks)
		await running.settled()
	})
})
