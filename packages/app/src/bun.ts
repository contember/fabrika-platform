// ─── Bun process adapter ─────────────────────────────────────────────
//
// A long-running Bun process needs only request dispatch and explicit draining.
// It does not emulate Worker cron, queues, or passThroughOnException(). A
// contract application is served through `serveContract`, from the generated
// entrypoint.

import { HttpIamMembership, HttpIamTerminals } from '@fabrika/auth'
import type { Database } from '@fabrika/db'
import { isScopedDatabase, type Session } from '@fabrika/db/framework'
import type { PostgresOptions } from '@fabrika/db/postgres'
import type { EmailProviderRegistry } from '@fabrika/email'
import { directoryEmailProvider } from '@fabrika/email/directory'
import { parseJwks } from '@fabrika/jwks'
import type { FileObjectStore } from '@fabrika/platform'
import { applicationRuntimeUrl, S3BlobStore } from '@fabrika/platform-node'
import { lookup } from 'node:dns/promises'
import { diskAssets } from './disk-assets.js'
import type { FetchService, RequestExecutionContext } from './fetch.js'
import { clamscanScanner } from './files/clamscan.js'
import { boot, BootError, type IamKeySource } from './implement/boot.js'
import { REQUEST_BUDGET_MS } from './implement/bounded.js'
import { type CrashEvents, environmentCrashReporter, type ProcessCrashKind, reportFatalCrashes, reportWithin } from './implement/crashes.js'
import { type CapturedEnvironment, captureEnvironment } from './implement/environment.js'
import { type ContractImplementation, isContractImplementation } from './implement/implement.js'
import { issuerWorkloadTokens, type WorkloadTokenSource } from './implement/workload.js'
import { type ContractJobs, JOB_CHECK_INTERVAL_MS, type JobRunOptions, type JobRunResult } from './jobs/runner.js'
import { makeProcessUndumpable } from './undumpable.js'

export { diskAssets } from './disk-assets.js'
export { clamscanArguments, type ClamscanOptions, clamscanScanner } from './files/clamscan.js'

export { markProductionProcess } from '@fabrika/db/production'

/** The local stack's capture: boot honours it only under a loopback issuer, and the stack names it with `FABRIKA_EMAIL_PROVIDER`. */
const LOCAL_EMAIL_PROVIDERS = { directory: directoryEmailProvider } satisfies EmailProviderRegistry

export interface ManagedBunHandlerOptions {
	/** Required sink for rejected background tasks. Do not log raw errors or secret-bearing values. */
	onBackgroundError(error: unknown): void
	executionContext?: never
}

export interface ExternalBunHandlerOptions {
	/** Existing supervised process context. Its owner remains responsible for draining it. */
	executionContext: RequestExecutionContext
	onBackgroundError?: never
}

export type BunHandlerOptions = ManagedBunHandlerOptions | ExternalBunHandlerOptions

export interface BunHandler {
	fetch(request: Request): Promise<Response>
	/** Wait until every task registered through `waitUntil()` has settled. */
	drain(): Promise<void>
}

export function createBunHandler<Env>(app: FetchService<Env>, env: Env, options: BunHandlerOptions): BunHandler {
	if (options.executionContext !== undefined) {
		return {
			fetch: (request) => app.fetch(request, env, options.executionContext),
			drain: () => Promise.resolve(),
		}
	}

	const pending = new Set<Promise<void>>()

	const exec: RequestExecutionContext = {
		waitUntil(promise) {
			const tracked = promise.then(
				() => undefined,
				(error) => {
					try {
						options.onBackgroundError(error)
					} catch {
						// Draining must remain reliable even if the reporting hook fails.
					}
				},
			)
			pending.add(tracked)
			void tracked.then(() => pending.delete(tracked))
		},
	}

	return {
		fetch: (request) => app.fetch(request, env, exec),
		async drain() {
			while (pending.size > 0) {
				await Promise.all(pending)
			}
		},
	}
}

// ─── Contract applications ───────────────────────────────────────────

/** IAM's public key set at the issuer's `/.well-known/jwks.json`, for a process with no IAM binding. */
export function issuerJwks(issuer: unknown): IamKeySource {
	return {
		async getJwks() {
			if (typeof issuer !== 'string') {
				throw new Error('FABRIKA_IAM_ISSUER is not set')
			}
			const response = await fetch(new URL('/.well-known/jwks.json', issuer), { headers: { accept: 'application/json' } })
			const jwks = response.ok ? parseJwks(await response.json()) : null
			if (jwks === null) {
				throw new Error('the issuer published no usable key set')
			}
			return jwks
		},
	}
}

