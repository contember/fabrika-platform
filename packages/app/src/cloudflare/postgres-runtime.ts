// What the Worker and the job object of a Cloudflare application on Postgres share (ADR-0065): the isolate's one boot of
// the application over the `FABRIKA_DATABASE` Hyperdrive binding, and the event scope every statement runs in. An event
// (a request, an alarm, a repair tick) opens its own postgres.js client and ends it only once the work it handed to
// `waitUntil` settled; the engine reaches the client of the event that runs through `AsyncLocalStorage`.

import { FABRIKA_IAM_APP_ID, FABRIKA_PROXY_SECRET, parseAppEnvironmentId, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { applicationSchema } from '@fabrika/db'
import { isScopedDatabase, type Session } from '@fabrika/db/framework'
import { HYPERDRIVE_CLIENT_OPTIONS, type HyperdriveClient, openHyperdrive } from '@fabrika/db/hyperdrive'
import { AsyncLocalStorage } from 'node:async_hooks'
import postgres from 'postgres'
import type { RequestExecutionContext } from '../fetch.js'
import { FILE_TOMBSTONE_RETENTION_MS } from '../files/kinds.js'
import { boot, BootError, type ContractApp } from '../implement/boot.js'
import { type CrashEvents, environmentCrashReporter, reportSurvivedCrashes } from '../implement/crashes.js'
import { captureEnvironment } from '../implement/environment.js'
import type { JobClock } from '../jobs/runner.js'
import type { ImplementationLoader } from './application.js'
import { bindingAssets, bindingKeySource, bindingMembership, bindingTerminals, bindingWorkloadTokens, connectBindings, method } from './bindings.js'
import { CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_ASSETS_BINDING, CLOUDFLARE_DATABASE_BINDING, CLOUDFLARE_FILES_BINDING } from './names.js'
import { r2FileObjectStore } from './r2-files.js'

/** One event's postgres.js client, which the Worker ends after the event's tracked work settled. */
export interface PostgresEventClient extends HyperdriveClient {
	end(options?: { readonly timeout?: number }): Promise<void>
}

export interface PostgresWorkerOptions {
	/** Where the isolate hears of an unhandled rejection; the global `unhandledrejection` event by default. */
	readonly rejections?: CrashEvents
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
	/** The jobs' and the alarm's waits and an attempt's deadline; the system clock by default. */
	readonly clock?: JobClock
	/**
	 * Opens one event's client from `FABRIKA_DATABASE.connectionString`; `connectHyperdrive` by default:
	 * `postgres(url, { max: HYPERDRIVE_CLIENT_MAX, ...HYPERDRIVE_CLIENT_OPTIONS })`. A client of its own must take
	 * `HYPERDRIVE_CLIENT_OPTIONS` too: with `fetch_types` off, postgres.js 3.4.9 never answers a `reserve` that opens a
	 * connection (porsager/postgres#1219).
	 */
	readonly connect?: (connectionString: string) => PostgresEventClient
}

/** The connections one event's client opens at most: Workers allow six simultaneous connections per invocation. */
export const HYPERDRIVE_CLIENT_MAX = 5

/** The job object re-arms its alarm at least this often, so a wake nothing projected still runs. */
export const POSTGRES_ALARM_REFRESH_MS = 60_000

/** The path on which the Worker tells the job object that a request projected a wake. */
export const WAKE_PATH = '/__fabrika/wake'

/** The milliseconds from now until the earliest wake the request projected. */
export const WAKE_DELAY_HEADER = 'X-Fabrika-Wake-Delay'

/** The one object of the environment's namespace that runs the jobs; a Postgres environment has no other. */
export const JOB_OBJECT_NAME = 'application'

/** How long an event's client waits for its queries to finish once the event's work settled, in seconds. */
const CLIENT_END_TIMEOUT_S = 5

/** The wait after an isolate's first failed boot before an event boots again; it doubles with each failure, to the cap. */
const BOOT_RETRY_MS = 1_000
const BOOT_RETRY_CAP_MS = 60_000

/** The framework's bindings: IAM's application entrypoint and the Workers Assets of the SPA. No handler sees them. */
const FRAMEWORK_BINDINGS: ReadonlySet<string> = new Set(['IAM', CLOUDFLARE_ASSETS_BINDING])

/**
 * One event's client over the Hyperdrive connection string: at most `HYPERDRIVE_CLIENT_MAX` connections, with the
 * engine's `HYPERDRIVE_CLIENT_OPTIONS` (no prepared statement, `fetch_types` on, parameters and arrays as Bun.SQL
 * reads them).
 */
export function connectHyperdrive(connectionString: string): PostgresEventClient {
	// A notice may quote a value, so none is logged.
	return postgres(connectionString, { max: HYPERDRIVE_CLIENT_MAX, ...HYPERDRIVE_CLIENT_OPTIONS, onnotice: () => {} })
}

/** The connection string of the environment's Hyperdrive binding; it is a credential, so no message quotes it. */
function connectionStringOf(env: Readonly<Record<string, unknown>>): string {
	const binding = env[CLOUDFLARE_DATABASE_BINDING]
	const connectionString: unknown = typeof binding === 'object' && binding !== null ? Reflect.get(binding, 'connectionString') : undefined
	if (typeof connectionString !== 'string' || connectionString === '') {
		throw new Error(
			`the ${CLOUDFLARE_DATABASE_BINDING} Hyperdrive binding is missing; the provider binds it to the Worker of an application on Postgres`,
		)
	}
	return connectionString
}

// ─── The event scope ─────────────────────────────────────────────────

/**
 * One event of the Worker or the job object: its client, the projection of the wakes its writes change, and the work it
 * handed to `waitUntil`, which its client outlives.
 */
export class PostgresEvent {
	readonly client: PostgresEventClient
	readonly #project: (transaction: Session) => Promise<void>
	readonly #tracked = new Set<Promise<void>>()

	constructor(client: PostgresEventClient, project: (transaction: Session) => Promise<void>) {
		this.client = client
		this.#project = project
	}

	/** `BootOptions.projectWakes` of the event: it runs in the transaction of every change of a wake or a lease. */
	project(transaction: Session): Promise<void> {
		return this.#project(transaction)
	}

	/** Holds `work` until it settled: the client ends only after it. Its rejection is its own to report. */
	track(work: Promise<unknown>): void {
		const settled = work.then(() => undefined, () => undefined)
		this.#tracked.add(settled)
		void settled.then(() => this.#tracked.delete(settled))
	}

	/** The execution context the application's handlers hand their background work to. */
	readonly exec: RequestExecutionContext = { waitUntil: (promise) => this.track(promise) }

	/** Runs `work` in this event's scope: every statement it starts, the work it hands on included, uses this client. */
	run<T>(work: () => T): T {
		return events.run(this, work)
	}

	/** Resolves once every tracked work settled, the work tracked meanwhile included. */
	async settled(): Promise<void> {
		while (this.#tracked.size > 0) {
			await Promise.all(this.#tracked)
		}
	}

	/** Ends the client once the tracked work settled; never rejects. */
	async end(): Promise<void> {
		await this.settled()
		try {
			await this.client.end({ timeout: CLIENT_END_TIMEOUT_S })
		} catch {
			// A driver error may quote the connection string.
			console.error("fabrika: an event's database client did not end cleanly: driver_failed")
		}
	}
}

const events = new AsyncLocalStorage<PostgresEvent>()

/** The event that runs; a statement outside one is the framework's bug. */
function currentEvent(): PostgresEvent {
	const event = events.getStore()
	if (event === undefined) {
		throw new Error('a statement ran outside any event of the application: the framework runs every event in its scope')
	}
	return event
}

// ─── The isolate's boot ──────────────────────────────────────────────

/** An isolate's boot: the booted application, or why it failed. It settles either way. */
export type BootOutcome = { readonly app: ContractApp } | { readonly failure: unknown }

/** The isolate's `unhandledrejection` event. Listening leaves the runtime's own handling, its log line, in place. */
function globalRejectionEvents(): CrashEvents {
	return {
		listen(listener) {
			const rejection = (event: Event) => listener('unhandled_rejection', Reflect.get(event, 'reason'))
			globalThis.addEventListener('unhandledrejection', rejection)
			return () => globalThis.removeEventListener('unhandledrejection', rejection)
		},
	}
}

/** `app_<id>` of the application `FABRIKA_IAM_APP_ID` names: Control may leave `FABRIKA_APP_ID` unset on Cloudflare. */
function schemaOf(framework: Readonly<Record<string, string>>): string {
	const parsed = parseAppEnvironmentId(framework[FABRIKA_IAM_APP_ID]?.trim() ?? '')
	if (parsed === null) {
		throw new BootError([`${FABRIKA_IAM_APP_ID} is not an application environment id (allowed: <app>@<env>); the platform writes it into every deploy`])
	}
	return applicationSchema(parsed.app)
}

/**
 * The application of an isolate on Postgres, registered by the generated entrypoint's `createPostgresContractWorker`:
 * the Worker and the job object boot it once and share it. A failed boot is reported once per streak and is retried
 * after a backoff, by whichever event comes next.
 */
export class PostgresApplication {
	readonly #load: ImplementationLoader
	readonly options: PostgresWorkerOptions
	#outcome: Promise<BootOutcome> | null = null
	#failedBoots = 0
	#retryAt = 0
	#failureReported = false
	#watchingRejections = false

	constructor(load: ImplementationLoader, options: PostgresWorkerOptions) {
		this.#load = load
		this.options = options
	}

	/** Opens a client of the event that is starting, over the environment's Hyperdrive binding. */
	connect(env: Readonly<Record<string, unknown>>): PostgresEventClient {
		return (this.options.connect ?? connectHyperdrive)(connectionStringOf(env))
	}

	/**
	 * The isolate's boot, started by the first event that needs it and booted again once a failed boot's backoff has
	 * passed; concurrent events share one boot and one retry. `waitUntil` keeps a failure's report alive.
	 */
	async current(env: Readonly<Record<string, unknown>>, waitUntil: (promise: Promise<unknown>) => void): Promise<BootOutcome> {
		if (this.#outcome === null) {
			this.#outcome = this.#boot(env, waitUntil)
		}
		const pending = this.#outcome
		const outcome = await pending
		if ('failure' in outcome && Date.now() >= this.#retryAt) {
			if (this.#outcome === pending) {
				this.#outcome = this.#boot(env, waitUntil)
			}
			return await this.#outcome
		}
		return outcome
	}

	async #boot(env: Readonly<Record<string, unknown>>, waitUntil: (promise: Promise<unknown>) => void): Promise<BootOutcome> {
		const environment = captureEnvironment(Object.fromEntries(Object.entries(env).filter(([name]) => !FRAMEWORK_BINDINGS.has(name))))
		const crashes = environmentCrashReporter(environment, this.options.operationsFetch)
		try {
			connectionStringOf(env)
			const { default: implementation } = await this.#load()
			const database = isScopedDatabase(implementation.database)
				? openHyperdrive({ schema: schemaOf(environment.framework), client: () => currentEvent().client })
				: undefined
			const app = boot(implementation, {
				environment,
				iam: bindingKeySource(env['IAM']),
				assets: bindingAssets(env[CLOUDFLARE_ASSETS_BINDING]),
				membership: bindingMembership(env['IAM']),
				terminals: bindingTerminals(env['IAM']),
				workloadTokens: bindingWorkloadTokens(env['IAM']),
				connectBindings: connectBindings(env),
				database,
				files: r2FileObjectStore(env[CLOUDFLARE_FILES_BINDING]),
				// A removed file's object outlives its row for the window, as on the Durable Object's SQLite.
				fileRetentionMs: FILE_TOMBSTONE_RETENTION_MS,
				// The Worker sets the proxy secret on every request it serves; `boot` checks it.
				requireProxySecret: true,
				// The proxy Worker sets `X-Fabrika-Client-Ip` from `CF-Connecting-IP`, the visitor Cloudflare saw.
				clientAddress: 'vouched',
				// No `connections`: the public in-flight share is a quarter of a pool, and the isolate has none. Each event opens
				// its own client, so the share takes the default, two calls per isolate, as on the SQLite object.
				projectWakes: (transaction) => currentEvent().project(transaction),
				// A request's kick is its wake; the job object runs it from its alarm.
				kickRuns: 'scheduler',
				...(this.options.operationsFetch === undefined ? {} : { operationsFetch: this.options.operationsFetch }),
			})
			if (crashes !== null && !this.#watchingRejections) {
				this.#watchingRejections = true
				reportSurvivedCrashes(this.options.rejections ?? globalRejectionEvents(), crashes)
			}
			this.#failureReported = false
			this.#failedBoots = 0
			return { app }
		} catch (failure) {
			this.#failedBoots++
			this.#retryAt = Date.now() + Math.min(BOOT_RETRY_MS * 2 ** (this.#failedBoots - 1), BOOT_RETRY_CAP_MS)
			if (crashes !== null && !this.#failureReported) {
				this.#failureReported = true
				waitUntil(crashes.report('boot_failed', failure))
			}
			return { failure }
		}
	}
}

let registered: PostgresApplication | null = null

/** Registers the isolate's application; the job objects constructed from here on boot it. */
export function registerPostgresApplication(load: ImplementationLoader, options: PostgresWorkerOptions): PostgresApplication {
	registered = new PostgresApplication(load, options)
	return registered
}

/** The application the generated entrypoint registered, or `null` before it did. */
export function registeredPostgresApplication(): PostgresApplication | null {
	return registered
}

// ─── The job object, as the Worker reaches it ────────────────────────

/** The environment's proxy secret, which every request the Worker sends its object carries. */
export function proxySecretOf(env: Readonly<Record<string, unknown>>): string {
	const secret = env[FABRIKA_PROXY_SECRET]
	if (typeof secret !== 'string' || secret === '') {
		throw new Error(`${FABRIKA_PROXY_SECRET} is not set; the application Worker serves nothing without it`)
	}
	return secret
}

/** The job object of the environment's namespace (`FABRIKA_APPLICATION`), as a fetch. */
export function jobObject(env: Readonly<Record<string, unknown>>): (request: Request) => Promise<Response> {
	const namespace = env[CLOUDFLARE_APPLICATION_BINDING]
	const idFromName = method(namespace, 'idFromName')
	const get = method(namespace, 'get')
	if (idFromName === null || get === null) {
		throw new Error(`the ${CLOUDFLARE_APPLICATION_BINDING} binding is missing; the provider binds the application's job object to its Worker`)
	}
	const stub: unknown = get(idFromName(JOB_OBJECT_NAME))
	// Read, not tested with `in`: a stub answers `fetch` without owning the property.
	const fetchObject: unknown = typeof stub === 'object' && stub !== null ? Reflect.get(stub, 'fetch') : undefined
	if (typeof fetchObject !== 'function') {
		throw new Error(`the ${CLOUDFLARE_APPLICATION_BINDING} binding answered no object`)
	}
	return async (request) => {
		const response: unknown = await Reflect.apply(fetchObject, stub, [request])
		if (!(response instanceof Response)) {
			throw new Error("the application's job object answered something that is not a Response")
		}
		return response
	}
}

/** Tells the job object that a wake is due in `delay` ms; it lowers its alarm to it, never raises it. */
export async function notifyWake(env: Readonly<Record<string, unknown>>, delay: number): Promise<void> {
	const response = await jobObject(env)(
		new Request(`https://application.invalid${WAKE_PATH}`, {
			method: 'POST',
			headers: { [PROXY_SECRET_HEADER]: proxySecretOf(env), [WAKE_DELAY_HEADER]: String(Math.max(0, Math.ceil(delay))) },
		}),
	)
	await response.body?.cancel()
	if (!response.ok) {
		throw new Error(`the job object answered a wake with ${response.status}`)
	}
}
