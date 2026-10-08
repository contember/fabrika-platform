import { type AppEnvironment, parseAppEnvironmentId } from '@fabrika/auth-core'
import { FABRIKA_PROXY_MANIFEST_JSON, isContractProxyApp, isProxyHost, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { Container, D1Database, type GeneratedConfig, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import type { CloudflareAppConfig } from './authoring'
import { CLOUDFLARE_PROXY_WORKER_DIR, CLOUDFLARE_PROXY_WORKER_MAIN, IAM_APPLICATION_ENTRYPOINT, IAM_SERVICE } from './proxy'

export type CloudflareStepKind = 'build' | 'provision-resources' | 'migrate' | 'deploy-worker' | 'reconcile-schema' | 'sync-secrets'

export interface CloudflareStep {
	readonly id: string
	readonly kind: CloudflareStepKind
	readonly description: string
}

export interface MigratableDatabase {
	readonly binding: string
	readonly name: string
}

const migratableDatabaseName = (value: unknown): string | null => {
	if (typeof value !== 'object' || value === null || !('options' in value)) {
		return null
	}
	const { options } = value
	if (typeof options !== 'object' || options === null) {
		return null
	}
	if (!('migrationsDir' in options) || typeof options.migrationsDir !== 'string' || options.migrationsDir === '') {
		return null
	}
	return 'name' in options && typeof options.name === 'string' ? options.name : null
}

export const findMigratableDatabases = (worker: Worker): MigratableDatabase[] => {
	const databases: MigratableDatabase[] = []
	const visit = (current: Worker, prefix: string): void => {
		for (const [binding, value] of Object.entries(current.options.bindings ?? {})) {
			const qualifiedBinding = prefix === '' ? binding : `${prefix}.${binding}`
			const name = migratableDatabaseName(value)
			if (name !== null) {
				databases.push({ binding: qualifiedBinding, name })
			}
			if (value instanceof Worker) {
				visit(value, qualifiedBinding)
			}
		}
	}
	visit(worker, '')
	return databases
}

/**
 * Every resource name fabrika's own components declare (control, IAM, Operations, the runner and the
 * installation's oblaka state). oblaka ADOPTS an existing `${env}-${name}`, so a checkout that names
 * one would take over the platform's own Worker, database or bucket.
 */
export const PLATFORM_RESOURCE_NAMES: ReadonlySet<string> = new Set([
	'vozka',
	'vozka-proxy',
	'vozka-runner',
	'vozka-deploy',
	'vozka-deploy-runner',
	'vozka-run-logs',
	'propustka',
	'propustka-worker',
	'propustka-state',
	'operations',
	'operations-proxy',
	'operations-payloads',
	'operations-ingest',
	'operations-ingest-dlq',
])

const namedResource = (value: unknown): { readonly kind: string; readonly name: string } | null => {
	if (value instanceof Worker) return { kind: 'Worker', name: value.options.name }
	if (value instanceof D1Database) return { kind: 'D1 database', name: value.options.name }
	if (value instanceof KVNamespace) return { kind: 'KV namespace', name: value.options.name }
	if (value instanceof R2Bucket) return { kind: 'R2 bucket', name: value.options.name }
	if (value instanceof Queue) return { kind: 'queue', name: value.options.name }
	if (value instanceof Container) return { kind: 'container', name: value.options.name }
	return null
}

/**
 * A `ServiceReference` binds `${env}-${name}` without declaring it, so it never reaches `namedResource`
 * — it is how an app would call the control plane or the runner directly. IAM is the one exception:
 * every app binds `propustka-worker` (`proxy.ts`), the platform's front door, at its narrow entrypoint.
 */
const serviceReferenceTarget = (value: unknown): string | null => {
	if (!(value instanceof ServiceReference)) return null
	const target = Reflect.get(value, 'serviceName')
	return typeof target === 'string' && target !== '' ? target : '(unreadable)'
}

type WranglerConfig = GeneratedConfig['config']

/** What a Worker's bindings write into its wrangler config, folded in oblaka's order. */
const emittedBindingConfig = (worker: Worker, env: string): WranglerConfig => {
	let config: WranglerConfig = {}
	for (const [binding, value] of Object.entries(worker.options.bindings ?? {})) {
		config = value.configureBinding({ config, binding, env })
	}
	return config
}

const platformRemoteName = (remote: string): string | null => {
	for (const platform of PLATFORM_RESOURCE_NAMES) {
		if (remote === platform || remote.endsWith(`-${platform}`)) return platform
	}
	return null
}

/** The deployment being deployed, and every Cloudflare deployment of the installation in Control's registry. */
export interface ApplicationNames {
	readonly self: AppEnvironment
	readonly installation: readonly AppEnvironment[]
}

/**
 * The other application whose names `remote` falls under, or null. oblaka adopts `${env}-${name}`, and an application's
 * names are `${env}-${app}` and `${env}-${app}-…`. The longest prefix decides, so `notes-admin` keeps its own names
 * from `notes`; a prefix that two applications share is refused.
 */
const foreignApplication = (remote: string, { self, installation }: ApplicationNames): AppEnvironment | null => {
	let longest = 0
	let owner: AppEnvironment | null = null
	for (const deployment of [self, ...installation]) {
		const prefix = `${deployment.env}-${deployment.app}`
		if (remote !== prefix && !remote.startsWith(`${prefix}-`)) continue
		if (prefix.length > longest) {
			longest = prefix.length
			owner = deployment
		} else if (prefix.length === longest && deployment.app !== self.app) {
			owner = deployment
		}
	}
	return owner === null || owner.app === self.app ? null : owner
}

/** `subject` reads as the start of the refusal: "Worker `demo` binds service" or "D1 database `db` becomes". */
const assertOwnName = (subject: string, remote: string, names: ApplicationNames): void => {
	const owner = foreignApplication(remote, names)
	if (owner !== null) {
		throw new Error(
			`cloudflare: ${subject} \`${remote}\`, a name of application \`${owner.app}\` (environment \`${owner.env}\`); an application binds only its own resources`,
		)
	}
}

/**
 * Check the `services` a Worker's wrangler config CARRIES, not the object that wrote them: a custom
 * `Bindable`, or a `ServiceReference` subclass, can emit any entry. The one platform service an
 * application may bind is IAM, and only at `IAM_APPLICATION_ENTRYPOINT`; the default export issues keys.
 * Another application's Worker is never bound.
 */
export const assertApplicationServices = (worker: string, services: unknown, names: ApplicationNames): void => {
	if (services === undefined) return
	if (!Array.isArray(services)) {
		throw new Error(`cloudflare: Worker \`${worker}\` emits unreadable \`services\`, which cannot be checked against the Fabrika platform services`)
	}
	const env = names.self.env
	const iam = env === 'local' ? IAM_SERVICE : `${env}-${IAM_SERVICE}`
	for (const entry of services) {
		const service: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'service') : undefined
		const entrypoint: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'entrypoint') : undefined
		if (typeof service !== 'string') {
			throw new Error(`cloudflare: Worker \`${worker}\` emits a service binding with no readable \`service\``)
		}
		if (service === iam) {
			if (entrypoint !== IAM_APPLICATION_ENTRYPOINT) {
				const bound = entrypoint === undefined ? 'its default entrypoint' : `entrypoint \`${String(entrypoint)}\``
				throw new Error(
					`cloudflare: Worker \`${worker}\` binds \`${service}\` to ${bound}; an application binds \`${IAM_APPLICATION_ENTRYPOINT}\` (use \`iamServiceReference()\`)`,
				)
			}
			continue
		}
		const platform = platformRemoteName(service)
		if (platform !== null) {
			throw new Error(`cloudflare: Worker \`${worker}\` binds service \`${service}\`, which is the Fabrika platform resource \`${platform}\``)
		}
		assertOwnName(`Worker \`${worker}\` binds service`, service, names)
	}
}