export interface ContractServer {
	/** The port the server listens on; `PORT=0` picks a free one. */
	readonly port: number
	/** Stops accepting requests and waits for the ones in flight. */
	stop(): Promise<void>
}

/**
 * What the adapter takes from `@fabrika/db` before the application loads, so no application module can stand in for
 * it: a replaced `openPostgres` would receive the database URL.
 */
interface DataLayerOpeners {
	readonly postgres: (options: PostgresOptions) => Database
	readonly applicationSchema: (appId: string) => string
}

/** Loads `@fabrika/db` before the application: it captures its built-ins and freezes the Kysely compiler at load. */
async function loadDataLayer(): Promise<DataLayerOpeners> {
	const [{ applicationSchema }, { openPostgres }] = await Promise.all([import('@fabrika/db'), import('@fabrika/db/postgres')])
	return { postgres: openPostgres, applicationSchema }
}

/** How long a stopping process waits for the work its requests left running; a kicked run aborts at once. */
const SHUTDOWN_DRAIN_MS = 10_000

/**
 * How long the wake timer waits for a wake that is already due: such a wake's own kick is under way (the post-commit start,
 * or the timer's last one), and looking at once would kick its job a second time before that kick took the lease.
 */
export const WAKE_RETRY_MS = 1_000

/**
 * How long after a write projected the timer a refresh that cannot see the projected wake looks again: the write may still
 * be committing, and no transaction that writes a wake outlasts a request's budget.
 */
export const WAKE_SETTLE_MS = REQUEST_BUDGET_MS + 5_000

/** A wake a write of this process projected and no refresh has seen yet: its time, and until when the timer looks for it. */
interface UnseenWake {
	readonly at: number
	readonly until: number
	/** The next look's wait: it doubles from `WAKE_RETRY_MS`. */
	readonly retry: number
}

/**
 * The serving process's one timer to the jobs' next wake, Bun's side of the scheduler (ADR-0065 §5): it kicks each job
 * whose wake came due through the kick path, so the lease admits one container. A write of this process lowers it in
 * that write's transaction (`project`, `BootOptions.projectWakes`), by the delay on the database's clock; a wake another
 * container wrote is found when the serving process refreshes it with its job check. Crontab still runs the schedule.
 */
export class WakeTimer {
	readonly #track: (kick: Promise<void>) => void
	#jobs: ContractJobs | null = null
	#timer: ReturnType<typeof setTimeout> | undefined
	/** When the armed timer fires, in epoch milliseconds; `Infinity` while none is armed. */
	#at = Number.POSITIVE_INFINITY
	#stopped = false
	/** The refresh under way: one at a time, and a refresh asked for meanwhile looks again after the retry wait. */
	#refreshing: Promise<void> | null = null
	#again = false
	#unseen: UnseenWake | null = null

	/** `track` holds each kick the timer starts until it ended, for the shutdown drain. */
	constructor(track: (kick: Promise<void>) => void) {
		this.#track = track
	}

	/** The booted application's jobs; until then nothing fires. */
	attach(jobs: ContractJobs): void {
		this.#jobs = jobs
	}

	/**
	 * `BootOptions.projectWakes`: never later than the next wake the write leaves, which a rollback only makes early. The
	 * timer may fire before the write commits, so the wake stays unseen until a refresh finds it.
	 */
	readonly project = async (transaction: Session): Promise<void> => {
		const delay = await this.#jobs?.scheduler?.untilNext(transaction)
		if (delay === undefined || delay === null || this.#stopped) {
			return
		}
		const now = Date.now()
		this.#unseen = { at: Math.min(now + delay, this.#unseen?.at ?? Number.POSITIVE_INFINITY), until: now + WAKE_SETTLE_MS, retry: WAKE_RETRY_MS }
		this.#lower(now + delay)
	}

