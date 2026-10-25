// The environment object's alarm (ADR-0065 §5): armed from the jobs' durable wakes in the transaction of every change,
// it takes a due job's lease and hands the run to waitUntil; a failed run's wakes move to a durable retry; the repair
// tick rebuilds the cron wakes and arms an alarm nothing armed. Each object is constructed directly over bun:sqlite with
// an alarm that commits with the storage transaction it is set in, and that workerd deletes after an alarm that set none.

import { defineApp } from '@fabrika/app/contract'
import { FABRIKA_APPLICATION_OBJECT, FABRIKA_APPLICATION_OBJECTS, type OpsPublishedState, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { applicationMigrations } from '../build'
import { type ApplicationState, type ApplicationStorage, createContractWorker, FabrikaApplication } from '../cloudflare'
import { ALARM_RETRY_MS, ALARM_SLACK_MS, TICK_HEADER } from '../cloudflare/application'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { CLOUDFLARE_MAX_JOB_SEGMENT_MS } from '../contract/defaults'
import { serve } from '../implement'
import type { JobClock } from '../jobs/runner'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'
import { frameworkEnvFor, keepingProcessEnvironment, keySource, ORIGIN, PROXY_SECRET, workloadTokensFor } from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')
const STATE_KEY = '__fabrika/ops/application.json'
const MINUTE = 60_000

const app = defineApp(vocabulary, tables)

/** What the jobs' handlers do; each test sets the ones it holds, and every run is recorded with its attempt. */
const hooks: {
	steady: ((signal: AbortSignal) => Promise<void>) | null
	hourly: (() => Promise<void>) | null
} = { steady: null, hourly: null }
let runs: { readonly job: string; readonly attempt: number }[] = []

const steady = app.cron('0 3 * * *', { actions: ['notes.read'], retries: 2 }).handle(async ({ ctx }) => {
	runs.push({ job: 'steady', attempt: ctx.attempt })
	await hooks.steady?.(ctx.signal)
})

const hourly = app.cron('30 * * * *', { actions: ['notes.read'] }).handle(async ({ ctx }) => {
	runs.push({ job: 'hourly', attempt: ctx.attempt })
	await hooks.hourly?.()
})

const contract = app.contract((c) => ({ health: c.health('/healthz'), jobs: { steady, hourly } }))

/** The object's alarm as workerd keeps it: set inside a storage transaction, it commits or rolls back with it. */
class Alarm {
	scheduled: number | null = null
	/** Every committed set, `null` for a delete. */
	readonly armed: (number | null)[] = []
	/** How many of the next sets or deletes throw. */
	failures = 0
	readonly #open = new AsyncLocalStorage<{ value: number | null | undefined }>()

	set(value: number | null): Promise<void> {
		if (this.failures > 0) {
			this.failures--
			return Promise.reject(new Error('the alarm could not be set'))
		}
		const open = this.#open.getStore()
		if (open === undefined) {
			this.#commit(value)
		} else {
			open.value = value
		}
		return Promise.resolve()
	}

	/** `closure` in a transaction: what it set reaches the enclosing transaction, or the alarm, only when it commits. */
	async within<T>(run: (closure: () => Promise<T>) => Promise<T>, closure: () => Promise<T>): Promise<T> {
		const parent = this.#open.getStore()
		const frame: { value: number | null | undefined } = { value: undefined }
		const result = await run(() => this.#open.run(frame, closure))
		if (frame.value !== undefined) {
			if (parent === undefined) {
				this.#commit(frame.value)
			} else {
				parent.value = frame.value
			}
		}
		return result
	}

	#commit(value: number | null): void {
		this.scheduled = value
		this.armed.push(value)
	}
}

/** The environment's bucket: only the maintenance state, which a test sets. */
function bucketOf(state: { current: OpsPublishedState | null }) {
	const unused = () => Promise.reject(new Error('not called'))
	return {
		head: unused,
		put: unused,
		delete: unused,
		get: (key: string) => {
			if (key !== STATE_KEY) return unused()
			const stored = state.current
			return Promise.resolve(stored === null ? null : { etag: 'v1', text: () => Promise.resolve(JSON.stringify(stored)) })
		},
	}
}

interface Instance {
	readonly object: FabrikaApplication
	/** Fires the alarm as workerd does: an alarm that armed nothing is deleted once it returns. */
	fire(): Promise<void>
	tick(): Promise<Response>
}

interface Started {
	readonly database: BunDatabase
	readonly alarm: Alarm
	readonly maintenance: { current: OpsPublishedState | null }
	/** What every instance handed to `waitUntil`. */
	readonly pending: Promise<unknown>[]
	/** IAM's token exchange for the jobs' keys waits while held; `free` lets later exchanges through and leaves held ones waiting. */
	readonly iam: { hold(): () => void; free(): void }
	readonly instance: Instance
	/** Another instance, in a fresh isolate, over the same database, alarm and bucket, as after an eviction. */
	restart(): Instance
}

async function start(options: { readonly clock?: JobClock } = {}): Promise<Started> {
	const migrations = await applicationMigrations(FIXTURE_ROOT)
	// A fresh isolate: an instance boots the implementation registered when it is constructed, with its own credentials.
	const isolate = () => {
		const implementation = serve(contract, { database: scoped(tables) })
		createContractWorker(() => Promise.resolve({ default: implementation }), {
			migrations,
			...(options.clock === undefined ? {} : { clock: options.clock }),
		})
		return implementation
	}
	const implementation = isolate()
	const database = new BunDatabase(':memory:')
	const alarm = new Alarm()
	const maintenance: { current: OpsPublishedState | null } = { current: null }
	const pending: Promise<unknown>[] = []
	const tokens = workloadTokensFor(implementation)
	let held: Promise<void> = Promise.resolve()
	const iam = {
		hold() {
			const gate = Promise.withResolvers<void>()
			held = gate.promise
			return () => gate.resolve()
		},
		free() {
			held = Promise.resolve()
		},
	}
	const env = {
		...frameworkEnvFor(implementation),
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		[CLOUDFLARE_FILES_BINDING]: bucketOf(maintenance),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application',
		IAM: {
			getJwks: () => keySource.getJwks(),
			mintFromKey: async (input: { app: string; key: string }) => {
				await held
				return await tokens.exchange(input)
			},
		},
	}
	const instanceOf = (): Instance => {
		const inner = bunSqliteStorage(database)
		const storage: ApplicationStorage = {
			sql: inner.sql,
			transactionSync: inner.transactionSync,
			transaction: (closure) => alarm.within((run) => inner.transaction(run), closure),
			getAlarm: () => Promise.resolve(alarm.scheduled),
			setAlarm: (time) => alarm.set(time),
			deleteAlarm: () => alarm.set(null),
		}
		const state: ApplicationState = { storage, blockConcurrencyWhile: (callback) => callback(), waitUntil: (promise) => void pending.push(promise) }
		const object = new FabrikaApplication(state, env)
		return {
			object,
			async fire() {
				const before = alarm.armed.length
				await object.alarm()
				if (alarm.armed.length === before) {
					alarm.scheduled = null
				}
			},
			tick: () =>
				object.fetch(new Request(`${ORIGIN}/`, { method: 'POST', headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, [TICK_HEADER]: String(Date.now()) } })),
		}
	}
	return {
		database,
		alarm,
		maintenance,
		pending,
		iam,
		instance: instanceOf(),
		restart: () => {
			isolate()
			return instanceOf()
		},
	}
}

