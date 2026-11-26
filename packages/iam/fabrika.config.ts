// IAM's deploy surface. This file owns its environment contract and Cloudflare resource graph.
// fabrika loads the default `defineApp` config; the local Oblaka entry imports the same builder.
//
// Non-secret deploy vars come from fabrika's per-app environment registry. Native-auth secrets are
// validated before remote materialization but never enter Worker `vars`, where Oblaka would serialize
// them as plaintext. The Custom Domain route comes from `ctx.domain` (`FABRIKA_IAM_HOSTNAME` in the
// standalone Oblaka adapter).

import { CONTROL_APP_ID, CONTROL_CLI_RESOURCES } from '@fabrika/control-contract'
import { type EmailTransportConfig, readEmailTransportConfig } from '@fabrika/email'
import { isHttpOrigin } from '@fabrika/email/platform'
import { builtinEmailProviders } from '@fabrika/email/providers'
import type { OAuthResourceDto } from '@fabrika/iam-contract'
import {
	D1Database,
	defineApp,
	NO_IMPORTABLE_ENV_FLAG,
	NO_PROCESS_ENV_FLAG,
	platformNames,
	type ResourceContext,
	Worker,
} from '@fabrika/provider-cloudflare'
import {
	assertCloudflareMcpAuthoringOff,
	MCP_CLIENTS_VARIABLE,
	type McpClient,
	parseCloudflareIdentityClients,
} from '@fabrika/provider-cloudflare/installation'
import { parseOAuthConfig } from './src/oauth-config'
import { parseAdminAudiences, platformAudiencesFor } from './src/services'

// Keep the legacy Oblaka namespace so the first fabrika deploy continues the existing cf-state.
const IAM_APP_ID = 'propustka'

const KNOWN_ENVS = new Set(['local', 'stage', 'prod'])

/** Cloudflare refuses a plain Worker variable above this (docs/reference/cloudflare-platform.md). */
const WORKER_VARIABLE_MAX_BYTES = 5120

type EnvironmentSource = Readonly<Record<string, string | undefined>>

interface RemoteConfig {
	domain: string
	humanEmailDomains: string
	/** Absent when the deploy var is unset — IAM then defaults to the console's own app id. */
	adminAudiences?: string
	oidcEnabled: boolean
	passwordEnabled: boolean
	oidcIssuer: string
	oidcClientId: string
	email: EmailTransportConfig
	/** Control's public origin, which IAM's mail goes through when set; absent keeps IAM on its own provider. */
	controlUrl?: string
	/** The operator's identity-bound external clients (ADR-0084); empty registers none. */
	identityClients: readonly McpClient[]
	/** The installation's hostnames (IAM's, the console's and Operations'), which no external application's resource may be on. */
	hosts: readonly string[]
}

interface AuthenticationConfig {
	oidcEnabled: boolean
	passwordEnabled: boolean
}

const requiredDomain = (domain: string | undefined): string => {
	if (domain === undefined || domain === '') {
		throw new Error('Missing FABRIKA_IAM_HOSTNAME')
	}
	return domain
}

