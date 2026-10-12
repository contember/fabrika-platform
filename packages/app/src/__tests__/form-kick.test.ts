// Forms that kick their job (WU15b) through `boot`'s real pipeline, on a REAL Postgres: an accepted submission starts a
// run of the job in the background, under the job's own key, without waiting for cron; kicks coalesce on the job's lease
// (at most one run and one pending); a kicked run that dies before its commit leaves the row for the next scheduled
// run; and the answer is the one a form without `then` gives. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import type { ContractApp, OperationsReport, WorkloadTokenSource } from '@fabrika/app/implement'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { compileContract } from '../contract'
import type { RequestExecutionContext } from '../fetch'
import { testKit } from '../testing'
import { delayedDatabase, type StatementHook } from './fixtures/form-kick/delayed-database'
import { contract } from './fixtures/form-kick/fabrika.contract'
import { migration } from './fixtures/form-kick/migration'
import { signupApp } from './fixtures/form-kick/src/app'
import { tables } from './fixtures/form-kick/src/db/tables'
import type { SignupWorld } from './fixtures/form-kick/src/world'
import { bootApp, environment, frameworkEnvFor, ORIGIN, workloadKey, workloadTokensFor } from './fixtures/implement/harness'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`form-kick.test.ts skipped: set ${URL_VAR} to run it (the job's lease and the inboxes live in @fabrika/db)`)
}

const schema = applicationSchema(`kick-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
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
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.signups, ${schema}.applications, ${schema}.notices; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_job_kicks; delete from ${schema}.fabrika_form_admissions; delete from ${schema}.fabrika_form_challenges`,
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
	wait(): Promise<void>
}

function gate(): Gate {
	const reached = Promise.withResolvers<void>()
	const opened = Promise.withResolvers<void>()
	return {
		reached: reached.promise,
		open: () => opened.resolve(),
		wait: async () => {
			reached.resolve()
			await opened.promise
		},
	}
}

/** Every run of the job, what it welcomed, and the one run a test holds before it reads or before it commits. */
class World implements SignupWorld {
	readonly runs: { readonly principal: string; readonly runId: string }[] = []
	readonly welcomedEmails: string[] = []
	holdStart: Gate | null = null
	holdTaken: Gate | null = null
	/** Fail the next run after its hold before it reads, as a handler error does. */
	failNext = false

	async started(run: { readonly principal: string; readonly runId: string }): Promise<void> {
		this.runs.push(run)
		const hold = this.holdStart
		this.holdStart = null
		await hold?.wait()
		if (this.failNext) {
			this.failNext = false
			throw new Error('the run failed')
		}
	}

	async taken(): Promise<void> {
		const hold = this.holdTaken
		this.holdTaken = null
		await hold?.wait()
	}

	welcomed(emails: readonly string[]): void {
		this.welcomedEmails.push(...emails)
	}
}

interface Answer {
	readonly status: number
	readonly headers: readonly [string, string][]
	readonly body: unknown
}

interface Running {
	readonly app: ContractApp
	readonly world: World
	/** The keys the application exchanged for a token: only workload keys, never a request's credential. */
	readonly exchanged: string[]
	readonly reports: OperationsReport[]
	submit(path: '/signup' | '/apply' | '/notify', body: unknown): Promise<Answer>
	/** Resolves once every kick the submissions started has ended. */
	settled(): Promise<void>
	/** Resolves once every kick but the `running` ones a test holds has ended. */
	kicksEnded(running: number): Promise<void>
}