/** Waits for everything handed to `waitUntil`, and for what that work handed on in turn. */
async function settle(started: Started): Promise<void> {
	while (started.pending.length > 0) {
		await Promise.all(started.pending.splice(0))
	}
}

interface WakeRow {
	readonly job: string
	readonly reason: string
	readonly due_at: number
	readonly attempt: number
	readonly dedupe: string | null
}

function wakesOf(database: BunDatabase, job: string): WakeRow[] {
	return database.query<WakeRow, [string]>('select job, reason, due_at, attempt, dedupe from fabrika_wakes where job = ? order by due_at, id').all(job)
}

function earliestWake(database: BunDatabase): number | null {
	return database.query<{ due: number | null }, []>('select min(due_at) as due from fabrika_wakes').get()?.due ?? null
}

interface LeaseRow {
	readonly holder: string | null
	readonly expires_at: string
	readonly last_status: string | null
}

function leaseOf(database: BunDatabase, job: string): LeaseRow | null {
	return database.query<LeaseRow, [string]>('select holder, expires_at, last_status from fabrika_job_leases where job = ?').get(job)
}

/** Moves every pending wake of `job` to `at` (a second ago by default), as time passing to its due time would. */
function makeDue(database: BunDatabase, job: string, at = Date.now() - 1_000): void {
	database.query('update fabrika_wakes set due_at = ? where job = ?').run(at, job)
}

