// IAM's deploy surface. This file owns its environment contract and Cloudflare resource graph.
// fabrika loads the default `defineApp` config; the local Oblaka entry imports the same builder.
//
// Non-secret deploy vars come from fabrika's per-app environment registry. Native-auth secrets are
// validated before remote materialization but never enter Worker `vars`, where Oblaka would serialize
// them as plaintext. The Custom Domain route comes from `ctx.domain` (`FABRIKA_IAM_HOSTNAME` in the
// standalone Oblaka adapter).

import type { AppSchema } from '@fabrika/auth-core'
import { environmentAliases } from '@fabrika/platform'
import { D1Database, defineApp, type ResourceContext, Worker } from '@fabrika/provider-cloudflare'

// Keep the legacy Oblaka namespace so the first fabrika deploy continues the existing cf-state.
const IAM_APP_ID = 'propustka'

const KNOWN_ENVS = new Set(['local', 'stage', 'prod', 'mangoweb'])

type EnvironmentSource = Readonly<Record<string, string | undefined>>

interface RemoteConfig {
	domain: string
	humanEmailDomains: string
	adminOrigins: string
	oidcEnabled: boolean
	passwordEnabled: boolean
	oidcIssuer: string
	oidcClientId: string
	emailProvider: 'none' | 'resend'
	emailFrom: string
}

interface AuthenticationConfig {
	oidcEnabled: boolean
	passwordEnabled: boolean
}

interface EmailConfig {
	provider: 'none' | 'resend'
	from: string
}

const aliasValue = (source: EnvironmentSource, canonical: string, legacy: string): string | undefined =>
	environmentAliases.read(source, { canonical, legacy })

const requiredDomain = (domain: string | undefined): string => {
	if (domain === undefined || domain === '') {
		throw new Error('Missing FABRIKA_IAM_HOSTNAME')
	}
	return domain
}