	/** Kicks every job whose wake is due and arms the timer at the next one; it never rejects. */
	refresh(): Promise<void> {
		if (this.#stopped) {
			return Promise.resolve()
		}
		if (this.#refreshing !== null) {
			this.#again = true
			return this.#refreshing
		}
		const refreshing = this.#refresh().finally(() => {
			this.#refreshing = null
			if (this.#again) {
				this.#again = false
				this.#lower(Date.now())
			}
		})
		this.#refreshing = refreshing
		return refreshing
	}

	async #refresh(): Promise<void> {
		const jobs = this.#jobs
		if (jobs === null) {
			return
		}
		clearTimeout(this.#timer)
		this.#at = Number.POSITIVE_INFINITY
		const unseen = this.#unseen
		this.#unseen = null
		let delay: number | null
		try {
			delay = await jobs.wake(this.#track)
		} catch {
			// A driver error may quote the database URL.
			console.error('fabrika: the wake timer could not read the jobs: driver_failed')
			delay = 0
		}
		const now = Date.now()
		// A projected wake this refresh did not find: its write may not have committed yet.
		if (unseen !== null && (delay === null || now + delay > unseen.at + WAKE_RETRY_MS) && now < unseen.until) {
			this.#keepUnseen(unseen)
			this.#lower(now + unseen.retry)
		}
		if (delay !== null) {
			this.#lower(now + delay)
		}
	}

	/** Keeps looking for `unseen`, later next time, beside what writes projected during the refresh. */
	#keepUnseen(unseen: UnseenWake): void {
		const later = this.#unseen
		this.#unseen = {
			at: Math.min(unseen.at, later?.at ?? Number.POSITIVE_INFINITY),
			until: Math.max(unseen.until, later?.until ?? 0),
			retry: unseen.retry * 2,
		}
	}

	/** Fires no more and refreshes no more; resolves once a refresh under way ended, so it starts no kick after it. */
	async stop(): Promise<void> {
		this.#stopped = true
		clearTimeout(this.#timer)
		await this.#refreshing
	}

	#lower(next: number): void {
		const now = Date.now()
		const at = next <= now ? now + WAKE_RETRY_MS : next
		if (this.#stopped || at >= this.#at) {
			return
		}
		clearTimeout(this.#timer)
		this.#at = at
		this.#timer = setTimeout(() => void this.refresh(), at - now)
	}
}

/** Waits for `drain`, at most `ms`; a drain the bound cuts short is logged. */
async function drainWithin(drain: Promise<void>, ms: number): Promise<void> {
	const expired = Promise.withResolvers<void>()
	const timer = setTimeout(() => {
		console.error(`fabrika: the shutdown drain ended after ${ms / 1000} s with background work still running`)
		expired.resolve()
	}, ms)
	try {
		await Promise.race([drain, expired.promise])
	} finally {
		clearTimeout(timer)
	}
}

/** The provisioning credential the platform writes; only the launcher reads it, and the application's process never holds it. */
const PROVISIONING_DATABASE_URL = 'FABRIKA_APP_DATABASE_URL'
/** The runtime role's credential, which the launcher derives and hands the application's process in its place. */
const RUNTIME_DATABASE_URL = 'FABRIKA_APP_RUNTIME_DATABASE_URL'

/** The most connections one process opens, as the platform sized it from the database's limit (ADR-0043). */
const DATABASE_CONNECTIONS = 'FABRIKA_APP_DATABASE_CONNECTIONS'
/** Without one (a deploy by an older platform, the local stack): the size every process had before the platform sized it. */
const DEFAULT_DATABASE_CONNECTIONS = 10
const MAX_DATABASE_CONNECTIONS = 100

/** The pool size the platform wrote, the default without one, or null for a value that is no count in range. */
function databaseConnections(value: string | undefined): number | null {
	if (value === undefined) return DEFAULT_DATABASE_CONNECTIONS
	const count = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN
	return count <= MAX_DATABASE_CONNECTIONS ? count : null
}

/**
 * The application's connection: its runtime role `run_<FABRIKA_APP_ID>`, whose URL the launcher derived from the
 * provisioning credential, on the schema `app_<FABRIKA_APP_ID>` its migrations created, with at most
 * `FABRIKA_APP_DATABASE_CONNECTIONS` connections. A URL is a credential, so no message quotes it.
 */
function openApplicationDatabase(data: DataLayerOpeners, framework: Readonly<Record<string, string>>): Database {
	const url = framework[RUNTIME_DATABASE_URL] ?? ''
	const appId = framework['FABRIKA_APP_ID'] ?? ''
	const connections = framework[DATABASE_CONNECTIONS]
	const problems: string[] = []
	if (url.trim() === '') {
		problems.push('FABRIKA_APP_DATABASE_URL is not set; the platform writes it for an application with a database')
	}
	let schema = ''
	try {
		schema = data.applicationSchema(appId)
	} catch {
		problems.push(`FABRIKA_APP_ID '${appId}' is not an application id (allowed: lowercase letters, digits and -, at most 59)`)
	}
	const max = databaseConnections(connections)
	if (max === null) {
		problems.push(`${DATABASE_CONNECTIONS} '${connections ?? ''}' is not a number of connections (allowed: 1 to ${MAX_DATABASE_CONNECTIONS})`)
	}
	if (problems.length > 0 || max === null) {
		throw new BootError(problems)
	}
	return data.postgres({ url, schema, max })
}