const booleanValue = (source: EnvironmentSource, name: string, fallback: boolean): boolean => {
	const raw = source[name]
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${name} must be true or false`)
}

const authenticationConfig = (source: EnvironmentSource): AuthenticationConfig => {
	const config = {
		oidcEnabled: booleanValue(source, 'FABRIKA_IAM_OIDC_ENABLED', true),
		passwordEnabled: booleanValue(source, 'FABRIKA_IAM_PASSWORD_ENABLED', false),
	}
	if (!config.oidcEnabled && !config.passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	return config
}

/** Refuses an unknown provider and lists every missing or invalid `FABRIKA_EMAIL_*` variable, never a value. */
const emailConfig = (source: EnvironmentSource): EmailTransportConfig => readEmailTransportConfig(source, builtinEmailProviders)

/** The transport as plaintext Worker vars: the sender split into address and name, and the provider's non-secret variables. */
const emailVars = (email: EmailTransportConfig, source: EnvironmentSource): Record<string, string> => {
	if (email.kind === 'none') return { FABRIKA_EMAIL_PROVIDER: 'none' }
	const vars: Record<string, string> = { FABRIKA_EMAIL_PROVIDER: email.provider, FABRIKA_EMAIL_FROM: email.from.address }
	if (email.from.name !== undefined) vars['FABRIKA_EMAIL_FROM_NAME'] = email.from.name
	for (const variable of email.variables) {
		const value = source[variable.name]
		if (!variable.secret && value !== undefined && value !== '') vars[variable.name] = value
	}
	return vars
}

const emailVariableNames = (email: EmailTransportConfig, secret: boolean): string[] =>
	email.kind === 'none' ? [] : email.variables.filter((variable) => variable.secret === secret).map((variable) => variable.name)

/**
 * `FABRIKA_CONTROL_URL` as an https origin, or undefined when unset. IAM's Worker reaches Control across the internet
 * with a key that sends mail past the relay's gate, so never in cleartext. The relay knows IAM by a key derived from the
 * provisioning key, so the origin without that key would leave the relay unused.
 */
const controlUrl = (source: EnvironmentSource): string | undefined => {
	const raw = source['FABRIKA_CONTROL_URL']
	if (raw === undefined || raw === '') return undefined
	if (!isHttpOrigin(raw) || !raw.startsWith('https://')) {
		throw new Error('FABRIKA_CONTROL_URL must be an https origin, with no path and no trailing slash')
	}
	if (!source['FABRIKA_IAM_PROVISIONING_KEY']?.trim()) {
		throw new Error('FABRIKA_CONTROL_URL needs FABRIKA_IAM_PROVISIONING_KEY, which the mail relay authenticates IAM by')
	}
	return raw
}

/**
 * IAM's `OAUTH_CONFIG` on a Cloudflare installation: the command-line client's resources on the console's origin,
 * recomputed on every deploy so a release that changes the presets converges with no other step, the operator's
 * identity-bound external clients (ADR-0084), which IAM serves until it has imported them (ADR-0089), and the
 * installation's hosts, which IAM checks a registered external application against. No MCP client yet: MCP authoring
 * is not supported on Cloudflare. Without a console origin OAuth stays off. The result passes IAM's own boot parser
 * here, so a value IAM would refuse stops the deploy instead.
 */
const oauthConfig = (
	control: string | undefined,
	clients: readonly McpClient[],
	hosts: readonly string[],
	adminAudiences: string | undefined,
): string => {
	if (control === undefined) {
		if (clients.length > 0) throw new Error(`${MCP_CLIENTS_VARIABLE} needs FABRIKA_CONTROL_URL, without which IAM serves no OAuth`)
		return ''
	}
	const resources: OAuthResourceDto[] = CONTROL_CLI_RESOURCES.map(({ path, grants }) => ({
		app: CONTROL_APP_ID,
		resource: `${control}${path}`,
		scopeGrants: grants.map((grant) => ({
			scope: grant.scope,
			...(grant.parameter === undefined ? {} : { parameter: grant.parameter }),
			permissions: grant.actions.map((action) => ({ action })),
		})),
		client: 'cli',
	}))
	const config = JSON.stringify({ clients, resources, hosts })
	parseOAuthConfig(config, platformAudiencesFor(parseAdminAudiences(adminAudiences)))
	if (new TextEncoder().encode(config).length > WORKER_VARIABLE_MAX_BYTES) {
		throw new Error(
			`${MCP_CLIENTS_VARIABLE} with the installation's hosts makes OAUTH_CONFIG longer than a Worker variable holds `
				+ `(${WORKER_VARIABLE_MAX_BYTES} bytes); register the clients that do not fit in the console instead`,
		)
	}
	return config
}