/** Moves the lease of `job` past its expiry, as time passing would. */
function expireLease(database: BunDatabase, job: string): void {
	database.query("update fabrika_job_leases set expires_at = '2020-01-01T00:00:00.000Z' where job = ?").run(job)
}

function insertKick(database: BunDatabase, job: string, at: number): void {
	database.query("insert into fabrika_wakes (id, job, due_at, reason, attempt, dedupe) values (?, ?, ?, 'kick', 0, null)").run(
		crypto.randomUUID(),
		job,
		at,
	)
}

/** A repaired object: the repair tick has run, so every job has its lease row and its cron wake. */
async function repaired(options: { readonly clock?: JobClock } = {}): Promise<Started> {
	const started = await start(options)
	expect((await started.instance.tick()).status).toBe(204)
	return started
}

let logged: string[] = []
let restoreLog: () => void = () => {}

beforeEach(() => {
	runs = []
	hooks.steady = null
	hooks.hourly = null
	logged = []
	const log = spyOn(console, 'error').mockImplementation((...line: unknown[]) => void logged.push(line.map(String).join(' ')))
	restoreLog = () => log.mockRestore()
})

afterEach(() => {
	restoreLog()
})

const reported = (type: string): string[] => logged.filter((line) => line.startsWith(`fabrika: ${type}: `))

describe('the repair tick', () => {
	test('arms the first alarm of an install nobody has called, at the earliest cron wake; the alarm runs the due job', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await start()
			const { database, alarm, instance } = started
			expect(alarm.scheduled).toBeNull()
			const before = Date.now()
			expect((await instance.tick()).status).toBe(204)
			expect(wakesOf(database, 'steady')).toEqual([
				{ job: 'steady', reason: 'cron', due_at: expect.any(Number), attempt: 0, dedupe: 'cron:steady:0 3 * * *' },
			])
			expect(wakesOf(database, 'hourly')).toEqual([
				{ job: 'hourly', reason: 'cron', due_at: expect.any(Number), attempt: 0, dedupe: 'cron:hourly:30 * * * *' },
			])
			for (const job of ['steady', 'hourly']) {
				const [wake] = wakesOf(database, job)
				expect(wake?.due_at).toBeGreaterThan(before)
				expect(new Date(wake?.due_at ?? 0).getUTCMinutes()).toBe(job === 'steady' ? 0 : 30)
			}
			expect(alarm.scheduled).toBe(earliestWake(database))

			makeDue(database, 'steady')
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
			// The run completed: its wake is consumed and its next fire scheduled; the alarm follows the wakes.
			expect(wakesOf(database, 'steady')).toEqual([expect.objectContaining({ reason: 'cron', attempt: 0 })])
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeGreaterThan(Date.now())
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null, last_status: 'succeeded' })
			expect(alarm.scheduled).toBe(earliestWake(database))
		})
	})

	test('without an integer time is 400 and arms nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const { alarm, instance } = await start()
			const tick = await instance.object.fetch(
				new Request(`${ORIGIN}/`, { method: 'POST', headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, [TICK_HEADER]: 'soon' } }),
			)
			expect(tick.status).toBe(400)
			expect(alarm.armed).toEqual([])
		})
	})

	test('recovers a lost alarm: after its retries were exhausted, the tick arms it again at the overdue wake', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance } = started
			const overdue = Date.now() - 5 * MINUTE
			makeDue(database, 'steady', overdue)
			// The platform gave up on the alarm: nothing is armed while the wake is overdue.
			await alarm.set(null)
			expect((await instance.tick()).status).toBe(204)
			// The overdue wake is kept, so missed occurrences coalesce into one run.
			expect(wakesOf(database, 'steady').map((wake) => wake.due_at)).toEqual([overdue])
			expect(alarm.scheduled).toBe(overdue)
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
		})
	})
})

