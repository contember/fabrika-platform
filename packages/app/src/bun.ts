// ─── Bun process adapter ─────────────────────────────────────────────
//
// A long-running Bun process needs only request dispatch and explicit draining.
// It does not emulate Worker cron, queues, or passThroughOnException(). A
// contract application is served through `serveContract`, from the generated
// entrypoint.

import { rawRequestTarget } from '@fabrika/auth-core'
import type * as DataLayer from '@fabrika/db'
import type { Database } from '@fabrika/db'
import { isScopedDatabase } from '@fabrika/db/framework'
import { parseJwks } from '@fabrika/jwks'
import { join, resolve, sep } from 'node:path'
import type { FabrikaApp, RequestExecutionContext } from './app.js'
import { boot, BootError, type IamKeySource } from './implement/boot.js'
import type { SpaAssets } from './implement/dispatch.js'
import { captureEnvironment } from './implement/environment.js'
import type { ContractImplementation } from './implement/implement.js'

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

export function createBunHandler<Env>(app: FabrikaApp<Env>, env: Env, options: BunHandlerOptions): BunHandler {
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
 * The application's connection: `FABRIKA_APP_DATABASE_URL`, on the schema `app_<FABRIKA_APP_ID>` its migrations
 * created. The URL is a credential, so no message quotes it.
 */
function openApplicationDatabase(data: typeof DataLayer, framework: Readonly<Record<string, string>>): Database {
	const url = framework['FABRIKA_APP_DATABASE_URL'] ?? ''
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
	return data.Database.postgres({ url, schema })
}

/** The application module, imported only after the environment was captured: the generated entrypoint's `import()`. */
export type ImplementationLoader = () => Promise<{ readonly default: ContractImplementation }>

/**
 * Captures the framework's variables and scrubs them from the process, then imports the application, boots it and
 * serves it on `PORT` (default 3000), on every interface: the project's private network is how the proxy reaches
 * it. Called only by the generated entrypoint, with `process.env`. SIGTERM drains.
 */
export async function serveContract(load: ImplementationLoader, env: Readonly<Record<string, string | undefined>>): Promise<ContractServer> {
	const environment = captureEnvironment(env)
	const port = Number.parseInt(environment.application['PORT'] === undefined ? '3000' : String(environment.application['PORT']), 10)
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('PORT must be an integer between 0 and 65535')
	}
	// Loaded before the application: it captures the built-ins its checks use and freezes the Kysely compiler.
	const data = await import('@fabrika/db')
	const { default: app } = await load()
	const iam = issuerJwks(environment.framework['FABRIKA_IAM_ISSUER'])
	const database = isScopedDatabase(app.database) ? openApplicationDatabase(data, environment.framework) : undefined
	const served = boot(app, { environment, iam, assets: diskAssets(process.cwd()), database })
	const server = Bun.serve({ port, hostname: '0.0.0.0', fetch: (request) => served.fetch(request) })
	const stop = async (): Promise<void> => {
		await server.stop(false)
		await database?.close()
	}
	process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
	return { port: server.port ?? port, stop }
}
