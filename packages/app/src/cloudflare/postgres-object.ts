// The Durable Object of a Cloudflare application on Postgres (ADR-0065): the class and binding names of the SQLite
// object, but it serves no request. It runs the jobs from its alarm over the database the Worker serves, and its alarm is
// a projection of the wakes in Postgres, which it can only lower from outside a transaction: every change lowers it
// (its own through `projectWakes`, a request's through the Worker's wake notice), and every alarm re-arms it from the
// database at most `POSTGRES_ALARM_REFRESH_MS` ahead, so a projection that was lost still runs within that.

import { OPS_PREFIX, opsRefusal, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import type { LeaseFence, Session } from '@fabrika/db/framework'
import { timingSafeEqual } from 'node:crypto'
import type { ContractApp } from '../implement/boot.js'
import { proxySecretDigest } from '../implement/dispatch.js'
import { type JobClock, type JobScheduler, systemClock } from '../jobs/runner.js'
import { ALARM_RETRY_MS, ALARM_SLACK_MS, TICK_HEADER } from './application.js'
import {
	POSTGRES_ALARM_REFRESH_MS,
	type PostgresApplication,
	PostgresEvent,
	proxySecretOf,
	registeredPostgresApplication,
	WAKE_DELAY_HEADER,
	WAKE_PATH,
} from './postgres-runtime.js'

/** What the job object reads of its Durable Object state. */
export interface JobObjectState {
	readonly storage: { setAlarm(at: number): Promise<void>; getAlarm(): Promise<number | null>; deleteAlarm(): Promise<void> }
	waitUntil(promise: Promise<unknown>): void
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/** A repair tick's time and a wake notice's delay: digits only. */
const DIGITS = /^\d{1,16}$/

/** A run the alarm took the lease for, handed to the event; the runner logs and reports its own failures. */
async function runScheduled(scheduler: JobScheduler, job: string, fence: LeaseFence, clock: JobClock): Promise<void> {
	try {
		await scheduler.run(job, fence, { clock })
	} catch {
		console.error(`fabrika: job '${job}' did not start: driver_failed`)
	}
}

/** The Durable Object of a Postgres application: it runs the jobs from its alarm and serves no request of its own. */
export class FabrikaJobObject {
	readonly #state: JobObjectState
	readonly #env: Readonly<Record<string, unknown>>
	readonly #application: PostgresApplication | null
	readonly #clock: JobClock
	/** `proxySecretDigest` of the environment's proxy secret; `null` refuses every request. */
	readonly #secret: Uint8Array | null
	/** Whether this instance ran the scheduler's startup repair, which its first alarm or tick does. */
	#repaired = false
	/** The alarm's reads and writes, one at a time, so two lowerings never raise it between them. */
	#alarmChain: Promise<void> = Promise.resolve()
	/**
	 * While the alarm handler runs: whether an alarm was set since it started. Until one was, the alarm `getAlarm`
	 * answers is the one firing, which arms nothing.
	 */
	#firing: { setSince: boolean } | null = null

	constructor(state: JobObjectState, env: Readonly<Record<string, unknown>>) {
		this.#state = state
		this.#env = env
		this.#application = registeredPostgresApplication()
		this.#clock = this.#application?.options.clock ?? systemClock
		let secret: string | null = null
		try {
			secret = proxySecretOf(env)
		} catch {
			secret = null
		}
		this.#secret = secret === null ? null : proxySecretDigest(secret)
	}

	/** Answers only its own Worker: the repair tick and the wake notice. Everything else is a 404, ops refused. */
	async fetch(request: Request): Promise<Response> {
		// Another Worker on the account that binds this class reaches nothing, not even an answer that the object exists.
		if (!this.#fromWorker(request)) {
			return new Response(null, { status: 404 })
		}
		const tick = request.headers.get(TICK_HEADER)
		if (tick !== null) {
			return DIGITS.test(tick) && Number.isSafeInteger(Number(tick)) ? await this.#tick() : new Response(null, { status: 400 })
		}
		const path = new URL(request.url).pathname
		if (path === WAKE_PATH && request.method === 'POST') {
			const delay = request.headers.get(WAKE_DELAY_HEADER) ?? ''
			if (!DIGITS.test(delay) || !Number.isSafeInteger(Number(delay))) {
				return new Response(null, { status: 400 })
			}
			await this.#lower(Date.now() + Number(delay))
			return new Response(null, { status: 204 })
		}
		if (path.startsWith(OPS_PREFIX)) {
			// A Postgres environment has no ops channel: its backups are the database provider's.
			return opsRefusal()
		}
		return new Response(null, { status: 404 })
	}

	/**
	 * workerd calls it when the alarm is due. It never throws, because after six failures the platform stops retrying:
	 * an internal error arms it again in `ALARM_RETRY_MS` and is reported.
	 */
	async alarm(): Promise<void> {
		this.#firing = { setSince: false }
		let scheduler: JobScheduler | null = null
		let event: PostgresEvent | null = null
		try {
			const app = await this.#app()
			const booted = app.jobs.scheduler
			scheduler = booted
			if (booted === null) {
				return
			}
			const current = this.#event(app)
			event = current
			await current.run(() => this.#wake(booted, current))
		} catch (error) {
			console.error('fabrika: the alarm failed: alarm_failed')
			try {
				await this.#lower(Date.now() + ALARM_RETRY_MS)
			} catch {
				console.error('fabrika: the alarm could not be armed again; the repair tick arms it')
			}
			if (scheduler !== null) {
				const failed = scheduler.failed('alarm', error)
				if (event === null) {
					this.#state.waitUntil(failed)
				} else {
					event.track(failed)
				}
			}
		} finally {
			this.#firing = null
			if (event !== null) {
				// The runs it started go on past the handler, on its client: the client ends once they settled.
				this.#state.waitUntil(event.end())
			}
		}
	}

	/**
	 * One alarm: the startup repair once per instance, then per job a crashed holder reaped and the lease taken for a due
	 * wake (or the pending flag set for the run holding it), each lease statement in its own transaction. The runs are
	 * handed to the event, not awaited: a long job would hold back every other wake. No wake is consumed here, only by
	 * its run's finish. Last, the alarm is armed from the database.
	 *
	 * The alarm's own statements project nothing: before a take holds the lease, the wake it takes is still due, and a
	 * projection of it would lower the alarm to now, which the arm cannot raise. The arm reads what they left instead.
	 * The runs project as every other write does, in the alarm's event.
	 */
	async #wake(scheduler: JobScheduler, event: PostgresEvent): Promise<void> {
		const own = new PostgresEvent(event.client, () => Promise.resolve())
		await own.run(async () => {
			await this.#repairOnce(scheduler, event)
			const early = await scheduler.earlyBy(ALARM_SLACK_MS)
			if (early > 0) {
				await this.#clock.wait(early, new AbortController().signal)
			}
			// A job whose lease is held past its expiry but which the contract no longer declares is reaped too.
			for (const job of [...scheduler.jobs, ...(await scheduler.orphans())]) {
				const taken = await scheduler.take(job)
				if (taken.reaped) {
					event.track(scheduler.crashed(job))
				}
				const fence = taken.fence
				if (fence !== null) {
					event.track(event.run(() => runScheduled(scheduler, job, fence, this.#clock)))
				}
			}
		})
		await this.#arm(scheduler)
	}

	/**
	 * Lowers the alarm to the next wake, at most `POSTGRES_ALARM_REFRESH_MS` ahead while the contract has a job; with
	 * none and nothing pending it arms nothing.
	 */
	async #arm(scheduler: JobScheduler): Promise<void> {
		const delay = await scheduler.untilNext()
		const refresh = scheduler.jobs.length > 0 ? POSTGRES_ALARM_REFRESH_MS : Number.POSITIVE_INFINITY
		const ahead = Math.min(delay === null ? Number.POSITIVE_INFINITY : Math.max(0, delay), refresh)
		if (Number.isFinite(ahead)) {
			await this.#lower(Date.now() + ahead)
		}
	}

	/** The startup repair once per instance; a failure is reported and the next alarm repairs. */
	async #repairOnce(scheduler: JobScheduler, event: PostgresEvent): Promise<void> {
		if (this.#repaired) {
			return
		}
		try {
			this.#repaired = await scheduler.repair()
		} catch (error) {
			this.#repairFailed(scheduler, error, event)
		}
	}

	#repairFailed(scheduler: JobScheduler, error: unknown, event: PostgresEvent): void {
		console.error("fabrika: the job scheduler's repair failed: repair_failed")
		event.track(scheduler.failed('repair', error))
	}

	/** The repair tick: the startup repair again, then the alarm armed, which also starts the alarm of a fresh environment. */
	async #tick(): Promise<Response> {
		const app = await this.#app()
		const scheduler = app.jobs.scheduler
		if (scheduler === null) {
			return new Response(null, { status: 204 })
		}
		const event = this.#event(app)
		try {
			return await event.run(async () => {
				try {
					this.#repaired = (await scheduler.repair()) || this.#repaired
					await this.#arm(scheduler)
				} catch (error) {
					this.#repairFailed(scheduler, error, event)
					return new Response(null, { status: 500 })
				}
				return new Response(null, { status: 204 })
			})
		} finally {
			this.#state.waitUntil(event.end())
		}
	}

	/** The isolate's booted application, booted in `blockConcurrencyWhile` the first time; throws its boot's failure. */
	async #app(): Promise<ContractApp> {
		const application = this.#application
		if (application === null) {
			throw new Error('no contract application is registered: the generated entrypoint calls createPostgresContractWorker before an object starts')
		}
		const outcome = await this.#state.blockConcurrencyWhile(() => application.current(this.#env, (promise) => this.#state.waitUntil(promise)))
		if ('failure' in outcome) {
			throw outcome.failure
		}
		return outcome.app
	}

	/** An event of this object: its own client, and a projection that lowers its own alarm. */
	#event(app: ContractApp): PostgresEvent {
		const application = this.#application
		if (application === null) {
			throw new Error('no contract application is registered')
		}
		return new PostgresEvent(application.connect(this.#env), (transaction) => this.#projected(app, transaction))
	}

	/** `projectWakes` in the object: never later than the next wake the write leaves, which a rollback only makes early. */
	async #projected(app: ContractApp, transaction: Session): Promise<void> {
		const delay = await app.jobs.scheduler?.untilNext(transaction)
		if (delay !== undefined && delay !== null) {
			await this.#lower(Date.now() + Math.max(0, delay))
		}
	}

	/**
	 * Lowers the alarm to `at` when none is armed or the armed one is later; it never raises it. While the handler runs,
	 * the alarm that fired counts as none until something set one.
	 */
	#lower(at: number): Promise<void> {
		const { storage } = this.#state
		const lowering = this.#alarmChain.then(async () => {
			const current = await storage.getAlarm()
			const firing = this.#firing
			const stale = firing !== null && !firing.setSince
			if (current === null || stale || at < current) {
				await storage.setAlarm(at)
				if (firing !== null) {
					firing.setSince = true
				}
			}
		})
		this.#alarmChain = lowering.catch(() => undefined)
		return lowering
	}

	/** The fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks. */
	#fromWorker(request: Request): boolean {
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return this.#secret !== null && presented !== '' && timingSafeEqual(proxySecretDigest(presented), this.#secret)
	}
}