/**
 * Whether this process holds the provisioning credential: then it is the launcher, and the application never runs in
 * it. The application's process gets the runtime credential instead.
 */
function holdsProvisioningCredential(env: Readonly<Record<string, string | undefined>>): boolean {
	return (env[PROVISIONING_DATABASE_URL] ?? '') !== ''
}

const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

/**
 * The launcher: before any application module loads, derives the runtime role's credential from the provisioning one
 * and runs this same command again with an environment that carries the runtime credential and not the provisioning
 * one, so neither the application's process nor anything it spawns can read the latter, `/proc/self/environ`
 * included; the launcher makes itself non-dumpable first, so its own `/proc/<pid>/environ` is not readable either. Stdio is inherited, signals are forwarded, and the child's exit becomes this process's.
 */
async function relaunchAsRuntime(env: Readonly<Record<string, string | undefined>>): Promise<never> {
	let runtimeUrl: string
	try {
		runtimeUrl = applicationRuntimeUrl(env[PROVISIONING_DATABASE_URL] ?? '', env['FABRIKA_APP_ID'] ?? '')
	} catch {
		throw new BootError([
			'FABRIKA_APP_DATABASE_URL is not a connection URL with a password, or FABRIKA_APP_ID is not an application id; the runtime role derives its credential from both',
		])
	}
	const environment: Record<string, string> = {}
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && name !== PROVISIONING_DATABASE_URL) environment[name] = value
	}
	environment[RUNTIME_DATABASE_URL] = runtimeUrl
	// Otherwise the application could read this process's environment, the provisioning credential in it, through /proc.
	makeProcessUndumpable()
	const child = Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
		env: environment,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	for (const signal of FORWARDED_SIGNALS) {
		process.on(signal, () => child.kill(signal))
	}
	await child.exited
	if (child.signalCode !== null) {
		for (const signal of FORWARDED_SIGNALS) process.removeAllListeners(signal)
		process.kill(process.pid, child.signalCode)
	}
	process.exit(child.exitCode ?? 1)
}

const STORAGE_VARIABLES = {
	endpoint: 'FABRIKA_APP_STORAGE_ENDPOINT',
	bucket: 'FABRIKA_APP_STORAGE_BUCKET',
	accessKeyId: 'FABRIKA_APP_STORAGE_ACCESS_KEY_ID',
	secretAccessKey: 'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY',
} as const

/**
 * The stored files' object storage (Zerops object storage, path-style), when the platform wrote its variables;
 * a partial set stops the boot. The credentials are never quoted in a message.
 */
export function openFileStorage(framework: Readonly<Record<string, string>>): FileObjectStore | undefined {
	const value = (name: string) => framework[name]?.trim() ?? ''
	const names = Object.values(STORAGE_VARIABLES)
	const missing = names.filter((name) => value(name) === '')
	if (missing.length === names.length) {
		return undefined
	}
	if (missing.length > 0) {
		throw new BootError(missing.map((name) => `${name} is not set; the platform writes every FABRIKA_APP_STORAGE_* variable together`))
	}
	return S3BlobStore.connect({
		endpoint: value(STORAGE_VARIABLES.endpoint),
		bucket: value(STORAGE_VARIABLES.bucket),
		accessKeyId: value(STORAGE_VARIABLES.accessKeyId),
		secretAccessKey: value(STORAGE_VARIABLES.secretAccessKey),
		region: 'us-east-1',
		virtualHostedStyle: false,
	})
}

/**
 * IAM's membership transport, when the platform gives the process `FABRIKA_IAM_RPC_URL` (IAM's public origin) and
 * `FABRIKA_IAM_RPC_KEY` (this environment's membership transport key); without both, there is none, and `boot` refuses
 * a contract that needs one. The identifications at a terminal travel on the same transport.
 */
function httpIamTransport(framework: Readonly<Record<string, string>>): { readonly origin: string; readonly key: string } | undefined {
	const origin = framework['FABRIKA_IAM_RPC_URL']?.trim() ?? ''
	const key = framework['FABRIKA_IAM_RPC_KEY']?.trim() ?? ''
	return origin === '' || key === '' ? undefined : { origin, key }
}

