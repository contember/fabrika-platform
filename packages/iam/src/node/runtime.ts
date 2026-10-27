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

import { IAM_PROXY_SECRET_VARIABLE, LOCAL_ENVIRONMENT, readEnvironmentName } from '@fabrika/auth-core'
import { type EmailProviderRegistry, type EmailSender, emailSenderFromEnv, pickEmailEnvironment, readEmailTransportConfig } from '@fabrika/email'
import { installationMailSender } from '@fabrika/email/platform'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { createBackgroundTasks, PostgresDatabase } from '@fabrika/platform-node'
import { createPostgresIamRepositories } from '../db'
import type { Env, RequestContext } from '../env'
import { parseOAuthConfig } from '../oauth-config'
import { BUN_PBKDF2_COST } from '../password-crypto'
import { parseRetention } from '../retention'

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
	 * (ADR-0022), which redeems a live handoff code for an app-bound session. That third one is a real
	 * capability rather than a read, and the split is still worth it: the code is single-use,
	 * hash-only, bound to `(session, app, return URL)` and dead in two minutes, whereas the management
	 * key would additionally let a compromised edge forge audit rows for any app. EMPTY DISABLES IT.
	 * Never logged.
	 */
	proxyKey: string
	/**
	 * The secret the platform proxy sends on IAM's route (`IAM_PROXY_SECRET_VARIABLE`), proving it wrote the client-address
	 * and request-id headers. EMPTY READS THOSE HEADERS UNPROVEN, as before the deploy that writes it. Never logged.
	 */
	proxySecret: string
}