describe('the alarm', () => {
	test('outside open it runs nothing and arms nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, maintenance, restart } = started
			makeDue(database, 'steady')
			for (const mode of ['read-only', 'closed', 'inspect'] as const) {
				maintenance.current = { generation: 1, mode }
				const object = restart()
				alarm.scheduled = Date.now()
				const armed = alarm.armed.length
				await object.fire()
				await settle(started)
				expect(alarm.armed).toHaveLength(armed)
				expect(alarm.scheduled).toBeNull()
			}
			expect(runs).toEqual([])
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null })
		})
	})

	test('two delayed kicks at T1 < T2: the run at T1 leaves T2, and the alarm is armed for it', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance } = started
			const t1 = Date.now() - 1_000
			const t2 = Date.now() + 10 * MINUTE
			insertKick(database, 'hourly', t2)
			insertKick(database, 'hourly', t1)
			const [cron] = wakesOf(database, 'hourly').filter((wake) => wake.reason === 'cron')
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'hourly', attempt: 1 }])
			expect(wakesOf(database, 'hourly').map(({ reason, due_at }) => ({ reason, due_at })).sort((left, right) => left.due_at - right.due_at)).toEqual(
				[{ reason: 'kick', due_at: t2 }, { reason: 'cron', due_at: cron?.due_at ?? 0 }].sort((left, right) => left.due_at - right.due_at),
			)
			expect(alarm.scheduled).toBe(earliestWake(database))
		})
	})

	test('a failed run moves its wakes to a durable retry; past its retries it is reported and its cron wake advances', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance } = started
			hooks.steady = () => Promise.reject(new Error('the upstream is down'))
			makeDue(database, 'steady')
			for (const attempt of [1, 2]) {
				const before = Date.now()
				await instance.fire()
				await settle(started)
				const [wake] = wakesOf(database, 'steady')
				expect(wake).toMatchObject({ reason: 'cron', attempt, dedupe: 'cron:steady:0 3 * * *' })
				// Backoff from one second, jittered: due within its ceiling, and the alarm armed for it.
				expect(wake?.due_at).toBeGreaterThanOrEqual(before)
				expect(wake?.due_at).toBeLessThanOrEqual(Date.now() + 1_000 * 2 ** (attempt - 1))
				expect(alarm.scheduled).toBe(earliestWake(database))
				expect(reported('JobFailed')).toEqual([])
				makeDue(database, 'steady')
			}
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }, { job: 'steady', attempt: 2 }, { job: 'steady', attempt: 3 }])
			expect(reported('JobFailed')).toEqual(["fabrika: JobFailed: job 'steady' failed after 3 attempts: handler_failed"])
			const [next] = wakesOf(database, 'steady')
			expect(next).toMatchObject({ reason: 'cron', attempt: 0 })
			expect(new Date(next?.due_at ?? 0).getUTCHours()).toBe(3)
			expect(next?.due_at).toBeGreaterThan(Date.now())
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null, last_status: 'failed' })
		})
	})

	test('a wake due within the slack is waited for, so no run starts before its wake', async () => {
		await keepingProcessEnvironment(async () => {
			const waited: number[] = []
			const clock: JobClock = {
				wait: (ms, signal) =>
					new Promise<void>((resolve) => {
						if (ms <= ALARM_SLACK_MS) {
							waited.push(ms)
							setTimeout(resolve, ms)
							return
						}
						signal.addEventListener('abort', () => resolve(), { once: true })
					}),
				random: () => 0,
			}
			const started = await repaired({ clock })
			const { database, instance } = started
			const due = Date.now() + 30
			makeDue(database, 'steady', due)
			await instance.fire()
			await settle(started)
			expect(waited).toHaveLength(1)
			expect(waited[0]).toBeGreaterThan(0)
			expect(waited[0]).toBeLessThanOrEqual(ALARM_SLACK_MS)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeGreaterThan(Date.now())
		})
	})
})