const remoteConfig = (env: string, domain: string | undefined, source: EnvironmentSource): RemoteConfig => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	const control = controlUrl(source)
	const operationsHost = source['OPERATIONS_HOSTNAME']
	// Spelled as a URL spells a hostname, the only form IAM's parser takes.
	const hosts = [
		...new Set([
			...(domain === undefined || domain === '' ? [] : [domain.toLowerCase()]),
			...(control === undefined ? [] : [new URL(control).hostname]),
			...(operationsHost === undefined || operationsHost === '' ? [] : [operationsHost.toLowerCase()]),
		]),
	]
	const identityClients = parseCloudflareIdentityClients(source[MCP_CLIENTS_VARIABLE], hosts) ?? []
	assertCloudflareMcpAuthoringOff(source)
	const humanEmailDomains = source['FABRIKA_IAM_HUMAN_EMAIL_DOMAINS']
	const oidcIssuer = source['FABRIKA_IAM_OIDC_ISSUER']
	const oidcClientId = source['FABRIKA_IAM_OIDC_CLIENT_ID']
	const signingKeys = source['FABRIKA_IAM_SIGNING_KEYS']
	const adminAudiences = source['FABRIKA_IAM_ADMIN_AUDIENCES']
	const missing: string[] = []
	if (authentication.oidcEnabled) {
		if (!humanEmailDomains) missing.push('FABRIKA_IAM_HUMAN_EMAIL_DOMAINS')
		if (!oidcIssuer) missing.push('FABRIKA_IAM_OIDC_ISSUER')
		if (!oidcClientId) missing.push('FABRIKA_IAM_OIDC_CLIENT_ID')
		if (!source['OIDC_CLIENT_SECRET']) missing.push('OIDC_CLIENT_SECRET')
	}
	if (!signingKeys) missing.push('FABRIKA_IAM_SIGNING_KEYS')
	if (domain === undefined || domain === '') {
		missing.push('FABRIKA_IAM_HOSTNAME')
	}
	if (missing.length > 0) {
		throw new Error(`Missing ${missing.join(', ')} for env=${env}. Configure them before materializing IAM resources.`)
	}

	return {
		domain: requiredDomain(domain),
		humanEmailDomains: humanEmailDomains ?? '[]',
		...(adminAudiences === undefined ? {} : { adminAudiences }),
		oidcEnabled: authentication.oidcEnabled,
		passwordEnabled: authentication.passwordEnabled,
		oidcIssuer: oidcIssuer ?? '',
		oidcClientId: oidcClientId ?? '',
		email,
		...(control === undefined ? {} : { controlUrl: control }),
		identityClients,
		hosts,
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
			OAUTH_CONFIG: source['FABRIKA_IAM_OAUTH_CONFIG'] ?? '',
			ISSUER: 'http://localhost:18191',
			// Password-only locally. OIDC is now FATAL when half-configured (one rule on both engines),
			// and a `wrangler dev` has no client id or secret to give it.
			OIDC_ENABLED: 'false',
			PASSWORD_ENABLED: 'true',
			OIDC_ISSUER: '',
			OIDC_CLIENT_ID: '',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			FABRIKA_EMAIL_PROVIDER: 'none',
		}
	}

	return {
		HUMAN_EMAIL_DOMAINS: config.humanEmailDomains,
		OAUTH_CONFIG: oauthConfig(config.controlUrl, config.identityClients, config.hosts, config.adminAudiences),
		// Only when named: an empty ADMIN_AUDIENCES means "no JWT may administer", so a `?? ''`
		// default would lock the console out of every install instead of falling back to its app id.
		...(config.adminAudiences === undefined ? {} : { ADMIN_AUDIENCES: config.adminAudiences }),
		...settingVars(source),
		HUMAN_EMAILS: source['FABRIKA_IAM_HUMAN_EMAILS'] ?? '[]',
		IAM_BOOTSTRAP_ADMINS: source['FABRIKA_IAM_BOOTSTRAP_ADMINS'] ?? '[]',
		ISSUER: `https://${config.domain}`,
		OIDC_ENABLED: String(config.oidcEnabled),
		PASSWORD_ENABLED: String(config.passwordEnabled),
		OIDC_ISSUER: config.oidcIssuer,
		OIDC_CLIENT_ID: config.oidcClientId,
		OIDC_SCOPES: source['FABRIKA_IAM_OIDC_SCOPES'] ?? '',
		OIDC_REQUIRE_VERIFIED_EMAIL: source['FABRIKA_IAM_OIDC_REQUIRE_VERIFIED_EMAIL'] ?? 'true',
		...emailVars(config.email, source),
		...(config.controlUrl === undefined ? {} : { FABRIKA_CONTROL_URL: config.controlUrl }),
	}
}

/**
 * The operator's retention and OIDC session settings, only where set: unset keeps IAM's defaults (30 days, audit
 * kept, a 12-hour OIDC login).
 */