/** What a composition root hands the process besides `process.env` — never an environment variable. */
export interface RuntimeOverrides {
	/** Replaces `FABRIKA_EMAIL_PROVIDER`'s sender, only with `ENVIRONMENT=local`: the local stack's mail capture. */
	readonly emailSender?: EmailSender
	/** The providers `FABRIKA_EMAIL_PROVIDER` may name. Defaults to the built-in ones. */
	readonly emailProviders?: EmailProviderRegistry
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
 * handles every shared entrypoint function takes. Asynchronous so that a refusal reaches the caller as a
 * rejected promise; everything that can refuse the boot runs before the pool opens.
 *
 * Fails LOUDLY and early on missing required configuration: a service that boots half-configured and
 * then refuses logins at 3am is strictly worse than one that never came up. Nothing here ever logs a
 * value — the database URL and the RPC key are credentials, and only their absence is reportable.
 */
export async function createRuntime(source: Record<string, string | undefined> = process.env, overrides: RuntimeOverrides = {}): Promise<Runtime> {
	const databaseUrl = required(source, 'FABRIKA_IAM_DATABASE_URL')
	const issuer = required(source, 'ISSUER')
	// Checked at BOOT as well as in `buildServices`: a process that comes up and then throws per request
	// still answers `/healthz`, so the readiness probe would pass a deployment that serves nothing.
	const environment = readEnvironmentName(required(source, 'ENVIRONMENT'), issuer)
	const oidcEnabled = booleanValue(source, 'FABRIKA_IAM_OIDC_ENABLED', true)
	const passwordEnabled = booleanValue(source, 'FABRIKA_IAM_PASSWORD_ENABLED', false)
	if (!oidcEnabled && !passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	const oidcIssuer = oidcEnabled ? required(source, 'OIDC_ISSUER') : source['OIDC_ISSUER'] ?? ''
	const oidcClientId = oidcEnabled ? required(source, 'OIDC_CLIENT_ID') : source['OIDC_CLIENT_ID'] ?? ''
	const oidcClientSecret = oidcEnabled ? required(source, 'OIDC_CLIENT_SECRET') : source['OIDC_CLIENT_SECRET'] ?? ''
	const emailConfig = pickEmailEnvironment(source)
	const emailProviders = overrides.emailProviders ?? builtinEmailProviders
	const emailConfigured = readEmailTransportConfig(emailConfig, emailProviders).kind !== 'none'
	if (overrides.emailSender !== undefined && (environment !== LOCAL_ENVIRONMENT || emailConfigured)) {
		throw new Error('A composition email sender needs ENVIRONMENT=local and FABRIKA_EMAIL_PROVIDER=none')
	}
	// Built once here as well as per request in `buildServices`, for the same readiness-probe reason as above.
	emailSenderFromEnv(emailConfig, emailProviders)
	const controlUrl = httpOrigin(source, 'FABRIKA_CONTROL_URL')

	// Parsed here as well as per request in `buildServices`, for the same readiness-probe reason as above.
	parseOAuthConfig(source['FABRIKA_IAM_OAUTH_CONFIG'])
	const authLogRetentionDays = source['FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS']
	const auditRetentionDays = source['FABRIKA_IAM_AUDIT_RETENTION_DAYS']
	parseRetention(
		{ authLogDays: authLogRetentionDays, auditDays: auditRetentionDays },
		{ authLogDays: 'FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS', auditDays: 'FABRIKA_IAM_AUDIT_RETENTION_DAYS' },
	)

	const config: ProcessConfig = {
		port: parsePort(source['PORT']),
		rpcKey: sharedSecret(source, 'FABRIKA_IAM_RPC_KEY'),
		proxyKey: sharedSecret(source, 'FABRIKA_IAM_PROXY_KEY'),
		proxySecret: sharedSecret(source, IAM_PROXY_SECRET_VARIABLE),
	}
	// IAM keeps its provider's configuration as the switch for delivery; Control holds the transport that delivers.
	const platformEmailSender = controlUrl !== undefined && emailConfigured ? relaySender(controlUrl, config.rpcKey) : undefined

	const db = PostgresDatabase.connect(databaseUrl)
	const tasks = createBackgroundTasks({ label: 'iam background task' })

	const env: Env = {
		DB: db,
		REPOSITORIES: createPostgresIamRepositories(db),
		HUMAN_EMAIL_DOMAINS: source['HUMAN_EMAIL_DOMAINS'] ?? '[]',
		HUMAN_EMAILS: source['HUMAN_EMAILS'] ?? '[]',
		IAM_BOOTSTRAP_ADMINS: source['IAM_BOOTSTRAP_ADMINS'] ?? '[]',
		// Which app's proxy token may administer. Passed through undefined so "unset" (the console
		// gateway default) stays distinguishable from an explicit empty value (no JWT may administer).
		ADMIN_AUDIENCES: source['FABRIKA_IAM_ADMIN_AUDIENCES'],
		OAUTH_CONFIG: source['FABRIKA_IAM_OAUTH_CONFIG'] ?? '',
		AUTH_LOG_RETENTION_DAYS: authLogRetentionDays,
		AUDIT_RETENTION_DAYS: auditRetentionDays,
		ENVIRONMENT: environment,
		LOCAL_DEV_LOGIN: source['LOCAL_DEV_LOGIN'] ?? '',
		ISSUER: issuer,
		// Empty off-local is refused by `getSigner`, not here — one owner for that rule.
		FABRIKA_IAM_SIGNING_KEYS: source['FABRIKA_IAM_SIGNING_KEYS'] ?? '',
		FABRIKA_IAM_PROVISIONING_KEY: source['FABRIKA_IAM_PROVISIONING_KEY'] ?? '',
		OIDC_ENABLED: String(oidcEnabled),
		PASSWORD_ENABLED: String(passwordEnabled),
		OIDC_ISSUER: oidcIssuer,
		OIDC_CLIENT_ID: oidcClientId,
		OIDC_CLIENT_SECRET: oidcClientSecret,
		OIDC_SCOPES: source['OIDC_SCOPES'] ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: source['OIDC_REQUIRE_VERIFIED_EMAIL'] ?? 'true',
		EMAIL_CONFIG: emailConfig,
		EMAIL_PROVIDERS: emailProviders,
		PASSWORD_COST: BUN_PBKDF2_COST,
		...(overrides.emailSender === undefined ? {} : { EMAIL_SENDER: overrides.emailSender }),
		...(platformEmailSender === undefined ? {} : { PLATFORM_EMAIL_SENDER: platformEmailSender }),
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

function booleanValue(source: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
	const raw = source[name]
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${name} must be true or false`)
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

/** The relay authenticates IAM by a key derived from the secret both hold, so the relay needs that secret set. */
function relaySender(controlUrl: string, rpcKey: string): EmailSender {
	if (rpcKey === '') throw new Error('FABRIKA_CONTROL_URL needs FABRIKA_IAM_RPC_KEY, which the mail relay authenticates IAM by')
	return installationMailSender({ url: controlUrl, secret: rpcKey })
}

/** An optional http(s) origin: no path, no trailing slash. Absent or empty is undefined. */
function httpOrigin(source: Record<string, string | undefined>, name: string): string | undefined {
	const raw = source[name]
	if (raw === undefined || raw === '') return undefined
	const url = URL.parse(raw)
	if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== raw) {
		throw new Error(`${name} must be an http(s) origin, such as http://control:3000`)
	}
	return raw
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