describe('a crash at every boundary leaves the wakes or a held lease whose expiry is armed', () => {
	test('after the wake insert: the alarm committed with it, and the next instance runs the job', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, restart } = started
			// The tick's inserts committed with the alarm; the instance is evicted before it fires.
			expect(alarm.scheduled).toBe(earliestWake(database))
			makeDue(database, 'steady')
			await restart().fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
		})
	})

	test('after acquire, before the handler started: the lease expiry is armed, and its reap runs the job again', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance, restart, iam } = started
			makeDue(database, 'steady')
			// The run waits for IAM; the instance is evicted there, so its run never goes on.
			iam.hold()
			await instance.fire()
			expect(leaseOf(database, 'steady')?.holder).not.toBeNull()
			expect(runs).toEqual([])
			expect(alarm.scheduled).toBe(Date.parse(leaseOf(database, 'steady')?.expires_at ?? ''))
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeLessThan(Date.now())
			started.pending.splice(0)
			iam.free()
			await recoverAfterExpiry(started, restart())
		})
	})

	test('mid-run: the lease expiry is armed, and its reap runs the job again; nothing was consumed', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance, restart } = started
			makeDue(database, 'steady')
			const running = Promise.withResolvers<void>()
			hooks.steady = () => {
				running.resolve()
				return new Promise<void>(() => {})
			}
			await instance.fire()
			await running.promise
			expect(alarm.scheduled).toBe(Date.parse(leaseOf(database, 'steady')?.expires_at ?? ''))
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeLessThan(Date.now())
			started.pending.splice(0)
			hooks.steady = null
			await recoverAfterExpiry(started, restart())
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }, { job: 'steady', attempt: 1 }])
		})
	})

	test('before finish: a finish whose alarm could not be set rolls back, and the reap runs the job again', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance, restart } = started
			makeDue(database, 'steady')
			hooks.steady = () => {
				// The handler's own work is done; the finish that follows cannot arm the alarm.
				alarm.failures = 1
				return Promise.resolve()
			}
			await instance.fire()
			await settle(started)
			expect(reported('JobFailed')).toEqual(["fabrika: JobFailed: job 'steady' failed after 1 attempt: driver_failed"])
			expect(leaseOf(database, 'steady')?.holder).not.toBeNull()
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeLessThan(Date.now())
			hooks.steady = null
			await recoverAfterExpiry(started, restart())
		})
	})

	test('a failed setAlarm in the alarm rolls its transaction back, re-arms in 30 s and is reported', async () => {
		await keepingProcessEnvironment(async () => {
			const started = await repaired()
			const { database, alarm, instance } = started
			makeDue(database, 'steady')
			alarm.failures = 1
			const before = Date.now()
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([])
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null })
			expect(wakesOf(database, 'steady')[0]?.due_at).toBeLessThan(before)
			expect(alarm.scheduled).toBeGreaterThanOrEqual(before + ALARM_RETRY_MS)
			expect(alarm.scheduled).toBeLessThanOrEqual(Date.now() + ALARM_RETRY_MS)
			expect(reported('AlarmFailed')).toEqual(["fabrika: AlarmFailed: the job scheduler's alarm failed"])
			await instance.fire()
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
		})
	})
})

