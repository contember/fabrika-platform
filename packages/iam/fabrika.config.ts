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

const REQUIRED_VARS = ['FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'FABRIKA_IAM_OIDC_ISSUER', 'FABRIKA_IAM_OIDC_CLIENT_ID']
const KNOWN_ENVS = new Set(['local', 'stage', 'prod', 'mangoweb'])

type EnvironmentSource = Readonly<Record<string, string | undefined>>

interface RemoteConfig {
	domain: string
	humanEmailDomains: string
	oidcIssuer: string
	oidcClientId: string
}

const aliasValue = (source: EnvironmentSource, canonical: string, legacy: string): string | undefined =>
	environmentAliases.read(source, { canonical, legacy })

const requiredAlias = (source: EnvironmentSource, canonical: string, legacy: string): string => {
	const value = aliasValue(source, canonical, legacy)
	if (value === undefined || value === '') {
		throw new Error(`Missing ${canonical}`)
	}
	return value
}

const requiredDomain = (domain: string | undefined): string => {
	if (domain === undefined || domain === '') {
		throw new Error('Missing FABRIKA_IAM_HOSTNAME')
	}
	return domain
}

const remoteConfig = (env: string, domain: string | undefined, source: EnvironmentSource): RemoteConfig => {
	const humanEmailDomains = aliasValue(source, 'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'PROPUSTKA_HUMAN_EMAIL_DOMAINS')
	const oidcIssuer = aliasValue(source, 'FABRIKA_IAM_OIDC_ISSUER', 'PROPUSTKA_OIDC_ISSUER')
	const oidcClientId = aliasValue(source, 'FABRIKA_IAM_OIDC_CLIENT_ID', 'PROPUSTKA_OIDC_CLIENT_ID')
	const signingKeys = aliasValue(source, 'FABRIKA_IAM_SIGNING_KEYS', 'PROPUSTKA_SIGNING_KEYS')
	const missing: string[] = []
	if (!humanEmailDomains) missing.push('FABRIKA_IAM_HUMAN_EMAIL_DOMAINS')
	if (!oidcIssuer) missing.push('FABRIKA_IAM_OIDC_ISSUER')
	if (!oidcClientId) missing.push('FABRIKA_IAM_OIDC_CLIENT_ID')
	if (!signingKeys) missing.push('FABRIKA_IAM_SIGNING_KEYS')
	if (!source['OIDC_CLIENT_SECRET']) missing.push('OIDC_CLIENT_SECRET')
	if (domain === undefined || domain === '') {
		missing.push('FABRIKA_IAM_HOSTNAME')
	}
	if (missing.length > 0) {
		throw new Error(`Missing ${missing.join(', ')} for env=${env}. Configure them before materializing IAM resources.`)
	}

	return {
		domain: requiredDomain(domain),
		humanEmailDomains: requiredAlias(source, 'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'PROPUSTKA_HUMAN_EMAIL_DOMAINS'),
		oidcIssuer: requiredAlias(source, 'FABRIKA_IAM_OIDC_ISSUER', 'PROPUSTKA_OIDC_ISSUER'),
		oidcClientId: requiredAlias(source, 'FABRIKA_IAM_OIDC_CLIENT_ID', 'PROPUSTKA_OIDC_CLIENT_ID'),
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
			ISSUER: 'http://localhost:18191',
			SESSION_COOKIE_DOMAIN: '',
			OIDC_ISSUER: 'https://accounts.google.com',
			OIDC_CLIENT_ID: '',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
	}

	return {
		HUMAN_EMAIL_DOMAINS: config.humanEmailDomains,
		HUMAN_EMAILS: aliasValue(source, 'FABRIKA_IAM_HUMAN_EMAILS', 'PROPUSTKA_HUMAN_EMAILS') ?? '[]',
		IAM_BOOTSTRAP_ADMINS: aliasValue(source, 'FABRIKA_IAM_BOOTSTRAP_ADMINS', 'PROPUSTKA_BOOTSTRAP_ADMINS') ?? '[]',
		ISSUER: `https://${config.domain}`,
		SESSION_COOKIE_DOMAIN: aliasValue(source, 'FABRIKA_IAM_SESSION_COOKIE_DOMAIN', 'PROPUSTKA_SESSION_COOKIE_DOMAIN') ?? '',
		OIDC_ISSUER: config.oidcIssuer,
		OIDC_CLIENT_ID: config.oidcClientId,
		OIDC_SCOPES: aliasValue(source, 'FABRIKA_IAM_OIDC_SCOPES', 'PROPUSTKA_OIDC_SCOPES') ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: aliasValue(source, 'FABRIKA_IAM_OIDC_REQUIRE_VERIFIED_EMAIL', 'PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL') ?? 'true',
	}
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
		secrets: ['FABRIKA_IAM_SIGNING_KEYS', 'OIDC_CLIENT_SECRET', 'FABRIKA_IAM_PROVISIONING_KEY'],
		// Optional list values use safe empty-array defaults and do not belong in this required set.
		vars: REQUIRED_VARS,
	},
})