const routeHostname = (route: unknown): string | null => {
	const pattern = typeof route === 'string' ? route : typeof route === 'object' && route !== null ? Reflect.get(route, 'pattern') : undefined
	if (typeof pattern !== 'string') return null
	const host = pattern.split('/')[0]
	return host === undefined ? null : host.toLowerCase()
}

const applicationChain = (root: Worker): ReadonlySet<Worker> => {
	const chain = new Set<Worker>()
	let current: unknown = root
	while (current instanceof Worker) {
		chain.add(current)
		current = current.options.bindings?.['APP']
	}
	return chain
}

/** A checkout's `bun install` puts its own copy of this package under `node_modules`, flat or in Bun's store. */
const INSTALLED_PROXY_WORKER_DIR = /(^|\/)node_modules\/@fabrika\/provider-cloudflare\/src\/?$/

/**
 * Only the Worker `createCloudflareProxyWorker` builds — this package's entrypoint, from this package's
 * directory, bound to an `APP` — may own a public route. Any other root runs the app's own code.
 */
const isProviderProxyWorker = (worker: Worker): boolean =>
	worker.options.main === CLOUDFLARE_PROXY_WORKER_MAIN
	&& (worker.options.dir === CLOUDFLARE_PROXY_WORKER_DIR || INSTALLED_PROXY_WORKER_DIR.test(worker.options.dir))
	&& worker.options.bindings?.['APP'] instanceof Worker