/** An instance of the application over the shared schema, on a pool of `max` connections or one that `hook` delays. */
function start(options: { readonly max?: number; readonly hook?: StatementHook } = {}): Running {
	const world = new World()
	const { implementation, variables } = signupApp(world)
	const connection = options.hook === undefined
		? Database.postgres({ url, schema, max: options.max ?? 4 })
		: delayedDatabase(url, schema, options.hook)
	opened.push(connection)
	const exchanged: string[] = []
	const tokens = workloadTokensFor(implementation)
	const recording: WorkloadTokenSource = {
		exchange: (input) => {
			exchanged.push(input.key)
			return tokens.exchange(input)
		},
	}
	const app = bootApp(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), ...variables, TURNSTILE_SECRET: 'turnstile-secret-1' }),
		workloadTokens: recording,
		database: connection,
		challengeFetch: () => Promise.resolve(Response.json({ success: false, 'error-codes': ['invalid-input-response'] })),
	})
	const background = new Set<Promise<unknown>>()
	let ended = 0
	let started = 0
	const exec: RequestExecutionContext = {
		waitUntil: (promise) => {
			started++
			background.add(promise.finally(() => ended++))
		},
	}
	const reports: OperationsReport[] = []
	return {
		app,
		world,
		exchanged,
		reports,
		async submit(path, body) {
			const request = new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
			const response = await app.fetch(request, exec)
			return { status: response.status, headers: [...response.headers], body: JSON.parse(await response.text()) }
		},
		kicksEnded: (running) => until(() => started - ended <= running, 2_000),
		async settled() {
			while (background.size > 0) {
				const pending = [...background]
				background.clear()
				await Promise.all(pending)
			}
		},
	}
}

const RECEIVED = { result: { received: true } }

function quietly<T>(work: () => Promise<T>): Promise<T> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	return work().finally(() => log.mockRestore())
}

/** `work` within `ms`, or the test fails: a kick that waited on a lock would hold it past that. */
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
			`select holder, coalesce(k.pending, false) as pending from ${schema}.fabrika_job_leases l left join ${schema}.fabrika_job_kicks k using (job) where job = 'welcome'`,
		)
	)
	return row
}

const runsOf = (...instances: readonly Running[]): number => instances.reduce((sum, instance) => sum + instance.world.runs.length, 0)

/** The transactions still open on the inbox: a killed process's, until Postgres notices the connection is gone. */
async function openTransactions(): Promise<number> {
	const [row] = await admin((sql) =>
		sql.unsafe(`select count(*)::int as n from pg_stat_activity where state like 'idle in transaction%' and query ilike '%delete from signups%'`)
	)
	return Number(row?.n)
}

/** The lines `stream` prints, up to and including `last`. */
async function linesUntil(stream: ReadableStream<Uint8Array>, last: string): Promise<string[]> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ''
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		text += decoder.decode(read.value, { stream: true })
		const lines = text.split('\n').filter((line) => line !== '')
		if (lines.includes(last)) return lines
	}
	return text.split('\n').filter((line) => line !== '')
}

async function inbox(): Promise<string[]> {
	const rows: { readonly email: string }[] = await admin((sql) => sql.unsafe(`select email from ${schema}.signups order by email`))
	return rows.map((row) => row.email)
}

describe('a form with then in the artifact', () => {
	test('names its job, and a form without then carries none, so its artifact and digest stay what they were', () => {
		const artifact = compileContract(contract, tables)
		expect(artifact.mounts['signup']).toMatchObject({ kind: 'form', then: 'welcome' })
		expect(artifact.mounts['apply']).toMatchObject({ kind: 'form', then: 'welcome' })
		expect(artifact.mounts['notify']).toEqual({ kind: 'form', path: '/notify', appendTo: 'notices' })
	})
})

