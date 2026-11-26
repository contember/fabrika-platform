// The Durable Object an application environment runs in (ADR-0065): it migrates its SQLite, boots the application,
// serves every request and repair tick its Worker forwards, and runs the jobs from its alarm, which it arms from their
// durable wakes in the transaction of every change. A plain class, so Bun and Lopata load it without `cloudflare:workers`.

import {
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_PROXY_SECRET,
	OPS_PREFIX,
	type OpsBootFailureContent,
	type OpsMigrationFailure,
	type OpsMigrationRecord,
	type OpsMode,
	parseApplicationObjects,
	PROXY_SECRET_HEADER,
} from '@fabrika/auth-core'
import { isScopedDatabase, type LeaseFence, type Session } from '@fabrika/db/framework'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { openSqlite, type SqliteCursor, type SqliteStorage } from '@fabrika/db/sqlite'
import type { SqliteMigrationBundle } from '@fabrika/db/sqlite-migrate'
import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'
import type { RequestExecutionContext } from '../fetch.js'
import { FILE_TOMBSTONE_RETENTION_MS } from '../files/kinds.js'
import { boot, BootError, type ContractApp } from '../implement/boot.js'
import { type CrashEvents, environmentCrashReporter, reportSurvivedCrashes } from '../implement/crashes.js'
import { MaintenanceFenceError, maintenanceRefusal, proxySecretDigest, runGated } from '../implement/dispatch.js'
import { type CapturedEnvironment, captureEnvironment } from '../implement/environment.js'
import type { ContractImplementation } from '../implement/implement.js'
import type { CrashReporter } from '../jobs/report.js'
import { type JobClock, type JobScheduler, systemClock } from '../jobs/runner.js'
import { environmentScrubber, type Scrubber } from '../jobs/scrub.js'
import { bindingAssets, bindingKeySource, bindingMembership, bindingTerminals, bindingWorkloadTokens, connectBindings } from './bindings.js'
import { importInProgress } from './import.js'
import { type BarrierEvent, MaintenanceBarrier, r2MaintenanceStore } from './maintenance.js'
import { markBooted, migratingBoot, MigrationFailed, type MigrationRecordStore, r2MigrationRecordStore, RecordPending } from './migration-record.js'
import { CLOUDFLARE_ASSETS_BINDING, CLOUDFLARE_FILES_BINDING, CLOUDFLARE_VERSION_BINDING } from './names.js'
import { type OpsAccess, opsAccess, type OpsMigrated, type OpsRecovery, type OpsStorage, serveOps } from './ops.js'
import { r2FileObjectStore } from './r2-files.js'
import { trackPending } from './tracker.js'

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
	/** The contract artifact the build compiled, in its shared encoding, which boot reads instead of compiling (`BootOptions`). */
	readonly approvedContract?: string
	/** Where the isolate hears of an unhandled rejection; the global `unhandledrejection` event by default. */
	readonly rejections?: CrashEvents
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
	/** The jobs' and the alarm's waits and an attempt's deadline; the system clock by default. */
	readonly clock?: JobClock
}

/**
 * Marks the Worker's repair tick, with its `scheduledTime`. The Worker's `fetch` removes it from every request it
 * forwards, so only its own `scheduled` handler reaches the tick.
 */
export const TICK_HEADER = 'X-Fabrika-Tick'

/** A wake runs at most this early: `Date.now()` is pinned between I/O, so an alarm may start a moment before it (I6). */
export const ALARM_SLACK_MS = 50
/** After an internal error the alarm is armed again this far ahead; the repair tick covers a re-arm that failed. */
export const ALARM_RETRY_MS = 30_000
/**
 * The object's KV key that holds the name of the object it is, recorded at its first verified event: an alarm names no
 * object, and the one ordinary traffic reaches may since have changed. Outside the SQLite, so no dump carries it.
 */
export const OBJECT_NAME_KEY = 'fabrika:object'
/** A repair tick's time: the Worker's `scheduledTime`, digits only. */
const TICK_TIME = /^\d{1,16}$/

/** The object's alarm. On a SQLite-backed object `setAlarm` and `deleteAlarm` commit with the open transaction. */
export interface AlarmStorage {
	setAlarm(scheduledTime: number): Promise<void>
	deleteAlarm(): Promise<void>
}