/** The Workers that run the app's own code: the whole chain, except a root that is the provider's proxy. */
const applicationWorkers = (root: Worker, chain: ReadonlySet<Worker>): ReadonlySet<Worker> =>
	isProviderProxyWorker(root) ? new Set([...chain].filter((worker) => worker !== root)) : chain

/**
 * An application Worker is reachable only through its proxy's service binding (ADR-0048), so nothing may
 * route it, and `workers.dev` and preview URLs must be off: Cloudflare enables both by default.
 */
const assertUnexposedApplication = (worker: Worker): void => {
	const name = worker.options.name
	const routes: unknown = worker.options.routes
	if (routes !== undefined && !(Array.isArray(routes) && routes.length === 0)) {
		throw new Error(`cloudflare: application Worker \`${name}\` declares \`routes\`; only its proxy Worker is routed (omit it or set \`[]\`)`)
	}
	if (worker.options.workers_dev !== false) {
		throw new Error(
			`cloudflare: application Worker \`${name}\` leaves \`workers_dev\` on; it would be public on workers.dev (set \`workers_dev: false\`)`,
		)
	}
	if (worker.options.preview_urls !== false) {
		throw new Error(
			`cloudflare: application Worker \`${name}\` leaves \`preview_urls\` on; every version would be public on workers.dev (set \`preview_urls: false\`)`,
		)
	}
}

/**
 * The only `Worker` options an app may set. oblaka's `ResourceProcessor` spreads everything but
 * `dir`/`bindings`/`deleteDurableObjectsOnRemoval` verbatim into the generated wrangler config, so any
 * other key — `services`, `durable_objects`, `r2_buckets`, `build` — binds or runs something the typed
 * `bindings` walk never sees. Fail closed: a new wrangler key is refused until reviewed.
 */
const APP_WORKER_OPTIONS: ReadonlySet<string> = new Set([
	'assets',
	'bindings',
	'compatibility_date',
	'compatibility_flags',
	'deleteDurableObjectsOnRemoval',
	'dir',
	'main',
	'name',
	'observability',
	'preview_urls',
	'routes',
	'triggers',
	'vars',
	'workers_dev',
	// Every other key is deliberately absent: `build` runs a command, the rest bind a resource by raw name.
])

/** Everything wrangler reads out of `assets`. `directory` is the only one that names a path. */
const APP_ASSETS_OPTIONS: ReadonlySet<string> = new Set(['binding', 'directory', 'html_handling', 'not_found_handling', 'run_worker_first'])

/**
 * `assets.directory` is resolved against the generated `wrangler.jsonc`'s own directory and uploaded
 * PUBLICLY: wrangler walks it recursively and ignores only `.assetsignore`/`_redirects`/`_headers`, so
 * `.` on a root `workerDir` would publish the checkout's `.git/config` and the clone token in it.
 */
const isContainedAssetDirectory = (value: unknown): value is string => {
	if (typeof value !== 'string' || value.startsWith('/')) return false
	const segments = value.split('/')
	if (segments.includes('..') || segments.includes('.git')) return false
	return segments.some((segment) => segment !== '' && segment !== '.')
}