const booleanValue = (source: EnvironmentSource, canonical: string, legacy: string, fallback: boolean): boolean => {
	const raw = aliasValue(source, canonical, legacy)
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${canonical} must be true or false`)
}

const authenticationConfig = (source: EnvironmentSource): AuthenticationConfig => {
	const config = {
		oidcEnabled: booleanValue(source, 'FABRIKA_IAM_OIDC_ENABLED', 'PROPUSTKA_OIDC_ENABLED', true),
		passwordEnabled: booleanValue(source, 'FABRIKA_IAM_PASSWORD_ENABLED', 'PROPUSTKA_PASSWORD_ENABLED', false),
	}
	if (!config.oidcEnabled && !config.passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	return config
}

const emailConfig = (source: EnvironmentSource): EmailConfig => {
	const provider = source['FABRIKA_EMAIL_PROVIDER'] ?? 'none'
	if (provider !== 'none' && provider !== 'resend') {
		throw new Error('FABRIKA_EMAIL_PROVIDER must be none or resend')
	}
	return { provider, from: source['FABRIKA_EMAIL_FROM'] ?? '' }
}

const remoteConfig = (env: string, domain: string | undefined, source: EnvironmentSource): RemoteConfig => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	const humanEmailDomains = aliasValue(source, 'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'PROPUSTKA_HUMAN_EMAIL_DOMAINS')
	const oidcIssuer = aliasValue(source, 'FABRIKA_IAM_OIDC_ISSUER', 'PROPUSTKA_OIDC_ISSUER')
	const oidcClientId = aliasValue(source, 'FABRIKA_IAM_OIDC_CLIENT_ID', 'PROPUSTKA_OIDC_CLIENT_ID')
	const signingKeys = aliasValue(source, 'FABRIKA_IAM_SIGNING_KEYS', 'PROPUSTKA_SIGNING_KEYS')
	const missing: string[] = []
	if (authentication.oidcEnabled) {
		if (!humanEmailDomains) missing.push('FABRIKA_IAM_HUMAN_EMAIL_DOMAINS')
		if (!oidcIssuer) missing.push('FABRIKA_IAM_OIDC_ISSUER')
		if (!oidcClientId) missing.push('FABRIKA_IAM_OIDC_CLIENT_ID')
		if (!source['OIDC_CLIENT_SECRET']) missing.push('OIDC_CLIENT_SECRET')
	}
	if (!signingKeys) missing.push('FABRIKA_IAM_SIGNING_KEYS')
	if (email.provider === 'resend') {
		if (email.from === '') missing.push('FABRIKA_EMAIL_FROM')
		if (!source['FABRIKA_EMAIL_RESEND_API_KEY']) missing.push('FABRIKA_EMAIL_RESEND_API_KEY')
	}
	if (domain === undefined || domain === '') {
		missing.push('FABRIKA_IAM_HOSTNAME')
	}
	if (missing.length > 0) {
		throw new Error(`Missing ${missing.join(', ')} for env=${env}. Configure them before materializing IAM resources.`)
	}

	return {
		domain: requiredDomain(domain),
		humanEmailDomains: humanEmailDomains ?? '[]',
		adminOrigins: source['FABRIKA_IAM_ADMIN_ORIGINS'] ?? '[]',
		oidcEnabled: authentication.oidcEnabled,
		passwordEnabled: authentication.passwordEnabled,
		oidcIssuer: oidcIssuer ?? '',
		oidcClientId: oidcClientId ?? '',
		emailProvider: email.provider,
		emailFrom: email.from,
	}
}

/**
 * Build IAM's Worker vars. Remote secrets are validated above but excluded here because
 * Oblaka serializes this object into the plaintext `vars` section of `wrangler.jsonc`.
 */
const buildVars = (config: RemoteConfig | 'local', source: EnvironmentSource): Record<string, string> => {
	if (config === 'local') {
		return {
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			// The console's origin, which a local `wrangler dev` does not have. Empty = no browser may
			// write to `/admin/*`; a machine bearer is unaffected.
			ADMIN_ORIGINS: '[]',
			ISSUER: 'http://localhost:18191',
			SESSION_COOKIE_DOMAIN: '',
			// Password-only locally. OIDC is now FATAL when half-configured (one rule on both engines),
			// and a `wrangler dev` has no client id or secret to give it.
			OIDC_ENABLED: 'false',
			PASSWORD_ENABLED: 'true',
			OIDC_ISSUER: '',
			OIDC_CLIENT_ID: '',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			EMAIL_PROVIDER: 'none',
			EMAIL_FROM: '',
		}
	}

	return {
		HUMAN_EMAIL_DOMAINS: config.humanEmailDomains,
		ADMIN_ORIGINS: config.adminOrigins,
		HUMAN_EMAILS: aliasValue(source, 'FABRIKA_IAM_HUMAN_EMAILS', 'PROPUSTKA_HUMAN_EMAILS') ?? '[]',
		IAM_BOOTSTRAP_ADMINS: aliasValue(source, 'FABRIKA_IAM_BOOTSTRAP_ADMINS', 'PROPUSTKA_BOOTSTRAP_ADMINS') ?? '[]',
		ISSUER: `https://${config.domain}`,
		SESSION_COOKIE_DOMAIN: aliasValue(source, 'FABRIKA_IAM_SESSION_COOKIE_DOMAIN', 'PROPUSTKA_SESSION_COOKIE_DOMAIN') ?? '',
		OIDC_ENABLED: String(config.oidcEnabled),
		PASSWORD_ENABLED: String(config.passwordEnabled),
		OIDC_ISSUER: config.oidcIssuer,
		OIDC_CLIENT_ID: config.oidcClientId,
		OIDC_SCOPES: aliasValue(source, 'FABRIKA_IAM_OIDC_SCOPES', 'PROPUSTKA_OIDC_SCOPES') ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: aliasValue(source, 'FABRIKA_IAM_OIDC_REQUIRE_VERIFIED_EMAIL', 'PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL') ?? 'true',
		EMAIL_PROVIDER: config.emailProvider,
		EMAIL_FROM: config.emailFrom,
	}
}

export const iamPipelineVars = (source: EnvironmentSource): string[] => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	return [
		'FABRIKA_IAM_ADMIN_ORIGINS',
		'FABRIKA_IAM_OIDC_ENABLED',
		'FABRIKA_IAM_PASSWORD_ENABLED',
		'FABRIKA_EMAIL_PROVIDER',
		...(authentication.oidcEnabled
			? ['FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'FABRIKA_IAM_OIDC_ISSUER', 'FABRIKA_IAM_OIDC_CLIENT_ID']
			: []),
		...(email.provider === 'resend' ? ['FABRIKA_EMAIL_FROM'] : []),
	]
}

export const iamPipelineSecrets = (source: EnvironmentSource): string[] => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	return [
		'FABRIKA_IAM_SIGNING_KEYS',
		'FABRIKA_IAM_PROVISIONING_KEY',
		...(authentication.oidcEnabled ? ['OIDC_CLIENT_SECRET'] : []),
		...(email.provider === 'resend' ? ['FABRIKA_EMAIL_RESEND_API_KEY'] : []),
	]
}

/**
 * Build IAM's only Cloudflare resource graph. Both fabrika and the standalone Oblaka adapter
 * call this function.
 */
export const buildPropustkaWorker = (ctx: ResourceContext, source: EnvironmentSource = process.env): Worker => {
	const { env } = ctx
	if (!KNOWN_ENVS.has(env)) {
		throw new Error(`Unknown environment ${env}`)
	}

	const runtimeConfig: RemoteConfig | 'local' = env === 'local' ? 'local' : remoteConfig(env, ctx.domain, source)
	const domain = runtimeConfig === 'local' ? undefined : runtimeConfig.domain

	return new Worker({
		dir: '.',
		name: 'propustka-worker',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		// This is the public auth surface. Control reaches admin APIs over a service binding.
		routes: domain === undefined ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { enabled: true },
		// Daily prune of auth_log; see scheduled() in src/index.ts.
		triggers: { crons: ['0 3 * * *'] },
		bindings: {
			DB: new D1Database({ name: 'propustka', migrationsDir: './migrations', locationHint: 'weur' }),
		},
		vars: {
			ENVIRONMENT: env,
			...buildVars(runtimeConfig, source),
		},
	})
}

// IAM's own app schema is intentionally empty.
const schema: AppSchema = { scopes: [], actions: [], roles: {} }

export default defineApp({
	id: IAM_APP_ID,
	resources: buildPropustkaWorker,
	schema,
	pipeline: {
		workerDir: '.',
		// Values stay in fabrika's vault and are provisioned out-of-band from Worker plaintext vars.
		secrets: iamPipelineSecrets(process.env),
		vars: iamPipelineVars(process.env),
	},
})