/**
 * What the object needs of its `ctx.storage`; a Durable Object's `DurableObjectStorage` fits it. A test double without
 * an alarm arms none.
 */
export type ApplicationStorage = SqliteStorage & OpsStorage & Partial<AlarmStorage>

/** What the object needs of its `DurableObjectState`. */
export interface ApplicationState {
	readonly storage: ApplicationStorage & Partial<Omit<OpsRecovery, 'abort'>>
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
	waitUntil(promise: Promise<unknown>): void
	/** workerd resets the object; the test double has none. */
	abort?(reason?: string): void
}

/** `state` with every `waitUntil` promise recorded by the isolate's pending-work tracker (the ops operation `timers`). */
export function trackedState(state: ApplicationState): ApplicationState {
	const { abort } = state
	return {
		storage: state.storage,
		blockConcurrencyWhile: (callback) => state.blockConcurrencyWhile(callback),
		waitUntil: (promise) => state.waitUntil(trackPending(promise)),
		...(abort === undefined ? {} : { abort: (reason?: string) => abort.call(state, reason) }),
	}
}

/** The object's recovery when its storage and state have every member PITR needs (ADR-0070), else `null`. */
function objectRecovery(state: ApplicationState): OpsRecovery | null {
	const { storage } = state
	const { getCurrentBookmark, getBookmarkForTime, onNextSessionRestoreBookmark } = storage
	const { abort } = state
	if (getCurrentBookmark === undefined || getBookmarkForTime === undefined || onNextSessionRestoreBookmark === undefined || abort === undefined) {
		return null
	}
	return {
		getCurrentBookmark: () => getCurrentBookmark.call(storage),
		getBookmarkForTime: (time) => getBookmarkForTime.call(storage, time),
		onNextSessionRestoreBookmark: (bookmark) => onNextSessionRestoreBookmark.call(storage, bookmark),
		abort: (reason) => abort.call(state, reason),
	}
}

/**
 * The framework's bindings: IAM's application entrypoint, the Workers Assets of the SPA and the version metadata. No
 * handler sees them.
 */
const FRAMEWORK_BINDINGS: ReadonlySet<string> = new Set(['IAM', CLOUDFLARE_ASSETS_BINDING, CLOUDFLARE_VERSION_BINDING])

/** A version id is what the binding's `id` holds; anything else, or no binding (a local run), is no version. */
const WORKER_VERSION_ID = /^[A-Za-z0-9-]{1,64}$/

/** The id of the Worker version that runs, from the version metadata binding; `null` without it. */
function workerVersion(env: Readonly<Record<string, unknown>>): string | null {
	const metadata = env[CLOUDFLARE_VERSION_BINDING]
	const id: unknown = typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'id') : undefined
	return typeof id === 'string' && WORKER_VERSION_ID.test(id) ? id : null
}

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

/** The storage of the object whose event runs, and the barrier's view of that event; work it hands to `waitUntil` keeps both. */
interface ObjectScope {
	readonly storage: ApplicationStorage
	readonly event: BarrierEvent
}

const objectScope = new AsyncLocalStorage<ObjectScope>()

/** The cursors of the fenced transaction that runs: its commit checks whether any of them wrote. */
const openTransaction = new AsyncLocalStorage<SqliteCursor[]>()

function eventScope(): ObjectScope {
	const scope = objectScope.getStore()
	if (scope === undefined) {
		throw new Error('a statement ran outside any event of an application object: the framework runs every event in its object scope')
	}
	return scope
}

/** The write fence (ADR-0069 §3): a write of an invocation admitted before a restrictive transition rolls back. */
function fence(event: BarrierEvent, cursors: readonly SqliteCursor[]): void {
	if (cursors.some((cursor) => cursor.rowsWritten > 0) && !event.writable()) {
		throw new MaintenanceFenceError()
	}
}

/**
 * The storage every framework and application write on SQLite reaches, bound to the object whose event runs. The
 * fence runs inside each transaction before it commits; a statement outside one runs in a transaction of its own.
 */