/** `assets` is the one raw key that names a path, so it is bounded rather than refused outright. */
const assertBoundedAssets = (worker: Worker): void => {
	const assets: unknown = worker.options.assets
	if (assets === undefined) return
	if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
		throw new Error(`cloudflare: Worker \`${worker.options.name}\` sets \`assets\` to something that is not an object`)
	}
	for (const key of Object.keys(assets)) {
		if (!APP_ASSETS_OPTIONS.has(key)) {
			throw new Error(`cloudflare: Worker \`${worker.options.name}\` sets \`assets.${key}\`, which an app may not configure`)
		}
	}
	const directory: unknown = Reflect.get(assets, 'directory')
	if (!isContainedAssetDirectory(directory)) {
		throw new Error(
			`cloudflare: Worker \`${worker.options.name}\` sets \`assets.directory\` to \`${
				typeof directory === 'string' ? directory : '(not a string)'
			}\`; it must be a relative path strictly inside the worker directory, with no \`..\` or \`.git\` segment`,
		)
	}
}

interface PlatformAdoption {
	readonly adopted: string
	readonly platform: string
}

/**
 * Every oblaka resource kind adopts the remote name `${env}-${name}`, and an env name may contain `-`
 * (`ENV_NAME` in `control.ts`), so an app in env `prod-propustka` naming `worker` lands on IAM's
 * `prod-propustka-worker`. Bound the ADOPTED name, which holds wherever the env/name boundary falls.
 */
const platformAdoption = (env: string, name: string): PlatformAdoption | null => {
	const adopted = `${env}-${name}`
	const platform = platformRemoteName(adopted)
	return platform === null ? null : { adopted, platform }
}

export interface AuthoredGraphLimits {
	/** The environment oblaka provisions into. Every remote name is `${env}-${name}`, so the bound is on that. */
	readonly env: string
	/** The one hostname this environment may route; a route on any other host belongs to another app. */
	readonly domain?: string
	/** The KV namespace oblaka keeps this deploy's state in; naming the platform's own would clobber it. */
	readonly stateNamespace: string
	/** Fabrika deploying its own components is the one caller allowed to name a platform resource. */
	readonly platformResources: 'refuse' | 'allow'
	/** The IAM application id `<app>@<env>` of the deployment, the only audience its proxy may mint for. */
	readonly iamAppId: string
	/** A contract application is served behind its endpoint table, never gates. */
	readonly contract: boolean
	/** Every Cloudflare deployment of the installation in Control's registry; their names are refused. Empty outside a run. */
	readonly installation: readonly AppEnvironment[]
}

/**
 * The proxy mints for the id its manifest names, so an authored manifest naming `notes@stage` or a
 * platform audience would carry another environment's grants, or cross-app ones, into this app. A contract
 * application behind gates would be served with no endpoint decision, so it would answer 503 to everything.
 */
const assertProxyAudience = (proxy: Worker, { iamAppId, contract }: AuthoredGraphLimits): void => {
	const raw = proxy.options.vars?.[FABRIKA_PROXY_MANIFEST_JSON]
	const manifest = typeof raw === 'string' ? parseProxyManifestJson(raw) : null
	if (manifest === null) {
		throw new Error(`cloudflare: proxy Worker \`${proxy.options.name}\` carries no readable proxy manifest`)
	}
	for (const app of manifest.apps) {
		if (app.id !== iamAppId) {
			throw new Error(`cloudflare: proxy Worker \`${proxy.options.name}\` mints for \`${app.id}\`; this deployment is \`${iamAppId}\``)
		}
		if (contract && !isContractProxyApp(app)) {
			throw new Error(
				`cloudflare: proxy Worker \`${proxy.options.name}\` protects a contract application with gates; pass its endpoint table (\`contractProxyTable(artifact)\`)`,
			)
		}
	}
}

/** The names this deployment owns: `iamAppId` is `<app>@<env>`, the deployment itself. */
export const applicationNames = (limits: Pick<AuthoredGraphLimits, 'env' | 'iamAppId' | 'installation'>): ApplicationNames => {
	const self = parseAppEnvironmentId(limits.iamAppId)
	if (self === null || self.env !== limits.env) {
		throw new Error(`cloudflare: \`${limits.iamAppId}\` is not the application id of environment \`${limits.env}\``)
	}
	return { self, installation: limits.installation }
}

/**
 * Refuse an authored graph before any Cloudflare call: the config comes from the checkout and the
 * deploy holds an account-wide token, so the names and routes it may claim are bounded here (ADR-0014).
 */
