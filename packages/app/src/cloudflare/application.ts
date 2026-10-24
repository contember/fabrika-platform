// The Durable Object an application environment runs in (ADR-0065): it migrates its SQLite, boots the application and
// serves every request and minute tick its Worker forwards. A plain class, so Bun and Lopata load it without
// `cloudflare:workers`.

import { FABRIKA_PROXY_SECRET, OPS_PREFIX, type OpsBootFailureContent, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { isScopedDatabase } from '@fabrika/db/framework'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { openSqlite, type SqliteStorage } from '@fabrika/db/sqlite'
import { migrateSqlite } from '@fabrika/db/sqlite-migrate'
import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'
import type { RequestExecutionContext } from '../fetch.js'
import { boot, type ContractApp } from '../implement/boot.js'
import { type CrashEvents, environmentCrashReporter, reportSurvivedCrashes } from '../implement/crashes.js'
import { proxySecretDigest } from '../implement/dispatch.js'
import { type CapturedEnvironment, captureEnvironment } from '../implement/environment.js'
import type { ContractImplementation } from '../implement/implement.js'
import type { CrashReporter } from '../jobs/report.js'
import { isDueAt } from '../jobs/schedule.js'
import { environmentScrubber, type Scrubber } from '../jobs/scrub.js'
import { bindingAssets, bindingKeySource, bindingMembership, bindingTerminals, bindingWorkloadTokens, connectBindings } from './bindings.js'
import { CLOUDFLARE_FILES_BINDING } from './names.js'
import { type OpsAccess, opsAccess, type OpsStorage, serveOps } from './ops.js'
import { r2FileObjectStore } from './r2-files.js'

/** The application module, imported only after the environment was captured: the generated entrypoint's `import()`. */
export type ImplementationLoader = () => Promise<{ readonly default: ContractImplementation }>

/** One of the application's SQLite migrations, as `fabrika app build` bundles them from `db/migrations`. */
export interface ApplicationMigration {
	readonly name: string
	readonly sql: string
}

export interface ContractWorkerOptions {
	/** The application's own SQLite migrations, applied as the bundle `app` after the framework's `fabrika`. */
	readonly migrations?: readonly ApplicationMigration[]
	/** Where the isolate hears of an unhandled rejection; the global `unhandledrejection` event by default. */
	readonly rejections?: CrashEvents
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
}

/**
 * Marks the Worker's minute tick, with its `scheduledTime`. The Worker's `fetch` removes it from every request it
 * forwards, so only its own `scheduled` handler reaches the tick.
 */
export const TICK_HEADER = 'X-Fabrika-Tick'

/** What the object needs of its `ctx.storage`; a Durable Object's `DurableObjectStorage` fits it. */
export type ApplicationStorage = SqliteStorage & OpsStorage

/** What the object needs of its `DurableObjectState`. */
export interface ApplicationState {
	readonly storage: ApplicationStorage
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
	waitUntil(promise: Promise<unknown>): void
}

/** The framework's bindings: IAM's application entrypoint and the Workers Assets of the SPA. No handler sees them. */
const FRAMEWORK_BINDINGS: ReadonlySet<string> = new Set(['IAM', 'ASSETS'])

/**
 * The application this isolate booted, once: its module is loaded once, and its `scoped(tables)` layer binds once, to
 * the storage of the object whose event runs (`objectStorage`), never to one database.
 */
interface Booted {
	readonly app: ContractApp
	/** Whether the application has a data layer, which every object instance migrates in its own storage. */
	readonly migrates: boolean
}

interface ApplicationSetup {
	readonly load: ImplementationLoader
	readonly options: ContractWorkerOptions
	booted: Promise<Booted> | null
	/** Whether the current streak of failed attachments was reported; an attachment that succeeds ends the streak. */
	failureReported: boolean
	watchingRejections: boolean
}

let registered: ApplicationSetup | null = null

/** The storage of the object whose event runs; the work an event hands to `waitUntil` keeps it. */
const objectStorage = new AsyncLocalStorage<ApplicationStorage>()

function eventStorage(): ApplicationStorage {
	const storage = objectStorage.getStore()
	if (storage === undefined) {
		throw new Error('a statement ran outside any event of an application object: the framework runs every event in its object scope')
	}
	return storage
}

/** What the object classes of this isolate boot: the generated entrypoint's `createContractWorker` registers it. */
export function registerApplication(load: ImplementationLoader, options: ContractWorkerOptions): void {
	registered = { load, options, booted: null, failureReported: false, watchingRejections: false }
}

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

/** The framework's tables, then the application's, each migration once: a booted storage applies nothing. */
async function migrate(storage: ApplicationStorage, migrations: readonly ApplicationMigration[]): Promise<void> {
	await migrateSqlite({ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) }, [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: 'app', migrations },
	])
}