function fencedStorage(): SqliteStorage {
	return {
		sql: {
			exec(query, ...bindings) {
				const { storage, event } = eventScope()
				const cursors = openTransaction.getStore()
				if (cursors !== undefined) {
					const cursor = storage.sql.exec(query, ...bindings)
					cursors.push(cursor)
					return cursor
				}
				return storage.transactionSync(() => {
					const cursor = storage.sql.exec(query, ...bindings)
					const rows = cursor.toArray()
					fence(event, [cursor])
					return { toArray: () => rows, rowsWritten: cursor.rowsWritten }
				})
			},
		},
		transaction(closure) {
			const { storage, event } = eventScope()
			// A nested transaction shares its parent's cursors, so the outer commit checks every write inside it.
			const cursors = openTransaction.getStore() ?? []
			return storage.transaction(() =>
				openTransaction.run(cursors, async () => {
					const result = await closure()
					fence(event, cursors)
					return result
				})
			)
		},
		transactionSync(closure) {
			const { storage, event } = eventScope()
			const cursors = openTransaction.getStore() ?? []
			return storage.transactionSync(() =>
				openTransaction.run(cursors, () => {
					const result = closure()
					fence(event, cursors)
					return result
				})
			)
		},
	}
}

/** Whether migrations may be applied: in `open` and the migration phase; a restricted cold start only looks. */
type MigrationPolicy = 'apply' | 'refuse'

/** What an instance's migrating boot reads and writes beside its storage: its record, its version, its bookmarks. */
interface InstanceMigration {
	readonly records: MigrationRecordStore
	readonly version: string | null
	readonly bookmark: () => Promise<string | null>
}

/** A restricted cold start found a migration to apply: the application does not boot until the operation's migrate. */
class MigrationsPending extends Error {
	override readonly name = 'MigrationsPending'
}

/** The object holds an import marker (ADR-0070 §6): it neither boots nor migrates until the import completes or is discarded. */
class ImportInProgress extends Error {
	override readonly name = 'ImportInProgress'
}

/** Whether the object holds an import marker; a storage without the synchronous KV (the bun:sqlite double) holds none. */
function importing(storage: ApplicationStorage): boolean {
	const { kv } = storage
	return kv !== undefined && importInProgress({ kv })
}

function isMigrationsPending(error: unknown): boolean {
	return error instanceof MigrationsPending || (error instanceof Error && error.cause instanceof MigrationsPending)
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

/**
 * The instance's migrating boot (ADR-0069 §3), after the isolate's boot checks: the framework's tables, then the
 * application's, in one transaction under a migration record, and `booted` before the first ordinary event. Under
 * `refuse` a pending migration throws `MigrationsPending` before anything is written. Answers the record.
 */
async function migrate(
	storage: ApplicationStorage,
	migrations: readonly ApplicationMigration[],
	policy: MigrationPolicy,
	instance: InstanceMigration,
): Promise<OpsMigrationRecord | null> {
	const result = await migratingBoot({
		target: { exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
		store: instance.records,
		bundles: migrationBundles(migrations),
		version: instance.version,
		bookmark: instance.bookmark,
		apply: policy === 'apply',
	})
	if (result.kind === 'pending') {
		throw new MigrationsPending('a migration is pending')
	}
	return await markBooted(instance.records, result.held)
}

/** The bundles the object applies, in order: the framework's tables, then the application's. */
function migrationBundles(migrations: readonly ApplicationMigration[]): readonly SqliteMigrationBundle[] {
	return [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: 'app', migrations },
	]
}

/**
 * The isolate's boot: the module and every boot check, none of which reads the database, so they all run before an
 * instance migrates (ADR-0069 §3 step 1); the data layer binds to the storage of the event that runs.
 */
async function bootApplication(
	setup: ApplicationSetup,
	state: ApplicationState,
	env: Readonly<Record<string, unknown>>,
	environment: CapturedEnvironment,
	crashes: CrashReporter | null,
): Promise<Booted> {
	const { default: implementation } = await setup.load()
	const migrates = isScopedDatabase(implementation.database)
	const database = migrates ? openSqlite(fencedStorage()) : undefined
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
		// A removed file's object outlives its row for the window, so a side restore finds its bytes (ADR-0070).
		fileRetentionMs: FILE_TOMBSTONE_RETENTION_MS,
		// The Worker forwards only with the proxy secret, which the object checked; `boot` checks it again.
		requireProxySecret: true,
		// The proxy Worker sets `X-Fabrika-Client-Ip` from `CF-Connecting-IP`, the visitor Cloudflare saw.
		clientAddress: 'vouched',
		projectWakes: (transaction) => projectWakes(setup, transaction),
		...(setup.options.approvedContract === undefined ? {} : { approvedContract: setup.options.approvedContract }),
		...(setup.options.operationsFetch === undefined ? {} : { operationsFetch: setup.options.operationsFetch }),
	})
	const booted: Booted = { app, migrates }
	if (crashes !== null && !setup.watchingRejections) {
		setup.watchingRejections = true
		reportSurvivedCrashes(setup.options.rejections ?? globalRejectionEvents(), crashes)
	}
	return booted
}