export const assertAuthoredGraph = (root: Worker, limits: AuthoredGraphLimits): void => {
	const deployable = applicationChain(root)
	const applications = applicationWorkers(root, deployable)
	const refuse = limits.platformResources === 'refuse'
	const names = applicationNames(limits)
	const assertAdoptable = (kind: string, name: string): void => {
		if (!refuse) return
		const adoption = platformAdoption(limits.env, name)
		if (adoption !== null) {
			throw new Error(
				`cloudflare: ${kind} \`${name}\` becomes \`${adoption.adopted}\` on Cloudflare, which would take over the Fabrika platform resource \`${adoption.platform}\``,
			)
		}
		assertOwnName(`${kind} \`${name}\` becomes`, `${limits.env}-${name}`, names)
	}
	const visit = (worker: Worker): void => {
		for (const key of refuse ? Object.keys(worker.options) : []) {
			if (!APP_WORKER_OPTIONS.has(key)) {
				throw new Error(
					`cloudflare: Worker \`${worker.options.name}\` sets \`${key}\`, which an app may not configure; declare resources in \`bindings\``,
				)
			}
		}
		if (refuse) {
			assertBoundedAssets(worker)
		}
		if (refuse && applications.has(worker)) {
			assertUnexposedApplication(worker)
		}
		for (const route of worker.options.routes ?? []) {
			const host = routeHostname(route)
			if (host === null || !isProxyHost(host) || host !== limits.domain?.toLowerCase()) {
				throw new Error(`cloudflare: Worker \`${worker.options.name}\` routes \`${host ?? '(unreadable)'}\`, which is not this environment's domain`)
			}
		}
		for (const value of Object.values(worker.options.bindings ?? {})) {
			const resource = namedResource(value)
			if (resource !== null) {
				assertAdoptable(resource.kind, resource.name)
			}
			const service = serviceReferenceTarget(value)
			if (service !== null && refuse && service !== IAM_SERVICE) {
				if (service === '(unreadable)') {
					throw new Error('cloudflare: service binding to `(unreadable)` cannot be checked against the Fabrika platform services')
				}
				assertAdoptable('service binding to', service)
			}
			if (value instanceof Worker) {
				if (!deployable.has(value)) {
					throw new Error(`cloudflare: config declares Worker \`${value.options.name}\`; only the application Worker and its proxy are deployable`)
				}
				visit(value)
			}
		}
		if (refuse) {
			assertApplicationServices(worker.options.name, emittedBindingConfig(worker, limits.env).services, names)
		}
	}
	assertAdoptable('Worker', root.options.name)
	// The state namespace is the ONE name oblaka uses verbatim (`KVStateStorage`), so no env prefix applies.
	if (refuse && PLATFORM_RESOURCE_NAMES.has(limits.stateNamespace)) {
		throw new Error(`cloudflare: state namespace \`${limits.stateNamespace}\` is a Fabrika platform resource and cannot be used by an app`)
	}
	visit(root)
	if (refuse && isProviderProxyWorker(root)) {
		assertProxyAudience(root, limits)
	}
}

export const buildPlan = (config: CloudflareAppConfig, worker: Worker): readonly CloudflareStep[] => {
	const steps: CloudflareStep[] = []

	if (config.pipeline?.build !== undefined) {
		steps.push({ id: 'build', kind: 'build', description: `Build the Worker (\`${config.pipeline.build}\`)` })
	}

	steps.push({ id: 'provision-resources', kind: 'provision-resources', description: 'Provision Cloudflare resources via oblaka' })

	for (const database of findMigratableDatabases(worker)) {
		steps.push({
			id: `migrate:${database.binding}`,
			kind: 'migrate',
			description: `Apply D1 migrations for \`${database.binding}\` (${database.name})`,
		})
	}

	steps.push({ id: 'deploy-worker', kind: 'deploy-worker', description: 'Deploy the Worker (`wrangler deploy`)' })

	if (config.schema !== undefined) {
		steps.push({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Report the authz schema for the control plane to reconcile into IAM' })
	}

	if (config.pipeline?.secrets !== undefined && config.pipeline.secrets.length > 0) {
		steps.push({
			id: 'sync-secrets',
			kind: 'sync-secrets',
			description: `Sync ${config.pipeline.secrets.length} secret(s) via \`wrangler secret put\``,
		})
	}

	return steps
}