/** The held lease expires; the next alarm reaps it, reports the crash and runs the job, which consumes its wake. */
async function recoverAfterExpiry(started: Started, object: Instance): Promise<void> {
	const { database, alarm } = started
	const before = runs.length
	expireLease(database, 'steady')
	await object.fire()
	await settle(started)
	expect(reported('JobFailed')).toContain("fabrika: JobFailed: job 'steady' failed: crashed (its run's lease expired before the run finished)")
	expect(runs.slice(before)).toEqual([{ job: 'steady', attempt: 1 }])
	expect(leaseOf(database, 'steady')).toMatchObject({ holder: null, last_status: 'succeeded' })
	expect(wakesOf(database, 'steady')[0]?.due_at).toBeGreaterThan(Date.now())
	expect(alarm.scheduled).toBe(earliestWake(database))
}

describe('one deadline over the segment', () => {
	/** A clock whose time moves only when the test moves it; a wait of a minute or more ends only when the test ends it. */
	function virtualClock() {
		let offset = 0
		const base = Date.now()
		const long: { readonly ms: number; readonly resolve: () => void }[] = []
		const clock: JobClock = {
			now: () => base + offset,
			random: () => 0,
			wait: (ms, signal) =>
				new Promise<void>((resolve) => {
					if (ms < MINUTE || signal.aborted) {
						resolve()
						return
					}
					long.push({ ms, resolve })
					signal.addEventListener('abort', () => resolve(), { once: true })
				}),
		}
		return { clock, long, advance: (ms: number) => void (offset += ms) }
	}

	test('IAM that does not answer before the deadline times the attempt out, and the handler never runs', async () => {
		await keepingProcessEnvironment(async () => {
			const virtual = virtualClock()
			const started = await repaired({ clock: virtual.clock })
			const { database, instance, iam } = started
			makeDue(database, 'steady')
			const release = iam.hold()
			await instance.fire()
			await until(() => virtual.long.length === 1)
			expect(virtual.long[0]?.ms).toBe(CLOUDFLARE_MAX_JOB_SEGMENT_MS)
			virtual.long[0]?.resolve()
			await settle(started)
			release()
			expect(runs).toEqual([])
			// A timeout is retried durably: the wake moved and counted the attempt.
			expect(wakesOf(database, 'steady')[0]).toMatchObject({ reason: 'cron', attempt: 1 })
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null, last_status: 'failed' })
		})
	})

	test('IAM that answers late leaves the handler only what remains of the segment', async () => {
		await keepingProcessEnvironment(async () => {
			const virtual = virtualClock()
			const started = await repaired({ clock: virtual.clock })
			const { database, instance, iam } = started
			makeDue(database, 'steady')
			const release = iam.hold()
			await instance.fire()
			await until(() => virtual.long.length === 1)
			virtual.advance(10 * MINUTE)
			release()
			await until(() => virtual.long.length === 2)
			expect(virtual.long.map((wait) => wait.ms)).toEqual([CLOUDFLARE_MAX_JOB_SEGMENT_MS, CLOUDFLARE_MAX_JOB_SEGMENT_MS - 10 * MINUTE])
			await settle(started)
			expect(runs).toEqual([{ job: 'steady', attempt: 1 }])
			expect(leaseOf(database, 'steady')).toMatchObject({ holder: null, last_status: 'succeeded' })
		})
	})
})

/** Waits until `condition` holds, a turn of the event loop at a time. */
async function until(condition: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200 && !condition(); turn++) {
		await Bun.sleep(1)
	}
	expect(condition()).toBe(true)
}
