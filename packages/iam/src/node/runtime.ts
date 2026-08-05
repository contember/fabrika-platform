// Runtime assembly for a LONG-RUNNING BUN PROCESS — the other half of what `wrangler` does for the
// Worker: fill the `Env` ports and hand back a request context.
//
// Everything under `src/node/` is Bun/Node-only and is the ONLY part of this package allowed to be.
// It imports `@fabrika/platform-node`; `src/index.ts` (the Worker) imports `cloudflare:workers`; the
// shared layer between them (`app.ts`, `rpc.ts`, `cron.ts`, everything they reach) imports
// neither. `src/__tests__/entrypoint-isolation.test.ts` walks both graphs and fails if that stops
// being true.
//
//   SqlDatabase → PostgresDatabase      (D1's place)
//   WaitUntil   → createBackgroundTasks (ctx.waitUntil's place — supervised, never process-fatal)

import { environmentAliases } from '@fabrika/platform'
import { createBackgroundTasks, PostgresDatabase } from '@fabrika/platform-node'
import { createIamRepositories } from '../db'
import type { Env, RequestContext } from '../env'

/** Config that exists ONLY off Workers — the process's own knobs, not part of the service's `Env`. */
export interface ProcessConfig {
	/** TCP port to listen on. */
	port: number
	/**
	 * Shared secret gating the HTTP MANAGEMENT surface (`/rpc/*`). EMPTY DISABLES IT — see
	 * `rpc-http.ts`. Never logged.
	 */
	rpcKey: string
	/**
	 * Shared secret gating the PROXY mint surface (`/auth/mint/*`), which the auth proxy calls on the
	 * cold path. Separate from `rpcKey` by least privilege — the proxy is the only publicly-routed
	 * component and needs only three IAM calls: `mintToken`, `mintFromKey`, and `exchangeAuthCode`
	 * (ADR-0021), which redeems a live handoff code for an app-bound session. That third one is a real
	 * capability rather than a read, and the split is still worth it: the code is single-use,
	 * hash-only, bound to `(session, app, return URL)` and dead in two minutes, whereas the management
	 * key would additionally let a compromised edge forge audit rows for any app. EMPTY DISABLES IT.
	 * Never logged.
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
	const databaseUrl = requiredAlias(source, 'FABRIKA_IAM_DATABASE_URL', 'PROPUSTKA_DATABASE_URL')
	const environment = required(source, 'ENVIRONMENT')
	const issuer = required(source, 'ISSUER')
	const oidcEnabled = booleanAlias(source, 'FABRIKA_IAM_OIDC_ENABLED', 'PROPUSTKA_OIDC_ENABLED', true)
	const passwordEnabled = booleanAlias(source, 'FABRIKA_IAM_PASSWORD_ENABLED', 'PROPUSTKA_PASSWORD_ENABLED', false)
	if (!oidcEnabled && !passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	const oidcIssuer = oidcEnabled ? required(source, 'OIDC_ISSUER') : source['OIDC_ISSUER'] ?? ''
	const oidcClientId = oidcEnabled ? required(source, 'OIDC_CLIENT_ID') : source['OIDC_CLIENT_ID'] ?? ''
	const oidcClientSecret = oidcEnabled ? required(source, 'OIDC_CLIENT_SECRET') : source['OIDC_CLIENT_SECRET'] ?? ''
	const emailProvider = source['FABRIKA_EMAIL_PROVIDER'] ?? 'none'
	if (emailProvider !== 'none' && emailProvider !== 'resend') {
		throw new Error('FABRIKA_EMAIL_PROVIDER must be none or resend')
	}
	const emailFrom = emailProvider === 'resend' ? required(source, 'FABRIKA_EMAIL_FROM') : source['FABRIKA_EMAIL_FROM'] ?? ''
	const emailApiKey = emailProvider === 'resend'
		? required(source, 'FABRIKA_EMAIL_RESEND_API_KEY')
		: source['FABRIKA_EMAIL_RESEND_API_KEY'] ?? ''

	const config: ProcessConfig = {
		port: parsePort(source['PORT']),
		rpcKey: sharedSecret(source, 'FABRIKA_IAM_RPC_KEY', 'PROPUSTKA_RPC_KEY'),
		proxyKey: sharedSecret(source, 'FABRIKA_IAM_PROXY_KEY', 'PROPUSTKA_PROXY_KEY'),
	}

	const db = PostgresDatabase.connect(databaseUrl)
	const tasks = createBackgroundTasks({ label: 'iam background task' })

	const env: Env = {
		DB: db,
		REPOSITORIES: createIamRepositories(db),
		HUMAN_EMAIL_DOMAINS: source['HUMAN_EMAIL_DOMAINS'] ?? '[]',
		HUMAN_EMAILS: source['HUMAN_EMAILS'] ?? '[]',
		IAM_BOOTSTRAP_ADMINS: source['IAM_BOOTSTRAP_ADMINS'] ?? '[]',
		// Which browser origins may drive `/admin/*`. Empty means none, which is the fail-closed
		// default — a console that is not registered cannot write, and says so.
		ADMIN_ORIGINS: source['FABRIKA_IAM_ADMIN_ORIGINS'] ?? '[]',
		ENVIRONMENT: environment,
		LOCAL_DEV_LOGIN: source['LOCAL_DEV_LOGIN'] ?? '',
		ISSUER: issuer,
		// Empty off-local is refused by `getSigner`, not here — one owner for that rule.
		FABRIKA_IAM_SIGNING_KEYS: environmentAliases.read(source, { canonical: 'FABRIKA_IAM_SIGNING_KEYS', legacy: 'PROPUSTKA_SIGNING_KEYS' }) ?? '',
		FABRIKA_IAM_PROVISIONING_KEY: environmentAliases.read(source, { canonical: 'FABRIKA_IAM_PROVISIONING_KEY', legacy: 'PROPUSTKA_PROVISIONING_KEY' })
			?? '',
		OIDC_ENABLED: String(oidcEnabled),
		PASSWORD_ENABLED: String(passwordEnabled),
		OIDC_ISSUER: oidcIssuer,
		OIDC_CLIENT_ID: oidcClientId,
		OIDC_CLIENT_SECRET: oidcClientSecret,
		OIDC_SCOPES: source['OIDC_SCOPES'] ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: source['OIDC_REQUIRE_VERIFIED_EMAIL'] ?? 'true',
		EMAIL_PROVIDER: emailProvider,
		EMAIL_FROM: emailFrom,
		EMAIL_API_KEY: emailApiKey,
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

function booleanAlias(source: Record<string, string | undefined>, canonical: string, legacy: string, fallback: boolean): boolean {
	const raw = environmentAliases.read(source, { canonical, legacy })
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${canonical} must be true or false`)
}

/**
 * Read a transport shared secret. Absent is legal and means "that surface is off"; a SHORT one is
 * not, and fails the boot — a guessable secret in front of an internet-reachable surface is worse
 * than no surface at all, and it would look configured.
 */
function sharedSecret(source: Record<string, string | undefined>, canonical: string, legacy: string): string {
	const value = environmentAliases.read(source, { canonical, legacy }) ?? ''
	if (value !== '' && value.length < MIN_RPC_KEY_LENGTH) {
		throw new Error(`${canonical} must be at least ${MIN_RPC_KEY_LENGTH} characters (it is the only thing guarding its HTTP surface)`)
	}
	return value
}

function requiredAlias(source: Record<string, string | undefined>, canonical: string, legacy: string): string {
	const value = environmentAliases.read(source, { canonical, legacy })
	if (value === undefined || value.trim() === '') {
		throw new Error(`${canonical} is required`)
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
