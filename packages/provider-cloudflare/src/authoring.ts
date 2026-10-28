import { GENERATED_ENTRY_FILE } from '@fabrika/app/build'
import { isFrameworkVariableName } from '@fabrika/auth-core'
import { APP_PROVIDER, type AppConfigBase, isProviderAuthoredApp, type ProviderAuthoredApp } from '@fabrika/provider-contract'
import { Worker } from 'oblaka-iac'
import { iamServiceReference } from './proxy'

/** Inputs used to materialize one environment's Cloudflare resource graph. */
export interface ResourceContext {
	readonly env: string
	readonly domain?: string
}

/** What an author may set on the application Worker `defineApp` builds; everything else is fixed by the platform. */
export interface ApplicationWorkerOptions {
	/** The application's own bindings, beside `IAM`, which is always the platform's. */
	readonly bindings?: Worker['options']['bindings']
	readonly compatibility_date?: string
	readonly compatibility_flags?: Worker['options']['compatibility_flags']
}

/**
 * Postgres through Cloudflare Hyperdrive instead of the Durable Object's SQLite. `fabrika.config.ts` states it inline in
 * the `defineApp` argument, with literal values: Control reads it statically.
 */
export interface CloudflarePostgresDatabase {
	readonly kind: 'postgres'
	/**
	 * The application secret (set in Control per environment; never in pipeline.secrets or vars) holding the provisioning
	 * URL: a direct connection of a role that may create roles. An upper-case name, not a `FABRIKA_*` one.
	 */
	readonly provisioningSecret: string
}

/** The upper-case name of an application secret, as Control's vault names one. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * The application's database as its config states it, validated: a loaded config is checkout code, so its shape is not
 * trusted. Null for the Durable Object's SQLite (no `database`).
 */
export const configDatabase = (value: unknown): CloudflarePostgresDatabase | null => {
	if (value === undefined) return null
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error("cloudflare: `database` is not `{ kind: 'postgres', provisioningSecret: '<SECRET>' }`")
	}
	const keys = Object.keys(value).sort().join(',')
	const kind: unknown = Reflect.get(value, 'kind')
	const provisioningSecret: unknown = Reflect.get(value, 'provisioningSecret')
	if (keys !== 'kind,provisioningSecret' || kind !== 'postgres' || typeof provisioningSecret !== 'string') {
		throw new Error("cloudflare: `database` is not `{ kind: 'postgres', provisioningSecret: '<SECRET>' }`")
	}
	if (!SECRET_NAME.test(provisioningSecret) || isFrameworkVariableName(provisioningSecret) || provisioningSecret.startsWith('FABRIKA_')) {
		throw new Error(
			`cloudflare: \`database.provisioningSecret\` \`${provisioningSecret}\` is not an application secret name (upper-case letters, digits and _, not FABRIKA_*)`,
		)
	}
	return { kind: 'postgres', provisioningSecret }
}

/** A Cloudflare app config as `fabrika.config.ts` writes it. */
export type CloudflareAppConfigInput =
	& AppConfigBase
	& {
		/** The database the application runs on; absent = the Durable Object's SQLite (ADR-0065). */
		readonly database?: CloudflarePostgresDatabase
	}
	& (
		| {
			/**
			 * The application Worker, for a config that composes its own. The deployer builds the proxy Worker in front of it
			 * from the contract (ADR-0048); never return one.
			 */
			readonly resources: (ctx: ResourceContext) => Worker
			readonly worker?: never
		}
		| {
			readonly resources?: never
			/** Without `resources`, `defineApp` builds the application Worker from these and the platform's fixed values. */
			readonly worker?: ApplicationWorkerOptions
		}
	)

/** A Cloudflare app config loaded from `fabrika.config.ts` inside the runner checkout. */
export interface CloudflareAppConfig extends AppConfigBase, ProviderAuthoredApp<'cloudflare'> {
	/** The application Worker. The deployer builds the proxy Worker in front of it from the contract (ADR-0048). */
	readonly resources: (ctx: ResourceContext) => Worker
	/** The database the application runs on; absent = the Durable Object's SQLite (ADR-0065). */
	readonly database?: CloudflarePostgresDatabase
}

/**
 * The application Worker of a config without `resources`: the values the bounds require of every application Worker
 * (the generated entry, no route, no public URL, IAM at its application entrypoint) and the Worker name `<app>`, so its
 * remote name is the deployment's own `<env>-<app>`.
 */
const applicationWorker = (id: string, options: ApplicationWorkerOptions = {}): Worker =>
	new Worker({
		dir: '.',
		name: id,
		main: `./${GENERATED_ENTRY_FILE}`,
		compatibility_date: options.compatibility_date ?? '2025-10-01',
		compatibility_flags: [...(options.compatibility_flags ?? ['nodejs_compat_v2'])],
		observability: { enabled: true },
		workers_dev: false,
		preview_urls: false,
		routes: [],
		bindings: { ...options.bindings, IAM: iamServiceReference() },
	})

/**
 * Validate the app id and the database, and fill in the application Worker when the config composes none. The result always carries
 * `resources`, because a runner narrows a loaded config with `isCloudflareAppConfig`, which requires it.
 */
export function defineApp(config: CloudflareAppConfigInput): CloudflareAppConfig {
	if (typeof config.id !== 'string' || config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	const { resources, worker, database, ...rest } = config
	const postgres = configDatabase(database)
	return {
		...rest,
		...(postgres === null ? {} : { database: postgres }),
		resources: resources ?? (() => applicationWorker(config.id, worker)),
		[APP_PROVIDER]: 'cloudflare',
	}
}

/** Narrow an imported module default without trusting code from the checkout. */
export const isCloudflareAppConfig = (value: unknown): value is CloudflareAppConfig =>
	isProviderAuthoredApp(value, 'cloudflare')
	&& typeof value === 'object'
	&& value !== null
	&& 'id' in value
	&& typeof value.id === 'string'
	&& value.id.trim() !== ''
	&& 'resources' in value
	&& typeof value.resources === 'function'
