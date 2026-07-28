// Runtime assembly for a LONG-RUNNING BUN PROCESS — the other half of what `wrangler` does for the
// Worker: fill the `Env` ports and hand back a request context.
//
// Everything under `src/node/` is Bun/Node-only and is the ONLY part of this package allowed to be.
// It imports `@fabrika/platform-node`; `src/index.ts` (the Worker) imports `cloudflare:workers`; the
// shared layer between them (`rpc.ts`, `routes.ts`, `cron.ts`, everything they reach) imports
// neither. `src/__tests__/entrypoint-isolation.test.ts` walks both graphs and fails if that stops
// being true.
//
//   SqlDatabase → PostgresDatabase      (D1's place)
//   AssetServer → FileSystemAssetServer (the `ASSETS` binding's place — the built SPA on disk)
//   WaitUntil   → createBackgroundTasks (ctx.waitUntil's place — supervised, never process-fatal)

import { createBackgroundTasks, FileSystemAssetServer, PostgresDatabase } from '@fabrika/platform-node'
import type { Env, RequestContext } from '../env'

/** Config that exists ONLY off Workers — the process's own knobs, not part of the service's `Env`. */
export interface ProcessConfig {
	/** TCP port to listen on. */
	port: number
	/** Directory holding the built admin SPA (`@fabrika/iam-ui`'s `dist`). */
	assetsDir: string
	/**
	 * Shared secret gating the HTTP MANAGEMENT surface (`/rpc/*`). EMPTY DISABLES IT — see
	 * `rpc-http.ts`. Never logged.
	 */
	rpcKey: string
	/**
	 * Shared secret gating the PROXY mint surface (`/auth/mint/*`), which the auth proxy calls on the
	 * cold path. Separate from `rpcKey` by least privilege — the proxy is the only publicly-routed
	 * component and needs only these two calls. EMPTY DISABLES IT. Never logged.
	 */
	proxyKey: string
}

export interface Runtime {
	env: Env
	ctx: RequestContext
	config: ProcessConfig
	/** Wait for in-flight background work, then close the connection pool. */
	shutdown(): Promise<void>
}

/** Minimum length for the RPC shared secret. 32 chars of a generated token is ~190 bits at base64url. */
const MIN_RPC_KEY_LENGTH = 32

/**
 * Read `process.env`, open the Postgres pool, mount the asset directory, and return the pair of
 * handles every shared entrypoint function takes.
 *
 * Fails LOUDLY and early on missing required configuration: a service that boots half-configured and
 * then refuses logins at 3am is strictly worse than one that never came up. Nothing here ever logs a
 * value — the database URL and the RPC key are credentials, and only their absence is reportable.
 */
export function createRuntime(source: Record<string, string | undefined> = process.env): Runtime {
	const databaseUrl = required(source, 'PROPUSTKA_DATABASE_URL')
	const environment = required(source, 'ENVIRONMENT')
	const issuer = required(source, 'ISSUER')

	const config: ProcessConfig = {
		port: parsePort(source['PORT']),
		assetsDir: source['PROPUSTKA_ASSETS_DIR'] ?? './public',
		rpcKey: sharedSecret(source, 'PROPUSTKA_RPC_KEY'),
		proxyKey: sharedSecret(source, 'PROPUSTKA_PROXY_KEY'),
	}

	const db = PostgresDatabase.connect(databaseUrl)
	const tasks = createBackgroundTasks({ label: 'iam background task' })

	const env: Env = {
		DB: db,
		// SPA fallback on: the admin UI is client-routed, so `/principals/<id>` must serve index.html.
		ASSETS: new FileSystemAssetServer(config.assetsDir, { spaFallback: true }),
		HUMAN_EMAIL_DOMAINS: source['HUMAN_EMAIL_DOMAINS'] ?? '[]',
		HUMAN_EMAILS: source['HUMAN_EMAILS'] ?? '[]',
		IAM_BOOTSTRAP_ADMINS: source['IAM_BOOTSTRAP_ADMINS'] ?? '[]',
		ENVIRONMENT: environment,
		ISSUER: issuer,
		// Empty off-local is refused by `getSigner`, not here — one owner for that rule.
		PROPUSTKA_SIGNING_KEYS: source['PROPUSTKA_SIGNING_KEYS'] ?? '',
		PROPUSTKA_PROVISIONING_KEY: source['PROPUSTKA_PROVISIONING_KEY'] ?? '',
		SESSION_COOKIE_DOMAIN: source['SESSION_COOKIE_DOMAIN'] ?? '',
		OIDC_ISSUER: source['OIDC_ISSUER'] ?? '',
		OIDC_CLIENT_ID: source['OIDC_CLIENT_ID'] ?? '',
		OIDC_CLIENT_SECRET: source['OIDC_CLIENT_SECRET'] ?? '',
		OIDC_SCOPES: source['OIDC_SCOPES'] ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: source['OIDC_REQUIRE_VERIFIED_EMAIL'] ?? 'true',
	}

	return {
		env,
		ctx: { waitUntil: tasks.waitUntil },
		config,
		async shutdown(): Promise<void> {
			// Drain BEFORE closing the pool: the auth-log and audit writes registered through `waitUntil`
			// are the reason the port exists, and closing under them would lose exactly the records an
			// audit trail must not lose.
			await tasks.drain()
			await db.close()
		},
	}
}

/**
 * Read a transport shared secret. Absent is legal and means "that surface is off"; a SHORT one is
 * not, and fails the boot — a guessable secret in front of an internet-reachable surface is worse
 * than no surface at all, and it would look configured.
 */
function sharedSecret(source: Record<string, string | undefined>, name: string): string {
	const value = source[name] ?? ''
	if (value !== '' && value.length < MIN_RPC_KEY_LENGTH) {
		throw new Error(`${name} must be at least ${MIN_RPC_KEY_LENGTH} characters (it is the only thing guarding its HTTP surface)`)
	}
	return value
}

function required(source: Record<string, string | undefined>, name: string): string {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required`)
	}
	return value
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return 3000
	}
	const port = Number.parseInt(raw, 10)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535')
	}
	return port
}