function httpMembership(framework: Readonly<Record<string, string>>): HttpIamMembership | undefined {
	const transport = httpIamTransport(framework)
	return transport === undefined ? undefined : new HttpIamMembership(transport)
}

function httpTerminals(framework: Readonly<Record<string, string>>): HttpIamTerminals | undefined {
	const transport = httpIamTransport(framework)
	return transport === undefined ? undefined : new HttpIamTerminals(transport)
}

/** IAM's public token exchange, at the issuer every deploy names; `boot` reports a missing issuer itself. */
function workloadTokensOf(framework: Readonly<Record<string, string>>): WorkloadTokenSource | undefined {
	const issuer = framework['FABRIKA_IAM_ISSUER']?.trim() ?? ''
	return issuer === '' ? undefined : issuerWorkloadTokens(issuer)
}

/** The application module, imported only after the environment was captured: the generated entrypoint's `import()`. */
export type ImplementationLoader = () => Promise<{ readonly default: ContractImplementation }>

export interface ContractServerOptions {
	/** Where the process hears of an uncaught exception or an unhandled rejection; `process` by default. */
	readonly crashes?: CrashEvents
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
}

/** The process's own crash events: listening suppresses Bun's default, so `failAsBefore` restores it. */
function processCrashEvents(): CrashEvents {
	return {
		listen(listener) {
			const exception = (error: unknown) => listener('uncaught_exception', error)
			const rejection = (reason: unknown) => listener('unhandled_rejection', reason)
			process.on('uncaughtException', exception)
			process.on('unhandledRejection', rejection)
			return () => {
				process.off('uncaughtException', exception)
				process.off('unhandledRejection', rejection)
			}
		},
	}
}

/** Raised again with no listener left: Bun prints it and exits with 1, exactly as without a report. */
function failAsBefore(kind: ProcessCrashKind, error: unknown): void {
	if (kind === 'unhandled_rejection') {
		void Promise.reject(error)
		return
	}
	setTimeout(() => {
		throw error
	})
}

/**
 * Captures the framework's variables and scrubs them from the process, then imports the application, boots it and
 * serves it on `PORT` (default 3000), on every interface: the project's private network is how the proxy reaches
 * it. Called only by the generated entrypoint, with `process.env`. SIGTERM drains. Given the provisioning credential,
 * it is the launcher instead: it never loads the application and re-runs the entrypoint as the runtime role.
 * With an Operations DSN, a startup that throws is reported before it is rethrown, and so is a crash once it serves.
 */
export async function serveContract(
	load: ImplementationLoader,
	env: Readonly<Record<string, string | undefined>>,
	options: ContractServerOptions = {},
): Promise<ContractServer> {
	if (holdsProvisioningCredential(env)) {
		return relaunchAsRuntime(env)
	}
	const environment = captureEnvironment(env)
	const crashes = environmentCrashReporter(environment, options.operationsFetch)
	let server: ContractServer
	try {
		server = await startContractServer(load, environment, options.operationsFetch)
	} catch (error) {
		if (crashes !== null) {
			await reportWithin(crashes, 'boot_failed', error)
		}
		throw error
	}
	if (crashes === null) {
		return server
	}
	const stopListening = reportFatalCrashes({ events: options.crashes ?? processCrashEvents(), reporter: crashes, fail: failAsBefore })
	return {
		port: server.port,
		stop: () => {
			stopListening()
			return server.stop()
		},
	}
}