const settingVars = (source: EnvironmentSource): Record<string, string> => {
	const authLog = source['FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS']
	const audit = source['FABRIKA_IAM_AUDIT_RETENTION_DAYS']
	const oidcSession = source['FABRIKA_IAM_OIDC_SESSION_HOURS']
	return {
		...(authLog === undefined || authLog === '' ? {} : { AUTH_LOG_RETENTION_DAYS: authLog }),
		...(audit === undefined || audit === '' ? {} : { AUDIT_RETENTION_DAYS: audit }),
		...(oidcSession === undefined || oidcSession === '' ? {} : { OIDC_SESSION_HOURS: oidcSession }),
	}
}

export const iamPipelineVars = (source: EnvironmentSource): string[] => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	return [
		'FABRIKA_IAM_ADMIN_AUDIENCES',
		'FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS',
		'FABRIKA_IAM_AUDIT_RETENTION_DAYS',
		'FABRIKA_IAM_OIDC_SESSION_HOURS',
		'FABRIKA_IAM_OIDC_ENABLED',
		'FABRIKA_IAM_PASSWORD_ENABLED',
		'FABRIKA_EMAIL_PROVIDER',
		'FABRIKA_CONTROL_URL',
		...(authentication.oidcEnabled
			? ['FABRIKA_IAM_HUMAN_EMAIL_DOMAINS', 'FABRIKA_IAM_OIDC_ISSUER', 'FABRIKA_IAM_OIDC_CLIENT_ID']
			: []),
		...(email.kind === 'provider' ? ['FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_FROM_NAME', ...emailVariableNames(email, false)] : []),
	]
}

export const iamPipelineSecrets = (source: EnvironmentSource): string[] => {
	const authentication = authenticationConfig(source)
	const email = emailConfig(source)
	return [
		'FABRIKA_IAM_SIGNING_KEYS',
		'FABRIKA_IAM_PROVISIONING_KEY',
		// Optional: an installation from before TOTP has none until its operator adds it, and must keep deploying.
		...(source['FABRIKA_IAM_DATA_KEY'] ? ['FABRIKA_IAM_DATA_KEY'] : []),
		...(authentication.oidcEnabled ? ['OIDC_CLIENT_SECRET'] : []),
		...emailVariableNames(email, true),
	]
}

/**
 * Build IAM's only Cloudflare resource graph. Both fabrika and the standalone Oblaka adapter
 * call this function.
 */
export const buildIamWorker = (ctx: ResourceContext, source: EnvironmentSource = process.env): Worker => {
	const { env } = ctx
	if (!KNOWN_ENVS.has(env)) {
		throw new Error(`Unknown environment ${env}`)
	}

	const runtimeConfig: RemoteConfig | 'local' = env === 'local' ? 'local' : remoteConfig(env, ctx.domain, source)
	const domain = runtimeConfig === 'local' ? undefined : runtimeConfig.domain
	const names = platformNames(source)

	return new Worker({
		dir: '.',
		name: names.iamWorker,
		main: './src/index.ts',
		// `process.env` and the importable `env` of `cloudflare:workers` stay empty: otherwise each could hold every secret,
		// the signing keys included, for any bundled module to read (`nodejs_compat_v2` alone already leaves `process.env`
		// empty). IAM reads its configuration from the Worker's `env` only.
		compatibility_flags: ['nodejs_compat_v2', NO_PROCESS_ENV_FLAG, NO_IMPORTABLE_ENV_FLAG],
		compatibility_date: '2025-10-01',
		// This is the public auth surface. Control reaches admin APIs over a service binding.
		routes: domain === undefined ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { enabled: true },
		// Daily prune of auth_log; see scheduled() in src/index.ts.
		triggers: { crons: ['0 3 * * *'] },
		bindings: {
			DB: new D1Database({ name: names.iamDatabase, migrationsDir: './migrations', locationHint: 'weur' }),
		},
		vars: {
			ENVIRONMENT: env,
			...buildVars(runtimeConfig, source),
		},
	})
}

export default defineApp({
	id: IAM_APP_ID,
	resources: buildIamWorker,
	pipeline: {
		workerDir: '.',
		// Values stay in fabrika's vault and are provisioned out-of-band from Worker plaintext vars.
		secrets: iamPipelineSecrets(process.env),
		vars: iamPipelineVars(process.env),
	},
})
