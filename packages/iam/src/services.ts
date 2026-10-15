import { LOCAL_ENVIRONMENT, parseJsonStringArray, readEnvironmentName } from '@fabrika/auth-core'
import { type EmailSender, emailSenderFromEnv, readEmailTransportConfig } from '@fabrika/email'
import type { IamRepositories } from './db'
import { normalizeEmailIdentity } from './email-identity'
import type { Env } from './env'
import { type OAuthConfig, parseOAuthConfig } from './oauth-config'
import { OidcClient } from './oidc'
import { type PasswordHasher, WebCryptoPasswordHasher } from './password-crypto'
import { parseRetention, type Retention } from './retention'

/**
 * Pre-wired services + parsed config for every request. Handlers take `Services`
 * (or pick what they need off it) instead of reaching into `env` directly —
 * keeps them decoupled from the CF binding shape and easier to test.
 */
export interface Services {
	readonly repositories: IamRepositories
	/** OIDC relying-party client. Null when the method is disabled. */
	readonly oidc: OidcClient | null
	readonly passwordHasher: PasswordHasher
	readonly email: EmailSender | null
	readonly config: Config
}

export interface Config {
	/**
	 * The central human-admission allowlist — who may self-provision as a HUMAN at login. A `*` entry
	 * in either list means admit-all; otherwise an exact email or matching domain. Owned by propustka
	 * (deploy vars `FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` / `FABRIKA_IAM_HUMAN_EMAILS`).
	 */
	readonly human: {
		readonly emailDomains: readonly string[]
		readonly emails: readonly string[]
	}
	/** Bootstrap-admin emails (normally empty). Always admitted; resolve to the global `admin` role. */
	readonly bootstrapAdmins: ReadonlySet<string>
	/**
	 * App ids whose proxy-injected access token may administer `/admin/*` (`ADMIN_AUDIENCES`).
	 * EMPTY means no JWT may administer at all, which is the fail-closed end of the same registry.
	 */
	readonly adminAudiences: ReadonlySet<string>
	/**
	 * App ids of the installation's own services. Only a token for one of them carries cross-app grants
	 * and the bootstrap `admin`; an application token carries the grants of its own app id and nothing else.
	 */
	readonly platformAudiences: ReadonlySet<string>
	readonly environment: string
	/** Create a real local admin session without contacting an external OIDC provider. */
	readonly localDevLogin: boolean
	readonly authentication: {
		readonly oidc: { readonly enabled: boolean }
		readonly password: { readonly enabled: boolean }
	}
	/** The OAuth authorization server for MCP clients; null = off. */
	readonly oauth: OAuthConfig | null
	/** How long the maintenance cron keeps `auth_log` and `audit_events`. */
	readonly retention: Retention
	// ── propustka-native auth ──
	/** propustka's own origin — the `iss` of minted tokens and the OIDC redirect base. */
	readonly issuer: string
}

/**
 * The console gateway's app id — the only first-party holder of a JWT that administers IAM, and so
 * the audience an installation gets when it names none.
 */
export const DEFAULT_ADMIN_AUDIENCES: ReadonlySet<string> = new Set(['vozka'])

/** IAM itself, the console (Control's app id) and Operations — the services every installation runs. */
export const DEFAULT_PLATFORM_AUDIENCES: ReadonlySet<string> = new Set(['propustka', 'vozka', 'operations'])

/** An admin audience is a console gateway, so it is a platform service too, whatever it is named. */
export function platformAudiencesFor(adminAudiences: ReadonlySet<string>): ReadonlySet<string> {
	return new Set([...DEFAULT_PLATFORM_AUDIENCES, ...adminAudiences])
}

/** An app id as every fabrika config writes one — the shape an `aud` claim can actually carry. */
const APP_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Parse `ADMIN_AUDIENCES` (comma-separated app ids). Unset = `DEFAULT_ADMIN_AUDIENCES`; explicitly
 * empty = no JWT may administer. A malformed entry is REFUSED rather than skipped: an entry no `aud`
 * can ever equal would otherwise read as a registry while admitting nobody.
 */