async function startContractServer(
	load: ImplementationLoader,
	environment: CapturedEnvironment,
	operationsFetch: ContractServerOptions['operationsFetch'],
): Promise<ContractServer> {
	const port = Number.parseInt(environment.application['PORT'] === undefined ? '3000' : String(environment.application['PORT']), 10)
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('PORT must be an integer between 0 and 65535')
	}
	const data = await loadDataLayer()
	const { default: app } = await load()
	const iam = issuerJwks(environment.framework['FABRIKA_IAM_ISSUER'])
	const database = isScopedDatabase(app.database) ? openApplicationDatabase(data, environment.framework) : undefined
	const membership = httpMembership(environment.framework)
	const terminals = httpTerminals(environment.framework)
	// Zerops is where a Bun application runs, and a namespace there is one private network (ADR-0022 rule 5).
	const files = openFileStorage(environment.framework)
	const workloadTokens = workloadTokensOf(environment.framework)
	const timerKicks = new Set<Promise<void>>()
	const wakes = new WakeTimer((kick) => {
		timerKicks.add(kick)
		void kick.finally(() => timerKicks.delete(kick))
	})
	const served = boot(app, {
		environment,
		iam,
		assets: diskAssets(process.cwd()),
		database,
		files,
		membership,
		terminals,
		workloadTokens,
		resolveHost,
		requireProxySecret: true,
		localEmailProviders: LOCAL_EMAIL_PROVIDERS,
		connections: databaseConnections(environment.framework[DATABASE_CONNECTIONS]) ?? DEFAULT_DATABASE_CONNECTIONS,
		projectWakes: wakes.project,
		...(operationsFetch === undefined ? {} : { operationsFetch }),
	})
	wakes.attach(served.jobs)
	// The work a request leaves running (a failure's report, a kicked run) is drained, within a bound, before the database closes.
	const handler = createBunHandler({ fetch: (request, _env: undefined, exec) => served.fetch(request, exec) }, undefined, {
		onBackgroundError: () => console.error('fabrika: a background task of a request failed'),
	})
	const server = Bun.serve({ port, hostname: '0.0.0.0', fetch: (request) => handler.fetch(request) })
	// The crontab may never fire; the serving process notices a job that stopped succeeding without being invoked, and a
	// wake another container wrote.
	const check = () => {
		void served.jobs.check()
		void wakes.refresh()
	}
	const checks = served.jobs.names.length === 0 ? undefined : setInterval(check, JOB_CHECK_INTERVAL_MS)
	if (checks !== undefined) {
		check()
	}
	const stop = async (): Promise<void> => {
		clearInterval(checks)
		// Before the kicks stop and the drain takes the timer's kicks: a refresh under way may still start one.
		await drainWithin(wakes.stop(), SHUTDOWN_DRAIN_MS)
		served.stopKicks()
		await server.stop(false)
		await drainWithin(Promise.all([handler.drain(), ...timerKicks]).then(() => undefined), SHUTDOWN_DRAIN_MS)
		await database?.close()
	}
	process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
	return { port: server.port ?? port, stop }
}

/**
 * Every address `hostname` resolves to, as the operating system's resolver answers Bun's own `fetch`: a cron job's public
 * egress refuses a hop whose name resolves to any private one (ADR-0071).
 */
const resolveHost = async (hostname: string): Promise<readonly string[]> =>
	(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

/** The application module at `path`, imported when the loader runs; its default export must be what `serve` returned. */
export function implementationAt(path: string): ImplementationLoader {
	return async () => {
		const module: unknown = await import(path)
		const value = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
		if (!isContractImplementation(value)) {
			throw new BootError([`${path} does not default-export serve(contract, { … })`])
		}
		return { default: value }
	}
}

/**
 * One run of the job `name` (`fabrika job run <name>`, the crontab's command): the framework's variables are captured
 * and scrubbed before the application loads, exactly as `serveContract` does, then `boot` binds the job and the run
 * takes its lease. The connection closes when the run ends. Given the provisioning credential, it re-runs the command
 * as the runtime role, as `serveContract` does.
 */
export async function runContractJob(
	load: ImplementationLoader,
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	options: JobRunOptions = {},
): Promise<JobRunResult> {
	if (holdsProvisioningCredential(env)) {
		return relaunchAsRuntime(env)
	}
	const environment = captureEnvironment(env)
	const data = await loadDataLayer()
	const { default: app } = await load()
	const iam = issuerJwks(environment.framework['FABRIKA_IAM_ISSUER'])
	const database = isScopedDatabase(app.database) ? openApplicationDatabase(data, environment.framework) : undefined
	try {
		const workloadTokens = workloadTokensOf(environment.framework)
		const membership = httpMembership(environment.framework)
		const terminals = httpTerminals(environment.framework)
		const files = openFileStorage(environment.framework)
		return await boot(app, {
			environment,
			iam,
			assets: diskAssets(process.cwd()),
			database,
			files,
			membership,
			terminals,
			workloadTokens,
			resolveHost,
			requireProxySecret: true,
			localEmailProviders: LOCAL_EMAIL_PROVIDERS,
			// ClamAV on PATH, as the provider's build installs it for a `scan: true` file kind; missing, the scan fails closed.
			scanner: clamscanScanner(),
		})
			.jobs.run(name, options)
	} finally {
		await database?.close()
	}
}
