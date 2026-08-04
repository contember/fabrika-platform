import type { EmailSender } from '@fabrika/email'
import { ResendEmailSender } from '@fabrika/email/resend'
import type { IamRepositories } from './db'
import { normalizeEmailIdentity } from './email-identity'
import type { Env } from './env'
import { OidcClient } from './oidc'
import { type PasswordHasher, WebCryptoPasswordHasher } from './password-crypto'

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
	readonly environment: string
	/** Create a real local admin session without contacting an external OIDC provider. */
	readonly localDevLogin: boolean
	readonly authentication: {
		readonly oidc: { readonly enabled: boolean }
		readonly password: { readonly enabled: boolean }
	}
	// ── propustka-native auth ──
	/** propustka's own origin — the `iss` of minted tokens and the OIDC redirect base. */
	readonly issuer: string
	/** `Domain` for the SSO session cookie (e.g. `.example.com`); empty = host-only. */
	readonly sessionCookieDomain: string
}

/** Parse a JSON array of strings (the central human-domain/email lists); [] on anything malformed. */
function parseStringArray(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
	} catch {
		return []
	}
}

function parseBootstrapAdmins(raw: string): Set<string> {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) {
			return new Set()
		}
		return new Set(
			parsed
				.filter((v): v is string => typeof v === 'string')
				.map(normalizeEmailIdentity)
				.filter((value) => value !== ''),
		)
	} catch {
		return new Set()
	}
}

export function buildServices(env: Env): Services {
	const oidcEnabled = parseBooleanSwitch('OIDC_ENABLED', env.OIDC_ENABLED, true)
	const passwordEnabled = parseBooleanSwitch('PASSWORD_ENABLED', env.PASSWORD_ENABLED, false)
	if (!oidcEnabled && !passwordEnabled) {
		throw new Error('At least one authentication method must be enabled')
	}
	const oidc = oidcEnabled ? buildOidc(env) : null
	return {
		repositories: env.REPOSITORIES,
		oidc,
		passwordHasher: new WebCryptoPasswordHasher(),
		email: buildEmailSender(env),
		config: {
			human: {
				emailDomains: parseStringArray(env.HUMAN_EMAIL_DOMAINS),
				emails: parseStringArray(env.HUMAN_EMAILS),
			},
			bootstrapAdmins: parseBootstrapAdmins(env.IAM_BOOTSTRAP_ADMINS),
			environment: env.ENVIRONMENT,
			localDevLogin: env.ENVIRONMENT === 'local' && env.LOCAL_DEV_LOGIN === 'true',
			authentication: {
				oidc: { enabled: oidcEnabled },
				password: { enabled: passwordEnabled },
			},
			issuer: env.ISSUER,
			sessionCookieDomain: env.SESSION_COOKIE_DOMAIN,
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

function buildOidc(env: Env): OidcClient {
	return new OidcClient({
		issuer: env.OIDC_ISSUER ?? '',
		clientId: env.OIDC_CLIENT_ID ?? '',
		clientSecret: env.OIDC_CLIENT_SECRET ?? '',
		redirectUri: `${env.ISSUER}/auth/callback`,
		scopes: env.OIDC_SCOPES ?? '',
		requireVerifiedEmail: env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false',
	})
}

function buildEmailSender(env: Env): EmailSender | null {
	const provider = env.EMAIL_PROVIDER ?? 'none'
	if (provider === 'none') return null
	if (provider === 'resend') {
		return new ResendEmailSender({
			from: required('EMAIL_FROM', env.EMAIL_FROM),
			apiKey: required('EMAIL_API_KEY', env.EMAIL_API_KEY),
		})
	}
	throw new Error(`Unsupported EMAIL_PROVIDER '${provider}'`)
}
