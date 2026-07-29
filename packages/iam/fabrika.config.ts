// propustka's deploy surface. This file owns its environment contract and Cloudflare resource graph.
// fabrika loads the default `defineApp` config; the local Oblaka entry imports the same builder.
//
// Non-secret deploy vars come from fabrika's per-app environment registry. Native-auth secrets are
// validated before remote materialization but never enter Worker `vars`, where Oblaka would serialize
// them as plaintext. The Custom Domain route comes from `ctx.domain` (`PROPUSTKA_HOSTNAME` in the
// standalone Oblaka adapter).

import type { AppSchema } from '@fabrika/auth-core'
import { D1Database, defineApp, type ResourceContext, Worker } from '@fabrika/provider-cloudflare'

// Keep the legacy Oblaka namespace so the first fabrika deploy continues the existing cf-state.
const PROPUSTKA_APP_ID = 'propustka'

const REQUIRED_VARS = ['PROPUSTKA_HUMAN_EMAIL_DOMAINS', 'PROPUSTKA_OIDC_ISSUER', 'PROPUSTKA_OIDC_CLIENT_ID']
const REQUIRED_REMOTE_INPUTS = [
	...REQUIRED_VARS,
	'PROPUSTKA_SIGNING_KEYS',
	'OIDC_CLIENT_SECRET',
]
const KNOWN_ENVS = new Set(['local', 'stage', 'prod', 'mangoweb'])

type EnvironmentSource = Readonly<Record<string, string | undefined>>

interface RemoteConfig {
	domain: string
	humanEmailDomains: string
	oidcIssuer: string
	oidcClientId: string
}

const requiredValue = (source: EnvironmentSource, name: string): string => {
	const value = source[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing ${name}`)
	}
	return value
}

const requiredDomain = (domain: string | undefined): string => {
	if (domain === undefined || domain === '') {
		throw new Error('Missing PROPUSTKA_HOSTNAME')
	}
	return domain
}

const remoteConfig = (env: string, domain: string | undefined, source: EnvironmentSource): RemoteConfig => {
	const missing = REQUIRED_REMOTE_INPUTS.filter((name) => !source[name])
	if (domain === undefined || domain === '') {
		missing.push('PROPUSTKA_HOSTNAME')
	}
	if (missing.length > 0) {
		throw new Error(`Missing ${missing.join(', ')} for env=${env}. Configure them before materializing IAM resources.`)
	}

	return {
		domain: requiredDomain(domain),
		humanEmailDomains: requiredValue(source, 'PROPUSTKA_HUMAN_EMAIL_DOMAINS'),
		oidcIssuer: requiredValue(source, 'PROPUSTKA_OIDC_ISSUER'),
		oidcClientId: requiredValue(source, 'PROPUSTKA_OIDC_CLIENT_ID'),
	}
}

/**
 * Build propustka's Worker vars. Remote secrets are validated above but excluded here because
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
		HUMAN_EMAILS: source['PROPUSTKA_HUMAN_EMAILS'] ?? '[]',
		IAM_BOOTSTRAP_ADMINS: source['PROPUSTKA_BOOTSTRAP_ADMINS'] ?? '[]',
		ISSUER: `https://${config.domain}`,
		SESSION_COOKIE_DOMAIN: source['PROPUSTKA_SESSION_COOKIE_DOMAIN'] ?? '',
		OIDC_ISSUER: config.oidcIssuer,
		OIDC_CLIENT_ID: config.oidcClientId,
		OIDC_SCOPES: source['PROPUSTKA_OIDC_SCOPES'] ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: source['PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL'] ?? 'true',
	}
}

/**
 * Build propustka's only Cloudflare resource graph. Both fabrika and the standalone Oblaka adapter
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
		// This is the human-facing admin and auth surface. App Workers use a service binding.
		routes: domain === undefined ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { enabled: true },
		// Daily prune of auth_log; see scheduled() in src/index.ts.
		triggers: { crons: ['0 3 * * *'] },
		assets: {
			directory: '../iam-ui/dist',
			binding: 'ASSETS',
			not_found_handling: 'single-page-application',
			// Run fetch() first so the native admin and auth gates protect their routes.
			run_worker_first: true,
		},
		bindings: {
			DB: new D1Database({ name: 'propustka', migrationsDir: './migrations', locationHint: 'weur' }),
		},
		vars: {
			ENVIRONMENT: env,
			...buildVars(runtimeConfig, source),
		},
	})
}

// propustka is the IAM system, so its own app schema is intentionally empty.
const schema: AppSchema = { scopes: [], actions: [], roles: {} }

export default defineApp({
	id: PROPUSTKA_APP_ID,
	resources: buildPropustkaWorker,
	schema,
	pipeline: {
		workerDir: '.',
		build: 'bun run --filter @fabrika/iam-ui build',
		// Values stay in fabrika's vault and are provisioned out-of-band from Worker plaintext vars.
		secrets: ['PROPUSTKA_SIGNING_KEYS', 'OIDC_CLIENT_SECRET', 'PROPUSTKA_PROVISIONING_KEY'],
		// Optional list values use safe empty-array defaults and do not belong in this required set.
		vars: REQUIRED_VARS,
	},
})