/** The isolate's booted application with this instance's storage migrated, and the instance's migration record. */
interface Attached {
	readonly booted: Booted
	readonly record: OpsMigrationRecord | null
}

/**
 * The isolate's booted application with this instance's storage migrated, or the first boot. Reports the first failure
 * of a streak as `boot_failed`, whichever instance or step it comes from; an attachment that succeeds ends the streak.
 * A pending migration and a record put that did not land are no failure.
 */
async function attach(
	setup: ApplicationSetup | null,
	state: ApplicationState,
	env: Readonly<Record<string, unknown>>,
	policy: MigrationPolicy,
	instance: InstanceMigration,
	failed: (failure: OpsBootFailureContent) => void,
): Promise<Attached> {
	if (setup === null) {
		throw new Error('no contract application is registered: the generated entrypoint calls createContractWorker before an object starts')
	}
	// Before anything loads or migrates, and no boot failure: a half-loaded import never boots.
	if (importing(state.storage)) {
		throw new ImportInProgress('import_in_progress')
	}
	const environment = captureEnvironment(Object.fromEntries(Object.entries(env).filter(([name]) => !FRAMEWORK_BINDINGS.has(name))))
	const crashes = environmentCrashReporter(environment, setup.options.operationsFetch)
	try {
		const booted = await attachOnce(setup, state, env, environment, crashes)
		const record = booted.migrates ? await migrate(state.storage, setup.options.migrations ?? [], policy, instance) : null
		setup.failureReported = false
		return { booted, record }
	} catch (error) {
		if (isMigrationsPending(error) || error instanceof RecordPending || (error instanceof MigrationFailed && error.reason === 'record_unwritable')) {
			throw error
		}
		const scrubber = environmentScrubber(environment)
		failed(bootFailure(error, scrubber))
		if (!setup.failureReported) {
			setup.failureReported = true
			logBootFailure(error, scrubber)
			if (crashes !== null) {
				state.waitUntil(crashes.report('boot_failed', error))
			}
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
	return await setup.booted
}

/**
 * The first failed boot of a streak on the log, which a local run shows where it keeps no trace: a `BootError` lists the
 * framework's own problems; anything else, which application code may have thrown, is only its code.
 */
function logBootFailure(error: unknown, scrubber: Scrubber): void {
	console.error(error instanceof BootError ? scrubber.scrub(`fabrika: ${error.message}`) : 'fabrika: the application did not boot: boot_failed')
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

/**
 * `pending`: a restricted cold start found a migration to apply, the object holds an import marker, or a migration
 * record could not be read or written, so the application did not boot; that is no failure. `migration` is what a
 * `migrate` request answers of a migrating boot that failed with a record.
 */
type Outcome =
	| { readonly booted: Booted; readonly record: OpsMigrationRecord | null }
	| { readonly failure: unknown; readonly migration: OpsMigrationFailure | null }
	/** `held`: a record could not be read or written, which the next event repeats; `migrate` answers it 503. */
	| { readonly pending: true; readonly held: boolean; readonly migration: OpsMigrationFailure | null }

/** The wait after an instance's first failed boot before an event boots again; it doubles with each failure, to the cap. */
const BOOT_RETRY_MS = 1_000
const BOOT_RETRY_CAP_MS = 60_000

/** The alarm armed at `next`, or deleted when nothing is pending; inside a transaction it commits with it. */
async function armAlarm(storage: ApplicationStorage, next: Date | null): Promise<void> {
	if (next === null) {
		await storage.deleteAlarm?.()
	} else {
		await storage.setAlarm?.(next.getTime())
	}
}

/**
 * The runtime's projection of the jobs' wakes and leases (ADR-0065 §5, I1): the store runs it in the transaction of
 * every change, and it arms the alarm of the object whose event runs from `next`. A throw rolls the change back.
 */
async function projectWakes(setup: ApplicationSetup, transaction: Session): Promise<void> {
	// A wake or lease changes only once the application booted.
	const booted = setup.booted === null ? null : await setup.booted
	const scheduler = booted?.app.jobs.scheduler ?? null
	if (scheduler !== null) {
		await armAlarm(eventScope().storage, await scheduler.next(transaction))
	}
}

/** A run the alarm took the lease for, handed to `waitUntil`; the runner logs and reports its own failures. */
async function runScheduled(scheduler: JobScheduler, job: string, fence: LeaseFence, clock: JobClock): Promise<void> {
	try {
		await scheduler.run(job, fence, { clock })
	} catch {
		console.error(`fabrika: job '${job}' did not start: driver_failed`)
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
	/** The object ordinary traffic reaches, so the one this instance is when such traffic arrives; `null` when malformed. */
	readonly #object: string | null
	/** The object this instance is, once a verified event named it or its storage recorded it (`OBJECT_NAME_KEY`). */
	#name: string | null = null
	/** The maintenance barrier, read from R2 once per instance; a failed read is not kept, so the next request reads again. */
	#barrier: Promise<MaintenanceBarrier> | null = null
	#barrierObject: string | null = null
	/** The instance's failed boot, kept in memory for the ops view until a boot succeeds. */
	#bootFailure: OpsBootFailureContent | null = null
	/** The instance's boot, `null` until the first event that needs the application: an ops request never starts it. */
	#outcome: Promise<Outcome> | null = null
	#failedBoots = 0
	/** When an event may boot again after a failed boot; until then every request answers the failure. */
	#retryAt = 0
	/** Whether this instance ran the scheduler's startup repair, which its first open event does. */
	#repaired = false
	readonly #clock: JobClock

	constructor(state: ApplicationState, env: Readonly<Record<string, unknown>>) {
		this.#state = trackedState(state)
		this.#env = env
		this.#setup = registered
		this.#clock = registered?.options.clock ?? systemClock
		const secret = env[FABRIKA_PROXY_SECRET]
		this.#secret = typeof secret === 'string' && secret !== '' ? proxySecretDigest(secret) : null
		this.#ops = opsAccess(env)
		const object = env[FABRIKA_APPLICATION_OBJECT]
		const objects = env[FABRIKA_APPLICATION_OBJECTS]
		this.#object = parseApplicationObjects(typeof object === 'string' ? object : undefined, typeof objects === 'string' ? objects : undefined)
			?.object ?? null
	}

	#contractDigest(): string | null {
		const digest = this.#env[FABRIKA_CONTRACT_DIGEST]
		return typeof digest === 'string' ? digest : null
	}

	async fetch(request: Request): Promise<Response> {
		// Another Worker on the account that binds this class reaches nothing, not even an answer that the object exists.
		if (!this.#fromWorker(request)) {
			return new Response(null, { status: 404 })
		}
		if (new URL(request.url).pathname.startsWith(OPS_PREFIX)) {
			// The mode before the request: a transition that opens the object arms its alarm, which repairs.
			let before: OpsMode | null = null
			// Served from storage alone: it never starts a boot or a retry, and waits for one under way only once authenticated.
			const response = await serveOps(request, this.#ops, {
				storage: this.#state.storage,
				bucket: this.#env[CLOUDFLARE_FILES_BINDING],
				recovery: objectRecovery(this.#state),
				contractDigest: this.#contractDigest(),
				migrations: migrationBundles(this.#setup?.options.migrations ?? []),
				bootFailure: async () => {
					await this.#outcome
					return this.#bootFailure
				},
				maintenance: async (object) => {
					const barrier = await this.#maintenance(object)
					before ??= barrier.mode
					return barrier
				},
				migrate: () => this.#migrated(),
				migrationRecords: (object) => r2MigrationRecordStore(this.#env[CLOUDFLARE_FILES_BINDING], object),
				version: workerVersion(this.#env),
			})
			if (before !== null && before !== 'open') {
				await this.#reopened()
			}
			return response
		}
		let barrier: MaintenanceBarrier
		try {
			barrier = await this.#maintenance(this.#object)
		} catch {
			// Fails closed: a state R2 could not give is never read as `open` (ADR-0069 §3, cold starts).
			return maintenanceRefusal()
		}
		if (importing(this.#state.storage)) {
			// ADR-0070 §6: whatever the mode, a half-loaded import serves nothing; the tick repairs nothing.
			return request.headers.get(TICK_HEADER) === null ? maintenanceRefusal() : new Response(null, { status: 204 })
		}
		if (barrier.mode !== 'open' && request.headers.get(TICK_HEADER) !== null) {
			// The tick repairs nothing and writes nothing until the object opens.
			return new Response(null, { status: 204 })
		}
		if (barrier.mode === 'closed' || barrier.mode === 'inspect') {
			return maintenanceRefusal()
		}
		const outcome = await this.#current(barrier.mode === 'open' ? 'apply' : 'refuse')
		if ('pending' in outcome) {
			return maintenanceRefusal()
		}
		if ('failure' in outcome) {
			throw outcome.failure
		}
		const event = barrier.event()
		return await objectScope.run({ storage: this.#state.storage, event }, () => runGated(event, () => this.#serve(outcome.booted, request)))
	}

	/** The name of the object this instance is: the one its storage recorded, or `null` before a verified event named it. */
	#recorded(): string | null {
		if (this.#name === null) {
			const stored = this.#state.storage.kv?.get(OBJECT_NAME_KEY)
			if (typeof stored === 'string' && stored !== '') {
				this.#name = stored
			}
		}
		return this.#name
	}

	/**
	 * Whether this instance is the object a verified event names; the first such event records the name, which never
	 * changes after. A storage without KV (the bun:sqlite double) keeps it in memory only.
	 */
	#named(object: string): boolean {
		const recorded = this.#recorded()
		if (recorded !== null) {
			return recorded === object
		}
		this.#state.storage.kv?.put(OBJECT_NAME_KEY, object)
		this.#name = object
		return true
	}

	/** The barrier of the object this instance is; every name it is asked under must be the same one. */
	#maintenance(object: string | null): Promise<MaintenanceBarrier> {
		if (object === null) {
			return Promise.reject(new Error(`${FABRIKA_APPLICATION_OBJECT} and ${FABRIKA_APPLICATION_OBJECTS} name no valid set of objects`))
		}
		if (!this.#named(object)) {
			return Promise.reject(new Error('this object is another object than the one the event names'))
		}
		if (this.#barrier !== null && this.#barrierObject !== object) {
			return Promise.reject(new Error('one object instance was asked under two object names'))
		}
		if (this.#barrier === null) {
			const reading = (async () => await MaintenanceBarrier.load(r2MaintenanceStore(this.#env[CLOUDFLARE_FILES_BINDING], object)))()
			this.#barrier = reading
			this.#barrierObject = object
			reading.catch(() => {
				if (this.#barrier === reading) {
					this.#barrier = null
					this.#barrierObject = null
				}
			})
		}
		return this.#barrier
	}

	/**
	 * `migrate`: starts the boot, which applies the pending migrations whatever the mode, or awaits the one under way, and
	 * answers how it ended.
	 */
	async #migrated(): Promise<OpsMigrated> {
		const current = this.#outcome === null ? null : await this.#outcome
		if (current !== null && 'booted' in current) {
			return { kind: 'booted', record: current.record }
		}
		const boot = this.#boot('apply')
		this.#outcome = boot
		const outcome = this.#settled(boot, await boot)
		if ('booted' in outcome) {
			return { kind: 'booted', record: outcome.record }
		}
		return { kind: 'pending' in outcome && outcome.held ? 'unavailable' : 'failed', migration: outcome.migration }
	}

	/** Settles either way: a callback that rejects would reset the object, and every request answers the failure instead. */
	#boot(policy: MigrationPolicy): Promise<Outcome> {
		return this.#state.blockConcurrencyWhile(async () => {
			let instance: InstanceMigration
			try {
				instance = this.#instanceMigration()
			} catch (failure) {
				return this.#failed(failure, null)
			}
			return await attach(this.#setup, this.#state, this.#env, policy, instance, (failure) => {
				this.#bootFailure = failure
			}).then(({ booted, record }): Outcome => {
				// The view reports the current boot: a failure an earlier attempt left is no longer the object's state.
				this.#bootFailure = null
				return { booted, record }
			}, (failure: unknown): Outcome => {
				const migration = failure instanceof MigrationFailed
					? { refused: 'migration_failed' as const, reason: failure.reason, record: failure.record }
					: null
				const held = failure instanceof RecordPending || migration?.reason === 'record_unwritable'
				if (held || isMigrationsPending(failure) || failure instanceof ImportInProgress) {
					return { pending: true, held, migration }
				}
				return this.#failed(failure, migration)
			})
		})
	}

	#failed(failure: unknown, migration: OpsMigrationFailure | null): Outcome {
		this.#failedBoots++
		this.#retryAt = Date.now() + Math.min(BOOT_RETRY_MS * 2 ** (this.#failedBoots - 1), BOOT_RETRY_CAP_MS)
		return { failure, migration }
	}

	/** The record of the object this instance is, which an event named before it boots; its version and bookmarks. */
	#instanceMigration(): InstanceMigration {
		const object = this.#recorded()
		if (object === null) {
			throw new Error('an object instance booted before any verified event named it')
		}
		const { storage } = this.#state
		const { getCurrentBookmark } = storage
		return {
			records: r2MigrationRecordStore(this.#env[CLOUDFLARE_FILES_BINDING], object),
			version: workerVersion(this.#env),
			bookmark: async () => (getCurrentBookmark === undefined ? null : await getCurrentBookmark.call(storage)),
		}
	}

	/**
	 * The instance's boot, started by the first event that needs it and booted again once a failed boot's backoff has
	 * passed; concurrent events share one boot and one retry. A boot that found a migration pending is not kept, so the
	 * next event looks again.
	 */
	async #current(policy: MigrationPolicy): Promise<Outcome> {
		if (this.#outcome === null) {
			this.#outcome = this.#boot(policy)
		}
		const pending = this.#outcome
		const outcome = await pending
		if ('failure' in outcome && Date.now() >= this.#retryAt) {
			if (this.#outcome === pending) {
				this.#outcome = this.#boot(policy)
			}
			return this.#settled(this.#outcome, await this.#outcome)
		}
		return this.#settled(pending, outcome)
	}

	/** Forgets a boot that found a migration pending, so the next event boots again. */
	#settled(boot: Promise<Outcome>, outcome: Outcome): Outcome {
		if ('pending' in outcome && this.#outcome === boot) {
			this.#outcome = null
		}
		return outcome
	}

	#serve(booted: Booted, request: Request): Promise<Response> {
		const scheduler = booted.app.jobs.scheduler
		const tick = request.headers.get(TICK_HEADER)
		if (tick !== null) {
			return TICK_TIME.test(tick) && Number.isSafeInteger(Number(tick)) ? this.#tick(scheduler) : Promise.resolve(new Response(null, { status: 400 }))
		}
		if (scheduler !== null && !this.#repaired) {
			this.#state.waitUntil(this.#repairOnce(scheduler))
		}
		const exec: RequestExecutionContext = { waitUntil: (promise) => this.#state.waitUntil(promise) }
		return booted.app.fetch(request, exec)
	}

	/**
	 * workerd calls it when the alarm is due (ADR-0065 §5). Only the object ordinary traffic reaches runs jobs, and only
	 * in `open`; otherwise it runs nothing and arms nothing: the maintenance operation owns the object, reopening arms the
	 * alarm again, and the repair tick arms the serving object's. It never throws, because after six failures the platform
	 * stops retrying: an internal error in `open` arms it again in `ALARM_RETRY_MS` and is reported.
	 */
	async alarm(): Promise<void> {
		let scheduler: JobScheduler | null = null
		let barrier: MaintenanceBarrier | null = null
		try {
			const object = this.#recorded()
			if (object === null || object !== this.#object) {
				// No verified event named this object yet, or it is not the one ordinary traffic reaches (a rehearsal, a
				// former serving object after a deploy moved the traffic): it runs no job.
				return
			}
			if (importing(this.#state.storage)) {
				// A half-loaded import runs no job and arms nothing; the repair tick arms the alarm once the object boots.
				return
			}
			barrier = await this.#maintenance(object)
			if (barrier.mode !== 'open') {
				return
			}
			const outcome = await this.#current('apply')
			if (!('booted' in outcome)) {
				throw new Error('the application did not boot')
			}
			const booted = outcome.booted.app.jobs.scheduler
			scheduler = booted
			if (booted === null) {
				return
			}
			const event = barrier.event()
			await objectScope.run({ storage: this.#state.storage, event }, () => runGated(event, () => this.#wake(booted, event)))
		} catch (error) {
			if (error instanceof MaintenanceFenceError || barrier === null || barrier.mode !== 'open') {
				// A transition restricted the object meanwhile, or none was ever read: no failure, and nothing is armed outside open.
				return
			}
			console.error('fabrika: the alarm failed: alarm_failed')
			try {
				await this.#state.storage.setAlarm?.(Date.now() + ALARM_RETRY_MS)
			} catch {
				console.error('fabrika: the alarm could not be armed again; the repair tick arms it')
			}
			if (scheduler !== null) {
				this.#state.waitUntil(scheduler.failed('alarm', error))
			}
		}
	}

	/**
	 * One alarm: per job, in one transaction, a crashed holder reaped, the lease taken for a due wake (or the pending flag
	 * set for the run holding it) and the alarm armed from the projection. The runs go to `waitUntil`: one alarm runs at a
	 * time, and awaiting a long job would hold back every other wake. No wake is consumed here, only by its run's finish.
	 */
	async #wake(scheduler: JobScheduler, event: BarrierEvent): Promise<void> {
		await this.#repairOnce(scheduler)
		const early = await scheduler.earlyBy(ALARM_SLACK_MS)
		if (early > 0) {
			await this.#clock.wait(early, new AbortController().signal)
		}
		const storage = fencedStorage()
		// A job whose lease is held past its expiry but which the contract no longer declares is reaped too.
		for (const job of [...scheduler.jobs, ...(await scheduler.orphans())]) {
			if (!event.writable()) {
				// A transition restricted the object since the alarm was admitted; reopening arms it again.
				return
			}
			const taken = await storage.transaction(async () => {
				const taken = await scheduler.take(job)
				await armAlarm(eventScope().storage, await scheduler.next())
				return taken
			})
			if (taken.reaped) {
				this.#state.waitUntil(scheduler.crashed(job))
			}
			if (taken.fence !== null) {
				this.#state.waitUntil(runScheduled(scheduler, job, taken.fence, this.#clock))
			}
		}
	}

	/** The startup repair once per instance, at its first open event; a failure is reported and the next event repairs. */
	async #repairOnce(scheduler: JobScheduler): Promise<void> {
		if (this.#repaired) {
			return
		}
		try {
			this.#repaired = await scheduler.repair()
		} catch (error) {
			this.#repairFailed(scheduler, error)
		}
	}

	/** A repair the write fence refused is no failure: a transition closed the object, and reopening repairs. */
	#repairFailed(scheduler: JobScheduler, error: unknown): void {
		if (error instanceof MaintenanceFenceError) {
			return
		}
		console.error("fabrika: the job scheduler's repair failed: repair_failed")
		this.#state.waitUntil(scheduler.failed('repair', error))
	}

	/** The repair tick: the startup repair again, which also arms the first alarm of an environment nobody has called. */
	async #tick(scheduler: JobScheduler | null): Promise<Response> {
		if (scheduler === null) {
			return new Response(null, { status: 204 })
		}
		try {
			this.#repaired = (await scheduler.repair()) || this.#repaired
		} catch (error) {
			this.#repairFailed(scheduler, error)
			return new Response(null, { status: error instanceof MaintenanceFenceError ? 503 : 500 })
		}
		return new Response(null, { status: 204 })
	}

	/** After a transition that opened this object, its alarm fires at once and repairs: an alarm outside `open` armed nothing. */
	async #reopened(): Promise<void> {
		if (this.#barrier === null || this.#barrierObject !== this.#object) {
			return
		}
		try {
			if ((await this.#barrier).mode !== 'open') {
				return
			}
			this.#repaired = false
			await this.#state.storage.setAlarm?.(Date.now())
		} catch {
			console.error('fabrika: the alarm could not be armed after the object opened; the repair tick arms it')
		}
	}

	/** The fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks. */
	#fromWorker(request: Request): boolean {
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return this.#secret !== null && presented !== '' && timingSafeEqual(proxySecretDigest(presented), this.#secret)
	}
}