describe.skipIf(!hasPostgres)('a form with then kicks its job', () => {
	test('a submission is welcomed within a second, by a run under the job’s own key, without waiting for cron', async () => {
		const running = start()
		const sent = performance.now()
		expect((await running.submit('/signup', { email: 'ada@example.test' })).body).toEqual(RECEIVED)
		await until(() => running.world.welcomedEmails.includes('ada@example.test'), 1_000)
		expect(performance.now() - sent).toBeLessThan(1_000)
		await running.settled()
		expect(running.world.runs.map((run) => run.principal)).toEqual(['job:welcome'])
		expect(new Set(running.exchanged)).toEqual(new Set([workloadKey('job', 'welcome')]))
		expect(await inbox()).toEqual([])
	})

	test('the answer is the one a form without then gives, and it does not wait for the run', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		const kicking = await running.submit('/signup', { email: 'bo@example.test' })
		await held.reached
		// The run is held before it reads, and the visitor already has the answer.
		expect(running.world.welcomedEmails).toEqual([])
		expect(kicking).toEqual(await running.submit('/notify', { email: 'bo@example.test' }))
		expect(kicking).toMatchObject({ status: 200, body: RECEIVED })
		held.open()
		await running.settled()
		expect(running.world.welcomedEmails).toEqual(['bo@example.test'])
	})

	test('50 concurrent submissions make at most two runs, and each visitor is welcomed once', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		const emails = Array.from({ length: 50 }, (_, index) => `visitor-${String(index).padStart(2, '0')}@example.test`)
		const answers = await Promise.all(emails.map((email) => running.submit('/signup', { email })))
		expect(answers.every((answer) => answer.status === 200)).toBe(true)
		await held.reached
		// Every kick but the one whose run is held left the flag while that run held the lease.
		await running.kicksEnded(1)
		held.open()
		await running.settled()
		expect(running.world.runs.length).toBeLessThanOrEqual(2)
		expect([...running.world.welcomedEmails].sort()).toEqual(emails)
	})

	test('a kick while a scheduled run holds the lease leaves it pending, and that run runs the job once more', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		const scheduled = running.app.jobs.run('welcome')
		await held.reached
		await running.submit('/signup', { email: 'cy@example.test' })
		// The kick found the lease held: it asked the holder for one more run and ended.
		await running.settled()
		expect(await leaseOf()).toMatchObject({ holder: expect.any(String), pending: true })
		expect(running.world.runs).toHaveLength(1)
		held.open()
		expect(await scheduled).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.runs).toHaveLength(2)
		expect(running.world.welcomedEmails).toEqual(['cy@example.test'])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
	})

	test('kicks wait for no lock: while a run writes, they end at once and an unrelated form still answers promptly', async () => {
		// Two connections: one is the scheduled run's open transaction, which holds the lease row as its fence.
		const running = start({ max: 2 })
		const held = gate()
		running.world.holdTaken = held
		const scheduled = quietly(() => running.app.jobs.run('welcome'))
		await held.reached
		const emails = ['e1@example.test', 'e2@example.test', 'e3@example.test', 'e4@example.test', 'e5@example.test']
		for (const email of emails) {
			expect((await running.submit('/signup', { email })).body).toEqual(RECEIVED)
		}
		const begun = performance.now()
		expect((await running.submit('/notify', { email: 'other@example.test' })).body).toEqual(RECEIVED)
		expect(performance.now() - begun).toBeLessThan(250)
		// Every kick ended while the run still holds its transaction open: each one left the shared flag.
		await inTime(1_000, running.settled())
		expect(await leaseOf()).toMatchObject({ holder: expect.any(String), pending: true })
		held.open()
		expect(await scheduled).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.runs).toHaveLength(2)
		expect([...running.world.welcomedEmails].sort()).toEqual(emails)
	})

	test('two instances share one pending run: at most one running and one pending across them', async () => {
		const first = start()
		const second = start()
		const held = gate()
		first.world.holdStart = held
		await first.submit('/signup', { email: 'g1@example.test' })
		await held.reached
		await first.submit('/signup', { email: 'g2@example.test' })
		await second.submit('/signup', { email: 'g3@example.test' })
		await second.settled()
		held.open()
		await first.settled()
		expect(runsOf(first, second)).toBe(2)
		expect([...first.world.welcomedEmails, ...second.world.welcomedEmails].sort()).toEqual(['g1@example.test', 'g2@example.test', 'g3@example.test'])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
	})

	test('after a failed run a kick that arrived during it waits for the schedule, which then takes the rows', async () => {
		const running = start()
		const held = gate()
		running.world.holdStart = held
		running.world.failNext = true
		await running.submit('/signup', { email: 'h1@example.test' })
		await held.reached
		await running.submit('/signup', { email: 'h2@example.test' })
		await running.kicksEnded(1)
		held.open()
		await quietly(() => running.settled())
		// `retries: 0`: the run failed once, and nothing started another.
		expect(running.world.runs).toHaveLength(1)
		expect(await leaseOf()).toEqual({ holder: null, pending: true })
		expect(await inbox()).toEqual(['h1@example.test', 'h2@example.test'])
		expect(await running.app.jobs.run('welcome')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.runs).toHaveLength(2)
		expect([...running.world.welcomedEmails].sort()).toEqual(['h1@example.test', 'h2@example.test'])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
	})

	test('a run that took a kick after it finished hands it back to a newer run that already read its batch', async () => {
		const finished = gate()
		let held = false
		const first = start({
			hook: async (query) => {
				if (!held && query.sql.startsWith('update fabrika_job_leases set holder = null, last_finished_at')) {
					held = true
					await finished.wait()
				}
			},
		})
		const second = start()
		await first.submit('/signup', { email: 'i1@example.test' })
		// The first run released its lease and has not yet read the flag.
		await finished.reached
		const read = gate()
		second.world.holdTaken = read
		const scheduled = quietly(() => second.app.jobs.run('welcome'))
		await read.reached
		await second.submit('/signup', { email: 'i2@example.test' })
		await second.settled()
		finished.open()
		await first.settled()
		read.open()
		expect(await scheduled).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await inbox()).toEqual([])
		expect([...first.world.welcomedEmails, ...second.world.welcomedEmails].sort()).toEqual(['i1@example.test', 'i2@example.test'])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
	})

	test('a kick after a run’s last pending check, before that run ends, still runs the job', async () => {
		const lastCheck = gate()
		let checks = 0
		const running = start({
			hook: async (query) => {
				if (query.sql.startsWith('update fabrika_job_kicks set pending = false') && ++checks === 2) {
					await lastCheck.wait()
				}
			},
		})
		await running.submit('/signup', { email: 'j1@example.test' })
		await lastCheck.reached
		await running.submit('/signup', { email: 'j2@example.test' })
		lastCheck.open()
		await running.settled()
		expect(await inbox()).toEqual([])
		expect([...running.world.welcomedEmails].sort()).toEqual(['j1@example.test', 'j2@example.test'])
		expect(await leaseOf()).toEqual({ holder: null, pending: false })
	})

	test('a kicked run killed before its commit leaves the row for the next scheduled run', async () => {
		const child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'form-kick', 'killed-kick.ts'), schema], { stdout: 'pipe', stderr: 'ignore' })
		expect(await linesUntil(child.stdout, 'taken')).toEqual(['answer: 200', 'taken'])
		// The process dies inside the kicked run's transaction: Postgres rolls it back, and the lease is left to expire.
		child.kill('SIGKILL')
		await child.exited
		await until(async () => (await openTransactions()) === 0, 5_000)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set expires_at = now() - interval '1 second' where job = 'welcome'`))
		expect(await inbox()).toEqual(['di@example.test'])
		const running = start()
		const reporter = { report: (report: OperationsReport) => Promise.resolve(void running.reports.push(report)) }
		expect(await quietly(() => running.app.jobs.run('welcome', { reporter }))).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.reports.map((report) => report.tags['code'])).toEqual(['crashed'])
		expect(running.world.welcomedEmails).toEqual(['di@example.test'])
		expect(await inbox()).toEqual([])
	})

	test("the test kit's runJob waits for the runs a submission kicked, so it never races them", async () => {
		const world = new World()
		const { implementation, variables } = signupApp(world)
		const connection = Database.postgres({ url, schema, max: 4 })
		opened.push(connection)
		const kit = testKit(implementation, { database: connection, env: { ...variables, TURNSTILE_SECRET: 'turnstile-secret-1' } })
		const answer = await kit.fetch('/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'fy@example.test' }),
		})
		expect(answer.status).toBe(200)
		expect(await kit.runJob('welcome')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(world.runs).toHaveLength(2)
		expect(world.welcomedEmails).toEqual(['fy@example.test'])
	})

	test('a refused input, a filled honeypot, a failed challenge and a rate-limited request kick nothing', async () => {
		const running = start()
		expect((await running.submit('/signup', { email: 'not an address' })).status).toBe(400)
		expect((await running.submit('/signup', { email: 'bot@example.test', website: 'https://spam.example' })).body).toEqual(RECEIVED)
		expect((await running.submit('/apply', { email: 'eve@example.test', challengeToken: 'forged-1' })).status).toBe(400)
		expect((await running.submit('/apply', { email: 'eve@example.test', challengeToken: 'forged-2' })).status).toBe(400)
		expect((await running.submit('/apply', { email: 'eve@example.test', challengeToken: 'forged-3' })).status).toBe(429)
		await running.settled()
		expect(running.world.runs).toEqual([])
		expect(await leaseOf()).toBeUndefined()
	})
})