function parseAdminAudiences(raw: string | undefined): ReadonlySet<string> {
	if (raw === undefined) {
		return DEFAULT_ADMIN_AUDIENCES
	}
	if (raw.trim() === '') {
		return new Set()
	}
	const audiences = new Set<string>()
	for (const entry of raw.split(',')) {
		const app = entry.trim()
		if (!APP_ID.test(app)) {
			throw new Error(`ADMIN_AUDIENCES holds a value that is not an app id: ${entry}`)
		}
		audiences.add(app)
	}
	return audiences
}

function parseBootstrapAdmins(raw: string): Set<string> {
	return new Set(parseJsonStringArray(raw).map(normalizeEmailIdentity).filter((value) => value !== ''))
}

export function buildServices(env: Env): Services {
	// This root's public origin IS `ISSUER`, so `local` cannot survive an IAM that mints tokens for a
	// public name. Enforced here rather than per entrypoint because both engines pass through this
	// function — the same reason `buildOidc` lives here.
	const environment = readEnvironmentName(env.ENVIRONMENT, env.ISSUER)
	const oidcEnabled = parseBooleanSwitch('OIDC_ENABLED', env.OIDC_ENABLED, true)
	const passwordEnabled = parseBooleanSwitch('PASSWORD_ENABLED', env.PASSWORD_ENABLED, false)
	if (!oidcEnabled && !passwordEnabled) {
		throw new Error('At least one authentication method must be enabled')
	}
	const oidc = oidcEnabled ? buildOidc(env) : null
	const adminAudiences = parseAdminAudiences(env.ADMIN_AUDIENCES)
	return {
		repositories: env.REPOSITORIES,
		oidc,
		passwordHasher: new WebCryptoPasswordHasher(),
		email: buildEmailSender(env, environment),
		config: {
			human: {
				emailDomains: parseJsonStringArray(env.HUMAN_EMAIL_DOMAINS),
				emails: parseJsonStringArray(env.HUMAN_EMAILS),
			},
			bootstrapAdmins: parseBootstrapAdmins(env.IAM_BOOTSTRAP_ADMINS),
			adminAudiences,
			platformAudiences: platformAudiencesFor(adminAudiences),
			environment,
			localDevLogin: environment === LOCAL_ENVIRONMENT && env.LOCAL_DEV_LOGIN === 'true',
			authentication: {
				oidc: { enabled: oidcEnabled },
				password: { enabled: passwordEnabled },
			},
			oauth: parseOAuthConfig(env.OAUTH_CONFIG),
			retention: parseRetention({ authLogDays: env.AUTH_LOG_RETENTION_DAYS, auditDays: env.AUDIT_RETENTION_DAYS }),
			issuer: env.ISSUER,
		},
	}
}

function parseBooleanSwitch(name: string, raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${name} must be 'true' or 'false'`)
}

function required(name: string, value: string | undefined): string {
	if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
	return value
}

/**
 * Build the relying-party client, REFUSING an incomplete configuration.
 *
 * The Bun composition has always failed the boot on a missing `OIDC_*`; the Worker used to substitute
 * empty strings and serve an OIDC method that could only fail at the redirect. Two engines, two
 * answers to one misconfiguration — the surviving one is the loud one, on the same reasoning as the
 * proxy's key check and the signing-key refusal: refusing to boot beats booting misconfigured.
 */
function buildOidc(env: Env): OidcClient {
	return new OidcClient({
		issuer: required('OIDC_ISSUER', env.OIDC_ISSUER),
		clientId: required('OIDC_CLIENT_ID', env.OIDC_CLIENT_ID),
		clientSecret: required('OIDC_CLIENT_SECRET', env.OIDC_CLIENT_SECRET),
		redirectUri: `${env.ISSUER}/auth/callback`,
		scopes: env.OIDC_SCOPES ?? '',
		requireVerifiedEmail: env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false',
	})
}

function buildEmailSender(env: Env, environment: string): EmailSender | null {
	const config = env.EMAIL_CONFIG ?? {}
	const providers = env.EMAIL_PROVIDERS ?? {}
	if (env.EMAIL_SENDER !== undefined) {
		if (environment !== LOCAL_ENVIRONMENT) throw new Error('A composition email sender is local-only; set ENVIRONMENT=local or remove it')
		if (readEmailTransportConfig(config, providers).kind !== 'none') {
			throw new Error('A composition email sender replaces FABRIKA_EMAIL_PROVIDER, which must then be none')
		}
		return env.EMAIL_SENDER
	}
	return emailSenderFromEnv(config, providers)
}