async function bootApplication(
	setup: ApplicationSetup,
	state: ApplicationState,
	env: Readonly<Record<string, unknown>>,
	environment: CapturedEnvironment,
	crashes: CrashReporter | null,
): Promise<Booted> {
	const { default: implementation } = await setup.load()
	const migrates = isScopedDatabase(implementation.database)
	if (migrates) {
		await migrate(state.storage, setup.options.migrations ?? [])
	}
	const database = migrates
		? openSqlite({
			sql: { exec: (query, ...bindings) => eventStorage().sql.exec(query, ...bindings) },
			transaction: (closure) => eventStorage().transaction(closure),
			transactionSync: (closure) => eventStorage().transactionSync(closure),
		})
		: undefined
	const app = boot(implementation, {
		environment,
		iam: bindingKeySource(env['IAM']),
		assets: bindingAssets(env['ASSETS']),
		membership: bindingMembership(env['IAM']),
		terminals: bindingTerminals(env['IAM']),
		workloadTokens: bindingWorkloadTokens(env['IAM']),
		connectBindings: connectBindings(env),
		database,
		files: r2FileObjectStore(env[CLOUDFLARE_FILES_BINDING]),
		// The Worker forwards only with the proxy secret, which the object checked; `boot` checks it again.
		requireProxySecret: true,
		// The proxy Worker sets `X-Fabrika-Client-Ip` from `CF-Connecting-IP`, the visitor Cloudflare saw.
		clientAddress: 'vouched',
		...(setup.options.operationsFetch === undefined ? {} : { operationsFetch: setup.options.operationsFetch }),
	})
	const booted: Booted = { app, migrates }
	if (crashes !== null && !setup.watchingRejections) {
		setup.watchingRejections = true
		reportSurvivedCrashes(setup.options.rejections ?? globalRejectionEvents(), crashes)
	}
	return booted
}

/**
 * The isolate's booted application with this instance's storage migrated, or the first boot. Reports the first failure
 * of a streak as `boot_failed`, whichever instance or step it comes from; an attachment that succeeds ends the streak.
 */
async function attach(
	setup: ApplicationSetup | null,
	state: ApplicationState,
	env: Readonly<Record<string, unknown>>,
	failed: (failure: OpsBootFailureContent) => void,
): Promise<Booted> {
	if (setup === null) {
		throw new Error('no contract application is registered: the generated entrypoint calls createContractWorker before an object starts')
	}
	const environment = captureEnvironment(Object.fromEntries(Object.entries(env).filter(([name]) => !FRAMEWORK_BINDINGS.has(name))))
	const crashes = environmentCrashReporter(environment, setup.options.operationsFetch)
	try {
		const booted = await attachOnce(setup, state, env, environment, crashes)
		setup.failureReported = false
		return booted
	} catch (error) {
		failed(bootFailure(error, environmentScrubber(environment)))
		if (crashes !== null && !setup.failureReported) {
			setup.failureReported = true
			state.waitUntil(crashes.report('boot_failed', error))
		}
		throw error
	}
}

async function attachOnce(
	setup: ApplicationSetup,
	state: ApplicationState,
	env: Readonly<Record<string, unknown>>,
	environment: CapturedEnvironment,
	crashes: CrashReporter | null,
): Promise<Booted> {
	if (setup.booted === null) {
		const booting = bootApplication(setup, state, env, environment, crashes)
		setup.booted = booting
		// A failed boot is not kept: the next object instance boots again and fails with the same problems.
		booting.catch(() => {
			setup.booted = null
		})
		return await booting
	}
	const booted = await setup.booted
	if (booted.migrates) {
		await migrate(state.storage, setup.options.migrations ?? [])
	}
	return booted
}

/** A failed boot as the ops view shows it, its text scrubbed as a crash report's is. */
function bootFailure(error: unknown, scrubber: Scrubber): OpsBootFailureContent {
	const at = new Date().toISOString()
	if (error instanceof Error) {
		return { at, message: scrubber.scrub(error.message), stack: typeof error.stack === 'string' ? scrubber.scrub(error.stack) : null }
	}
	const message = typeof error === 'string' ? scrubber.scrub(error) : `a thrown ${error === null ? 'null' : typeof error} that is not an Error`
	return { at, message, stack: null }
}

type Outcome = { readonly booted: Booted } | { readonly failure: unknown }

/** The wait after an instance's first failed boot before an event boots again; it doubles with each failure, to the cap. */
const BOOT_RETRY_MS = 1_000
const BOOT_RETRY_CAP_MS = 60_000

