// ─── Bun process adapter ─────────────────────────────────────────────
//
// A long-running Bun process needs only request dispatch and explicit draining.
// It does not emulate Worker cron, queues, or passThroughOnException(). A
// contract application is served through `serveContract`, from the generated
// entrypoint.

import { HttpIamMembership } from '@fabrika/auth'
import { rawRequestTarget } from '@fabrika/auth-core'
import type { Database, PostgresOptions } from '@fabrika/db'
import { isScopedDatabase } from '@fabrika/db/framework'
import { parseJwks } from '@fabrika/jwks'
import type { FileObjectStore } from '@fabrika/platform'
import { applicationRuntimeUrl, S3BlobStore } from '@fabrika/platform-node'
import { join, resolve, sep } from 'node:path'
import type { FetchService, RequestExecutionContext } from './fetch.js'
import { boot, BootError, type IamKeySource } from './implement/boot.js'
import type { SpaAssets } from './implement/dispatch.js'
import { captureEnvironment } from './implement/environment.js'
import { type ContractImplementation, isContractImplementation } from './implement/implement.js'
import { issuerWorkloadTokens, type WorkloadTokenSource } from './implement/workload.js'
import { JOB_CHECK_INTERVAL_MS, type JobRunOptions, type JobRunResult } from './jobs/runner.js'
import { makeProcessUndumpable } from './undumpable.js'

export { markProductionProcess } from '@fabrika/db/production'

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

/** Serves each SPA mount from its build directory under `root`; a path that names no file gets the SPA's `index.html`. */
export function diskAssets(root: string): SpaAssets {
	return {
		async serve(mount, request) {
			const dir = resolve(root, mount.dir)
			const pathname = rawRequestTarget(request.url).pathname
			const relative = mount.prefix === '/' ? pathname.slice(1) : pathname.slice(mount.prefix.length + 1)
			// The path is canonical, so every segment decodes and none is `.` or `..`.
			const file = join(dir, ...relative.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment)))
			const candidate = file.startsWith(`${dir}${sep}`) ? Bun.file(file) : null
			const served = candidate !== null && (await candidate.exists()) ? candidate : Bun.file(join(dir, 'index.html'))
			if (!(await served.exists())) {
				return new Response('Not found', { status: 404 })
			}
			return new Response(served)
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
 * it: a replaced `Database.postgres` would receive the database URL.
 */
interface DataLayerOpeners {
	readonly postgres: (options: PostgresOptions) => Database
	readonly applicationSchema: (appId: string) => string
}

/** Loads `@fabrika/db` before the application: it captures its built-ins and freezes the Kysely compiler at load. */
async function loadDataLayer(): Promise<DataLayerOpeners> {
	const { Database, applicationSchema } = await import('@fabrika/db')
	return { postgres: Database.postgres, applicationSchema }
}

/** The provisioning credential the platform writes; only the launcher reads it, and the application's process never holds it. */
const PROVISIONING_DATABASE_URL = 'FABRIKA_APP_DATABASE_URL'
/** The runtime role's credential, which the launcher derives and hands the application's process in its place. */
const RUNTIME_DATABASE_URL = 'FABRIKA_APP_RUNTIME_DATABASE_URL'

/**
 * The application's connection: its runtime role `run_<FABRIKA_APP_ID>`, whose URL the launcher derived from the
 * provisioning credential, on the schema `app_<FABRIKA_APP_ID>` its migrations created. A URL is a credential, so no
 * message quotes it.
 */
function openApplicationDatabase(data: DataLayerOpeners, framework: Readonly<Record<string, string>>): Database {
	const url = framework[RUNTIME_DATABASE_URL] ?? ''
	const appId = framework['FABRIKA_APP_ID'] ?? ''
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
	if (problems.length > 0) {
		throw new BootError(problems)
	}
	return data.postgres({ url, schema })
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
 * The file collections' object storage (Zerops object storage, path-style), when the platform wrote its variables;
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
 * a contract that needs one.
 */
function httpMembership(framework: Readonly<Record<string, string>>): HttpIamMembership | undefined {
	const origin = framework['FABRIKA_IAM_RPC_URL']?.trim() ?? ''
	const key = framework['FABRIKA_IAM_RPC_KEY']?.trim() ?? ''
	return origin === '' || key === '' ? undefined : new HttpIamMembership({ origin, key })
}

/** IAM's public token exchange, at the issuer every deploy names; `boot` reports a missing issuer itself. */
function workloadTokensOf(framework: Readonly<Record<string, string>>): WorkloadTokenSource | undefined {
	const issuer = framework['FABRIKA_IAM_ISSUER']?.trim() ?? ''
	return issuer === '' ? undefined : issuerWorkloadTokens(issuer)
}

/** The application module, imported only after the environment was captured: the generated entrypoint's `import()`. */
export type ImplementationLoader = () => Promise<{ readonly default: ContractImplementation }>

/**
 * Captures the framework's variables and scrubs them from the process, then imports the application, boots it and
 * serves it on `PORT` (default 3000), on every interface: the project's private network is how the proxy reaches
 * it. Called only by the generated entrypoint, with `process.env`. SIGTERM drains. Given the provisioning credential,
 * it is the launcher instead: it never loads the application and re-runs the entrypoint as the runtime role.
 */
export async function serveContract(load: ImplementationLoader, env: Readonly<Record<string, string | undefined>>): Promise<ContractServer> {
	if (holdsProvisioningCredential(env)) {
		return relaunchAsRuntime(env)
	}
	const environment = captureEnvironment(env)
	const port = Number.parseInt(environment.application['PORT'] === undefined ? '3000' : String(environment.application['PORT']), 10)
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('PORT must be an integer between 0 and 65535')
	}
	const data = await loadDataLayer()
	const { default: app } = await load()
	const iam = issuerJwks(environment.framework['FABRIKA_IAM_ISSUER'])
	const database = isScopedDatabase(app.database) ? openApplicationDatabase(data, environment.framework) : undefined
	const membership = httpMembership(environment.framework)
	// Zerops is where a Bun application runs, and a namespace there is one private network (ADR-0022 rule 5).
	const files = openFileStorage(environment.framework)
	const workloadTokens = workloadTokensOf(environment.framework)
	const served = boot(app, {
		environment,
		iam,
		assets: diskAssets(process.cwd()),
		database,
		files,
		membership,
		workloadTokens,
		requireProxySecret: true,
	})
	const server = Bun.serve({ port, hostname: '0.0.0.0', fetch: (request) => served.fetch(request) })
	// The crontab may never fire; the serving process notices a job that stopped succeeding without being invoked.
	const check = () => void served.jobs.check()
	const checks = served.jobs.names.length === 0 ? undefined : setInterval(check, JOB_CHECK_INTERVAL_MS)
	if (checks !== undefined) {
		check()
	}
	const stop = async (): Promise<void> => {
		clearInterval(checks)
		await server.stop(false)
		await database?.close()
	}
	process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
	return { port: server.port ?? port, stop }
}

/** The application module at `path`, imported when the loader runs; its default export must be what `implement` returned. */
export function implementationAt(path: string): ImplementationLoader {
	return async () => {
		const module: unknown = await import(path)
		const value = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
		if (!isContractImplementation(value)) {
			throw new BootError([`${path} does not default-export implement(contract, { … })`])
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
		const files = openFileStorage(environment.framework)
		return await boot(app, {
			environment,
			iam,
			assets: diskAssets(process.cwd()),
			database,
			files,
			membership,
			workloadTokens,
			requireProxySecret: true,
		})
			.jobs.run(name, options)
	} finally {
		await database?.close()
	}
}