/** A job run handed to `waitUntil`; the runner logs and reports its own failures. */
async function runQuietly(app: ContractApp, name: string): Promise<void> {
	try {
		await app.jobs.run(name)
	} catch {
		console.error(`fabrika: job '${name}' did not start: driver_failed`)
	}
}

/** The application environment's one object. The Worker's generated entrypoint exports it as `FabrikaApplication`. */
export class FabrikaApplication {
	readonly #state: ApplicationState
	readonly #env: Readonly<Record<string, unknown>>
	readonly #setup: ApplicationSetup | null
	/** `proxySecretDigest` of the environment's proxy secret; `null` refuses every request. */
	readonly #secret: Uint8Array | null
	/** What the platform wrote for Control's ops channel; `null` refuses every ops request. */
	readonly #ops: OpsAccess | null
	/** The instance's last failed boot, kept in memory for the ops view. */
	#bootFailure: OpsBootFailureContent | null = null
	/** The instance's boot, `null` until the first event that needs the application: an ops request never starts it. */
	#outcome: Promise<Outcome> | null = null
	#failedBoots = 0
	/** When an event may boot again after a failed boot; until then every request answers the failure. */
	#retryAt = 0

	constructor(state: ApplicationState, env: Readonly<Record<string, unknown>>) {
		this.#state = state
		this.#env = env
		this.#setup = registered
		const secret = env[FABRIKA_PROXY_SECRET]
		this.#secret = typeof secret === 'string' && secret !== '' ? proxySecretDigest(secret) : null
		this.#ops = opsAccess(env)
	}

	async fetch(request: Request): Promise<Response> {
		// Another Worker on the account that binds this class reaches nothing, not even an answer that the object exists.
		if (!this.#fromWorker(request)) {
			return new Response(null, { status: 404 })
		}
		if (new URL(request.url).pathname.startsWith(OPS_PREFIX)) {
			// Served from storage alone: it never starts a boot or a retry, and waits for one under way only once authenticated.
			return await serveOps(request, this.#ops, {
				storage: this.#state.storage,
				bootFailure: async () => {
					await this.#outcome
					return this.#bootFailure
				},
			})
		}
		const outcome = await this.#current()
		if ('failure' in outcome) {
			throw outcome.failure
		}
		return await objectStorage.run(this.#state.storage, () => this.#serve(outcome.booted, request))
	}

	/** Settles either way: a callback that rejects would reset the object, and every request answers the failure instead. */
	#boot(): Promise<Outcome> {
		return this.#state.blockConcurrencyWhile(() =>
			attach(this.#setup, this.#state, this.#env, (failure) => {
				this.#bootFailure = failure
			}).then((booted): Outcome => ({ booted }), (failure: unknown): Outcome => {
				this.#failedBoots++
				this.#retryAt = Date.now() + Math.min(BOOT_RETRY_MS * 2 ** (this.#failedBoots - 1), BOOT_RETRY_CAP_MS)
				return { failure }
			})
		)
	}

	/**
	 * The instance's boot, started by the first event that needs it and booted again once a failed boot's backoff has
	 * passed; concurrent events share one boot and one retry.
	 */
	async #current(): Promise<Outcome> {
		if (this.#outcome === null) {
			this.#outcome = this.#boot()
		}
		const pending = this.#outcome
		const outcome = await pending
		if (!('failure' in outcome) || Date.now() < this.#retryAt) {
			return outcome
		}
		if (this.#outcome === pending) {
			this.#outcome = this.#boot()
		}
		return await this.#outcome
	}

	#serve(booted: Booted, request: Request): Promise<Response> {
		const tick = request.headers.get(TICK_HEADER)
		if (tick !== null) {
			return Promise.resolve(this.#tick(booted, tick))
		}
		const exec: RequestExecutionContext = { waitUntil: (promise) => this.#state.waitUntil(promise) }
		return booted.app.fetch(request, exec)
	}

	/** The fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks. */
	#fromWorker(request: Request): boolean {
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return this.#secret !== null && presented !== '' && timingSafeEqual(proxySecretDigest(presented), this.#secret)
	}

	/** Runs every job due in the tick's UTC minute and the jobs' check, each past the answer. */
	#tick(booted: Booted, scheduledTime: string): Response {
		const time = Number(scheduledTime)
		if (!Number.isSafeInteger(time)) {
			return new Response(null, { status: 400 })
		}
		const at = new Date(time)
		const jobs = booted.app.jobs.scheduled
		for (const job of jobs) {
			if (isDueAt(job.schedule, at)) {
				this.#state.waitUntil(runQuietly(booted.app, job.name))
			}
		}
		if (jobs.length > 0) {
			this.#state.waitUntil(booted.app.jobs.check())
		}
		return new Response(null, { status: 204 })
	}
}
