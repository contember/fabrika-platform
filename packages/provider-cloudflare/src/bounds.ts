import {
	CLOUDFLARE_APPLICATION_BINDING,
	CLOUDFLARE_APPLICATION_CLASS,
	CLOUDFLARE_DATABASE_BINDING,
	CLOUDFLARE_FILES_BINDING,
	GENERATED_ENTRY_FILE,
} from '@fabrika/app/build'
import { type AppEnvironment, appEnvironmentId, FRAMEWORK_VARIABLE_NAMES, isFrameworkVariableName, parseAppEnvironmentId } from '@fabrika/auth-core'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { dirname, resolve } from 'node:path'
import type { GeneratedConfig, Worker } from 'oblaka-iac'
import { CloudflareClient } from 'oblaka-iac/src/client'
import { ResourceProcessor } from 'oblaka-iac/src/commands/resource-processor'
import { type HyperdriveIdHolder, PENDING_HYPERDRIVE_ID } from './database'
import { PLATFORM_RESOURCE_NAMES } from './plan'
import { CLOUDFLARE_PROXY_WORKER_DIR, IAM_APPLICATION_ENTRYPOINT, IAM_SERVICE, PROXY_MANIFEST_DEFINE } from './proxy'

type WranglerConfig = GeneratedConfig['config']

/** What a deployment may claim on the account. The generated wrangler configs are checked against it. */
export interface DeploymentBounds {
	/** The environment oblaka provisions into. Every remote name is `${env}-${name}`. */
	readonly env: string
	/** The one hostname this environment may route; a route on any other host belongs to another app. */
	readonly domain?: string
	/** The directory a generated config's relative `path` is resolved against: the deploy's worker directory. */
	readonly cwd: string
	/** Fabrika deploying its own components is the one caller allowed to name a platform resource. */
	readonly platformResources: 'refuse' | 'allow'
	/** The IAM application id `<app>@<env>` of the deployment. */
	readonly iamAppId: string
	/** Every Cloudflare deployment of the installation in Control's registry; their names are refused. Empty outside a run. */
	readonly installation: readonly AppEnvironment[]
	/** The remote name of the proxy Worker the deployer built, or null when it built none. */
	readonly proxy: string | null
	/**
	 * The service binding the deployer wrote for each connector import (`FABRIKA_CONNECT_<IMPORT>`), by binding name, to
	 * the remote name of the owner's proxy Worker. These are the only bindings to another application's Worker.
	 */
	readonly connectors: Readonly<Record<string, string>>
	/**
	 * The value of every framework variable the platform wrote into each Worker; a generated config must carry exactly
	 * these. `proxy` is null when the deployer built no proxy.
	 */
	readonly frameworkVariables: {
		readonly application: Readonly<Record<string, string>>
		readonly proxy: Readonly<Record<string, string>> | null
	}
	/** The `define` literal of the manifest the deployer baked into its proxy Worker, or null when it built none. */
	readonly proxyManifest: string | null
	/** What the platform gives a contract application's Worker (ADR-0065), or null outside one. */
	readonly application: ApplicationRuntime | null
}

/** The Durable Object, files bucket and cron trigger of a contract application's Worker; the application authors none of them. */
export interface ApplicationRuntime {
	/** The remote name of the environment's files bucket. */
	readonly filesBucket: string
	/**
	 * The cron triggers the Worker carries when the contract has a job or a file kind, else an empty list: the hourly repair
	 * tick of a release that serves alarms, otherwise the minute tick.
	 */
	readonly crons: readonly string[]
	/**
	 * The absolute path of the entry the deploy regenerates, which the Worker's `main` must name (`pinsGeneratedEntry`), or
	 * null for a release whose Worker keeps its authored `main`.
	 */
	readonly entry: string | null
	/**
	 * The database the application runs on: its object's SQLite, or Postgres through the Hyperdrive config `name`, whose id
	 * `provision-database` puts into `hyperdrive` before oblaka writes the configs. The Worker binds exactly that id as
	 * `FABRIKA_DATABASE`, and runs with Smart Placement, near its database.
	 */
	readonly database: 'sqlite' | PostgresRuntime
}

/** The Hyperdrive config of an application on Postgres: its remote name, and the id this run handed out (null before). */
export interface PostgresRuntime {
	readonly kind: 'postgres'
	readonly name: string
	readonly hyperdrive: HyperdriveIdHolder
}

/** The placement of an application Worker on Postgres: Smart Placement runs it near its database. */
const SMART_PLACEMENT = { mode: 'smart' } as const

/**
 * The one migration of the application's object. Its tag is fixed: Cloudflare records the last tag a script applied, so
 * a tag that moved would migrate the class twice. The deployer binds the object first, so oblaka numbers it `v0001`.
 */
const APPLICATION_OBJECT_MIGRATION = { tag: 'v0001', new_sqlite_classes: [CLOUDFLARE_APPLICATION_CLASS] } as const

/** The framework variables among a Worker's `vars`, as the deployer wrote them. */
export const frameworkValues = (vars: Readonly<Record<string, unknown>> | undefined): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const [name, value] of Object.entries(vars ?? {})) {
		if (isFrameworkVariableName(name) && typeof value === 'string') values[name] = value
	}
	return values
}

/** Where the proxy Worker the deployer builds has its generated config: the runner's own copy of this package. */
const PROXY_CONFIG_PATH = resolve(CLOUDFLARE_PROXY_WORKER_DIR, 'wrangler.jsonc')

/**
 * Every key a generated config may carry. Each one either names nothing, or names a resource the checks below read.
 * Fail closed: a key not listed here (`build`, `site`, `tail_consumers`, a new binding kind) is refused until reviewed.
 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
	'name',
	'main',
	'compatibility_date',
	'compatibility_flags',
	'observability',
	'routes',
	'workers_dev',
	'preview_urls',
	'triggers',
	'vars',
	'assets',
	'migrations',
	'services',
	'd1_databases',
	'kv_namespaces',
	'r2_buckets',
	'queues',
	'durable_objects',
	'containers',
	'workflows',
	// Written only by the platform, for an application on Postgres: exactly its own Hyperdrive config, and Smart Placement.
	'hyperdrive',
	'placement',
])

/** The platform proxy's config also carries the `define` that bakes its manifest into the bundle. */
const PROXY_CONFIG_KEYS: ReadonlySet<string> = new Set([...CONFIG_KEYS, 'define'])

/** Everything wrangler reads out of `assets`. `directory` is the only one that names a path. */
const ASSETS_KEYS: ReadonlySet<string> = new Set(['binding', 'directory', 'html_handling', 'not_found_handling', 'run_worker_first'])

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
	worker: 'Worker',
	d1_database: 'D1 database',
	kv_namespace: 'KV namespace',
	r2_bucket: 'R2 bucket',
	queue: 'queue',
	container: 'container',
	workflow: 'workflow',
	vectorize_index: 'Vectorize index',
	analytics_engine: 'Analytics Engine dataset',
}

/** One resource oblaka would apply: the name it was declared under, the remote name it adopts, and its generated id. */
export interface GeneratedResource {
	readonly kind: string
	readonly name: string
	readonly remote: string
	readonly id: string | null
}

export interface ConfigGeneration {
	readonly configs: readonly GeneratedConfig[]
	readonly resources: readonly GeneratedResource[]
}

const stateId = (state: unknown): string | null => {
	const id: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'id') : undefined
	return typeof id === 'string' ? id : null
}

/**
 * Generate the wrangler configs of a graph with oblaka's own processor, before any Cloudflare call: every resource is
 * applied in dry-run mode with a client that refuses to authenticate, and nothing is written to disk.
 */
export const generateWranglerConfigs = async (definition: Worker, env: string): Promise<ConfigGeneration> => {
	const client = new CloudflareClient({
		accountId: '',
		getToken: () => Promise.reject(new Error('cloudflare: the config generation run makes no Cloudflare call')),
	})
	const resources: GeneratedResource[] = []
	const processor = new ResourceProcessor({
		applyResource: async (resource) => {
			const state = await resource.apply({ dryRun: true, context: { env, client } })
			const { resource: kind, id: name } = resource.getId()
			resources.push({ kind, name, remote: `${env}-${name}`, id: stateId(state) })
			return state
		},
	}, async () => {})
	return { configs: await processor.process({ definition, env }), resources }
}

/** The deployment being deployed, and every Cloudflare deployment of the installation in Control's registry. */
interface ApplicationNames {
	readonly self: AppEnvironment
	readonly installation: readonly AppEnvironment[]
}

const applicationNames = ({ env, iamAppId, installation }: DeploymentBounds): ApplicationNames => {
	const self = parseAppEnvironmentId(iamAppId)
	if (self === null || self.env !== env) {
		throw new Error(`cloudflare: \`${iamAppId}\` is not the application id of environment \`${env}\``)
	}
	return { self, installation }
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

/**
 * An env name may contain `-`, so env `prod-propustka` + Worker `worker` lands on IAM's `prod-propustka-worker`: a
 * remote name that equals or ends with `-<platform name>` is a platform resource, wherever the env/name split falls.
 */
const platformRemoteName = (remote: string): string | null => {
	for (const platform of PLATFORM_RESOURCE_NAMES) {
		if (remote === platform || remote.endsWith(`-${platform}`)) return platform
	}
	return null
}

/** `subject` reads as the start of the refusal: "Worker `demo` binds service" or "D1 database `db` becomes". */
const assertOwnRemote = (subject: string, remote: unknown, names: ApplicationNames): void => {
	if (typeof remote !== 'string' || remote === '') {
		throw new Error(`cloudflare: ${subject} a name that cannot be read, so it cannot be checked`)
	}
	const platform = platformRemoteName(remote)
	if (platform !== null) {
		throw new Error(`cloudflare: ${subject} \`${remote}\`, which would take over the Fabrika platform resource \`${platform}\``)
	}
	const owner = foreignApplication(remote, names)
	if (owner !== null) {
		throw new Error(
			`cloudflare: ${subject} \`${remote}\`, a name of application \`${owner.app}\` (environment \`${owner.env}\`); an application binds only its own resources`,
		)
	}
}

const entries = (value: unknown, worker: string, key: string): readonly unknown[] => {
	if (value === undefined) return []
	if (!Array.isArray(value)) throw new Error(`cloudflare: Worker \`${worker}\` emits unreadable \`${key}\`, which cannot be checked`)
	return value
}

const field = (entry: unknown, name: string): unknown => typeof entry === 'object' && entry !== null ? Reflect.get(entry, name) : undefined

/**
 * The one platform service an application may bind is IAM, and only at `IAM_APPLICATION_ENTRYPOINT`: the default
 * export issues keys and approves devices. Another application's Worker is never bound.
 */
const assertServices = (worker: string, config: WranglerConfig, names: ApplicationNames, connectors: Readonly<Record<string, string>>): void => {
	const env = names.self.env
	const iam = env === 'local' ? IAM_SERVICE : `${env}-${IAM_SERVICE}`
	for (const entry of entries(config.services, worker, 'services')) {
		const service = field(entry, 'service')
		const entrypoint = field(entry, 'entrypoint')
		const binding = field(entry, 'binding')
		const owner = typeof binding === 'string' && Object.hasOwn(connectors, binding) ? connectors[binding] : undefined
		if (owner !== undefined && service === owner && entrypoint === undefined) {
			continue
		}
		if (service === iam) {
			if (entrypoint !== IAM_APPLICATION_ENTRYPOINT) {
				const bound = entrypoint === undefined ? 'its default entrypoint' : `entrypoint \`${String(entrypoint)}\``
				throw new Error(
					`cloudflare: Worker \`${worker}\` binds \`${service}\` to ${bound}; an application binds \`${IAM_APPLICATION_ENTRYPOINT}\` (use \`iamServiceReference()\`)`,
				)
			}
			assertIamIdentity(worker, binding, field(entry, 'props'), names)
			continue
		}
		assertOwnRemote(`Worker \`${worker}\` binds service`, service, names)
	}
}

/**
 * IAM reads a binding's `props.app` as the calling application (ADR-0067 §3), so an IAM binding names exactly this
 * deployment's IAM application id and carries nothing else. The deployer writes the `IAM` binding that way.
 */
const assertIamIdentity = (worker: string, binding: unknown, props: unknown, names: ApplicationNames): void => {
	const app = appEnvironmentId(names.self.app, names.self.env)
	const keys = typeof props === 'object' && props !== null ? Object.keys(props) : []
	if (keys.length !== 1 || field(props, 'app') !== app) {
		throw new Error(
			`cloudflare: Worker \`${worker}\` binds IAM as \`${
				String(binding)
			}\` without naming its own application \`${app}\`; only the deployer's \`IAM\` binding reaches IAM`,
		)
	}
}

/** Every remote name a config's bindings carry, beside the services. */
const assertResourceBindings = (worker: string, config: WranglerConfig, names: ApplicationNames): void => {
	const binds = (kind: string, remote: unknown): void => assertOwnRemote(`Worker \`${worker}\` binds ${kind}`, remote, names)
	for (const entry of entries(config.d1_databases, worker, 'd1_databases')) binds('D1 database', field(entry, 'database_name'))
	for (const entry of entries(config.r2_buckets, worker, 'r2_buckets')) binds('R2 bucket', field(entry, 'bucket_name'))
	for (const entry of entries(config.containers, worker, 'containers')) binds('container', field(entry, 'name'))
	for (const entry of entries(config.workflows, worker, 'workflows')) {
		binds('workflow', field(entry, 'name'))
		const script = field(entry, 'script_name')
		if (script !== undefined) binds('the workflow script', script)
	}
	const queues = config.queues
	for (const entry of entries(queues?.producers, worker, 'queues.producers')) binds('queue', field(entry, 'queue'))
	for (const entry of entries(queues?.consumers, worker, 'queues.consumers')) {
		binds('queue', field(entry, 'queue'))
		const deadLetter = field(entry, 'dead_letter_queue')
		if (deadLetter !== undefined) binds('dead-letter queue', deadLetter)
	}
	for (const entry of entries(config.durable_objects?.bindings, worker, 'durable_objects.bindings')) {
		const script = field(entry, 'script_name')
		if (script !== undefined) binds('the Durable Object script', script)
	}
}

/**
 * `assets.directory` is resolved against the generated `wrangler.jsonc`'s own directory and uploaded PUBLICLY: wrangler
 * walks it and ignores only `.assetsignore`/`_redirects`/`_headers`, so `.` would publish the checkout's `.git/config`.
 */
const isContainedAssetDirectory = (value: unknown): value is string => {
	if (typeof value !== 'string' || value.startsWith('/')) return false
	const segments = value.split('/')
	if (segments.includes('..') || segments.includes('.git')) return false
	return segments.some((segment) => segment !== '' && segment !== '.')
}

const assertBoundedAssets = (worker: string, assets: unknown): void => {
	if (assets === undefined) return
	if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
		throw new Error(`cloudflare: Worker \`${worker}\` sets \`assets\` to something that is not an object`)
	}
	for (const key of Object.keys(assets)) {
		if (!ASSETS_KEYS.has(key)) {
			throw new Error(`cloudflare: Worker \`${worker}\` sets \`assets.${key}\`, which an app may not configure`)
		}
	}
	const directory: unknown = Reflect.get(assets, 'directory')
	if (!isContainedAssetDirectory(directory)) {
		throw new Error(
			`cloudflare: Worker \`${worker}\` sets \`assets.directory\` to \`${
				typeof directory === 'string' ? directory : '(not a string)'
			}\`; it must be a relative path strictly inside the worker directory, with no \`..\` or \`.git\` segment`,
		)
	}
}

/**
 * An application Worker is reachable only through its proxy's service binding (ADR-0048), so nothing may route it, and
 * `workers.dev` and preview URLs must be off: Cloudflare enables both by default.
 */
const assertUnexposed = (worker: string, config: WranglerConfig): void => {
	const routes: unknown = config.routes
	if (routes !== undefined && !(Array.isArray(routes) && routes.length === 0)) {
		throw new Error(`cloudflare: application Worker \`${worker}\` declares \`routes\`; only its proxy Worker is routed (omit it or set \`[]\`)`)
	}
	if (config.workers_dev !== false) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` leaves \`workers_dev\` on; it would be public on workers.dev (set \`workers_dev: false\`)`,
		)
	}
	if (config.preview_urls !== false) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` leaves \`preview_urls\` on; every version would be public on workers.dev (set \`preview_urls: false\`)`,
		)
	}
}

const routeHostname = (route: unknown): string | null => {
	const pattern = typeof route === 'string' ? route : field(route, 'pattern')
	if (typeof pattern !== 'string') return null
	const host = pattern.split('/')[0]
	return host === undefined ? null : host.toLowerCase()
}

const assertRoutedHere = (worker: string, config: WranglerConfig, bounds: DeploymentBounds): void => {
	for (const route of entries(config.routes, worker, 'routes')) {
		const host = routeHostname(route)
		if (host === null || !isProxyHost(host) || host !== bounds.domain?.toLowerCase()) {
			throw new Error(`cloudflare: Worker \`${worker}\` routes \`${host ?? '(unreadable)'}\`, which is not this environment's domain`)
		}
	}
}

/**
 * A binding's `configureBinding` writes the generated config after the deployer injected its values, so the config is
 * where a framework variable is checked: present exactly when the platform wrote it, and with the platform's value.
 */
const assertFrameworkVariables = (worker: string, vars: unknown, expected: Readonly<Record<string, string>>): void => {
	if (vars !== undefined && (typeof vars !== 'object' || vars === null || Array.isArray(vars))) {
		throw new Error(`cloudflare: Worker \`${worker}\` emits unreadable \`vars\`, which cannot be checked`)
	}
	const written = Object.keys(vars ?? {}).filter(isFrameworkVariableName)
	for (const name of new Set([...FRAMEWORK_VARIABLE_NAMES, ...Object.keys(expected), ...written])) {
		const actual: unknown = vars === undefined ? undefined : Reflect.get(vars, name)
		if (actual !== expected[name]) {
			throw new Error(`cloudflare: Worker \`${worker}\` sets \`${name}\` to a value Fabrika did not write; it is managed by Fabrika`)
		}
	}
}

/** The proxy's `define` is exactly the manifest the deployer baked: nothing else is substituted into its bundle. */
const assertBakedManifest = (worker: string, define: unknown, expected: string | null): void => {
	const names = typeof define === 'object' && define !== null && !Array.isArray(define) ? Object.keys(define) : null
	const exact = expected === null
		? define === undefined
		: names?.length === 1 && names[0] === PROXY_MANIFEST_DEFINE && field(define, PROXY_MANIFEST_DEFINE) === expected
	if (!exact) {
		throw new Error(`cloudflare: proxy Worker \`${worker}\` does not carry exactly the manifest Fabrika baked into it (\`define\`)`)
	}
}

const isApplicationMigration = (migration: unknown): boolean => {
	const keys = typeof migration === 'object' && migration !== null ? Object.keys(migration).sort() : []
	const classes = field(migration, 'new_sqlite_classes')
	return keys.join(',') === 'new_sqlite_classes,tag' && field(migration, 'tag') === APPLICATION_OBJECT_MIGRATION.tag
		&& Array.isArray(classes) && classes.length === 1 && classes[0] === CLOUDFLARE_APPLICATION_CLASS
}

const namesApplicationClass = (migration: unknown): boolean => JSON.stringify(migration).includes(JSON.stringify(CLOUDFLARE_APPLICATION_CLASS))

const isPlatformTriggers = (triggers: unknown, crons: readonly string[]): boolean => {
	const keys = typeof triggers === 'object' && triggers !== null ? Object.keys(triggers) : []
	const written = field(triggers, 'crons')
	return keys.length === 1 && Array.isArray(written) && written.length === crons.length && crons.every((cron, index) => written[index] === cron)
}

/**
 * The Hyperdrive binding and the placement are the platform's: on Postgres exactly `FABRIKA_DATABASE` to the config this run
 * handed out (`PENDING_HYPERDRIVE_ID` before `provision-database`), with no `localConnectionString`, and Smart Placement;
 * otherwise neither. An id this run did not hand out would bind another environment's database.
 */
const assertDatabase = (worker: string, config: WranglerConfig, database: 'sqlite' | PostgresRuntime): void => {
	const hyperdrive = entries(config.hyperdrive, worker, 'hyperdrive')
	if (database === 'sqlite') {
		if (config.hyperdrive !== undefined) {
			throw new Error(`cloudflare: Worker \`${worker}\` binds Hyperdrive; only the platform binds it, for an application on Postgres`)
		}
		if (config.placement !== undefined) {
			throw new Error(`cloudflare: Worker \`${worker}\` sets \`placement\`; only the platform sets it, for an application on Postgres`)
		}
		return
	}
	const entry = hyperdrive[0]
	const keys = typeof entry === 'object' && entry !== null ? Object.keys(entry).sort().join(',') : ''
	if (
		hyperdrive.length !== 1 || keys !== 'binding,id' || field(entry, 'binding') !== CLOUDFLARE_DATABASE_BINDING
		|| field(entry, 'id') !== (database.hyperdrive.id ?? PENDING_HYPERDRIVE_ID)
	) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` must bind \`${CLOUDFLARE_DATABASE_BINDING}\` once, to the Hyperdrive config \`${database.name}\` this deploy wrote; the platform writes that binding`,
		)
	}
	const placement: unknown = config.placement
	const placementKeys = typeof placement === 'object' && placement !== null ? Object.keys(placement) : []
	if (placementKeys.length !== 1 || field(placement, 'mode') !== SMART_PLACEMENT.mode) {
		throw new Error(`cloudflare: application Worker \`${worker}\` must run with \`placement: { mode: 'smart' }\`, which the platform writes`)
	}
}

/**
 * A contract application's Worker binds its own object (`FABRIKA_APPLICATION`, the class the generated entry exports)
 * under the one fixed migration, the environment's files bucket, and exactly the platform's cron triggers.
 */
const assertApplicationRuntime = (worker: string, config: WranglerConfig, runtime: ApplicationRuntime): void => {
	const objects = entries(config.durable_objects?.bindings, worker, 'durable_objects.bindings').filter((entry) =>
		field(entry, 'name') === CLOUDFLARE_APPLICATION_BINDING || field(entry, 'class_name') === CLOUDFLARE_APPLICATION_CLASS
	)
	const object = objects[0]
	if (
		objects.length !== 1 || field(object, 'name') !== CLOUDFLARE_APPLICATION_BINDING || field(object, 'class_name') !== CLOUDFLARE_APPLICATION_CLASS
		|| field(object, 'script_name') !== undefined
	) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` must bind \`${CLOUDFLARE_APPLICATION_BINDING}\` once, to its own \`${CLOUDFLARE_APPLICATION_CLASS}\`; the platform writes that binding`,
		)
	}
	const migrations = entries(config.migrations, worker, 'migrations')
	if (!isApplicationMigration(migrations[0]) || migrations.slice(1).some(namesApplicationClass)) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` must open its migrations with \`${APPLICATION_OBJECT_MIGRATION.tag}\` creating \`${CLOUDFLARE_APPLICATION_CLASS}\` and name the class nowhere else; a committed \`wrangler.jsonc\` with a history of its own cannot be deployed`,
		)
	}
	const files = entries(config.r2_buckets, worker, 'r2_buckets').filter((entry) => field(entry, 'binding') === CLOUDFLARE_FILES_BINDING)
	if (files.length !== 1 || field(files[0], 'bucket_name') !== runtime.filesBucket) {
		throw new Error(`cloudflare: application Worker \`${worker}\` must bind \`${CLOUDFLARE_FILES_BINDING}\` once, to \`${runtime.filesBucket}\``)
	}
	if (!isPlatformTriggers(config.triggers, runtime.crons)) {
		throw new Error(`cloudflare: application Worker \`${worker}\` sets \`triggers\` the platform did not write; its cron triggers are the platform's`)
	}
}

/**
 * A pinned release's Worker runs the entry the deploy regenerates, and nothing that entry does not export: a hand-written
 * `main` would skip the contract digest check, the hop secret and the framework's scheduling.
 */
const assertGeneratedEntry = (worker: string, generated: GeneratedConfig, cwd: string, entry: string): void => {
	const config = generated.config
	const main: unknown = config.main
	if (typeof main !== 'string' || resolve(dirname(resolve(cwd, generated.path)), main) !== entry) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` runs \`${
				typeof main === 'string' ? main : '(not a string)'
			}\`; on its framework release it runs \`${GENERATED_ENTRY_FILE}\` beside its config, which the deploy regenerates`,
		)
	}
	for (const key of ['workflows', 'containers'] as const) {
		if (entries(config[key], worker, key).length > 0) {
			throw new Error(`cloudflare: application Worker \`${worker}\` declares \`${key}\`, which the generated entry does not export`)
		}
	}
	const object = entries(config.durable_objects?.bindings, worker, 'durable_objects.bindings').find((binding) =>
		field(binding, 'name') !== CLOUDFLARE_APPLICATION_BINDING
	)
	if (object !== undefined) {
		throw new Error(
			`cloudflare: application Worker \`${worker}\` binds the Durable Object \`${
				String(field(object, 'name'))
			}\`; the generated entry exports only \`${CLOUDFLARE_APPLICATION_CLASS}\``,
		)
	}
}

const isPlatformProxy = (generated: GeneratedConfig, bounds: DeploymentBounds): boolean =>
	bounds.proxy !== null && generated.config.name === bounds.proxy && resolve(bounds.cwd, generated.path) === PROXY_CONFIG_PATH

/**
 * Check the wrangler configs oblaka generated — what `wrangler deploy` reads, whatever objects emitted them — before
 * provisioning and again before the deploy. Only the proxy Worker the deployer built is routed; every other config is
 * an application Worker, and there is exactly one of those.
 */
export const assertGeneratedConfigs = (configs: readonly GeneratedConfig[], bounds: DeploymentBounds): void => {
	if (bounds.platformResources === 'allow') {
		for (const generated of configs) assertRoutedHere(generated.config.name ?? generated.path, generated.config, bounds)
		return
	}
	const names = applicationNames(bounds)
	if (configs.length === 0) {
		throw new Error('cloudflare: oblaka generated no wrangler config, so there is nothing that can be checked')
	}
	const applications = configs.filter((generated) => !isPlatformProxy(generated, bounds))
	if (applications.length > 1) {
		const extra = applications.slice(1).map((generated) => `\`${generated.config.name ?? generated.path}\``).join(', ')
		throw new Error(`cloudflare: config declares Worker ${extra}; only the application Worker and its proxy are deployable`)
	}
	for (const generated of configs) {
		const config = generated.config
		const worker = config.name ?? generated.path
		const keys = isPlatformProxy(generated, bounds) ? PROXY_CONFIG_KEYS : CONFIG_KEYS
		for (const key of Object.keys(config)) {
			if (!keys.has(key)) {
				throw new Error(`cloudflare: Worker \`${worker}\` sets \`${key}\`, which an app may not configure; declare resources in \`bindings\``)
			}
		}
		assertOwnRemote('the Worker is named', config.name, names)
		assertServices(worker, config, names, isPlatformProxy(generated, bounds) ? {} : bounds.connectors)
		assertResourceBindings(worker, config, names)
		assertBoundedAssets(worker, config.assets)
		if (isPlatformProxy(generated, bounds)) {
			assertDatabase(worker, config, 'sqlite')
			assertRoutedHere(worker, config, bounds)
			assertFrameworkVariables(worker, config.vars, bounds.frameworkVariables.proxy ?? {})
			assertBakedManifest(worker, config.define, bounds.proxyManifest)
			continue
		}
		if (resolve(bounds.cwd, generated.path) === PROXY_CONFIG_PATH) {
			throw new Error(`cloudflare: Worker \`${worker}\` lives in the directory of the proxy Worker the platform builds`)
		}
		assertUnexposed(worker, config)
		assertFrameworkVariables(worker, config.vars, bounds.frameworkVariables.application)
		assertDatabase(worker, config, bounds.application?.database ?? 'sqlite')
		if (bounds.application === null) continue
		assertApplicationRuntime(worker, config, bounds.application)
		if (bounds.application.entry !== null) assertGeneratedEntry(worker, generated, bounds.cwd, bounds.application.entry)
	}
}

/** The ids a resource of this generation run was given; a literal id in a config would bind something else by id. */
const assertGeneratedIds = (generation: ConfigGeneration): void => {
	const ids = new Set(generation.resources.map((resource) => resource.id).filter((id) => id !== null))
	for (const generated of generation.configs) {
		const worker = generated.config.name ?? generated.path
		const bound = (kind: string, id: unknown): void => {
			if (typeof id !== 'string' || !ids.has(id)) {
				throw new Error(`cloudflare: Worker \`${worker}\` binds a ${kind} by an id no resource of this deployment declares`)
			}
		}
		for (const entry of entries(generated.config.d1_databases, worker, 'd1_databases')) bound('D1 database', field(entry, 'database_id'))
		for (const entry of entries(generated.config.kv_namespaces, worker, 'kv_namespaces')) bound('KV namespace', field(entry, 'id'))
	}
}

/**
 * The generation run's checks: every generated config, every resource oblaka would apply by the remote name it adopts
 * (a KV namespace's config carries only its id), and every id-bound binding against the ids the run handed out.
 */
export const assertGeneration = (generation: ConfigGeneration, bounds: DeploymentBounds): void => {
	if (bounds.platformResources === 'refuse') {
		const names = applicationNames(bounds)
		for (const resource of generation.resources) {
			// A Durable Object class lives inside its script and adopts no account-wide name.
			if (resource.kind === 'durable_object') continue
			assertOwnRemote(`${RESOURCE_LABELS[resource.kind] ?? resource.kind} \`${resource.name}\` becomes`, resource.remote, names)
		}
		// Not an oblaka resource: the deployer names it, and it falls under the same rules as one.
		const database = bounds.application?.database
		if (database !== undefined && database !== 'sqlite') assertOwnRemote('the Hyperdrive config is named', database.name, names)
	}
	assertGeneratedConfigs(generation.configs, bounds)
	if (bounds.platformResources === 'refuse') assertGeneratedIds(generation)
}

/** The KV namespace oblaka keeps deploy state in is the ONE name it uses verbatim (`KVStateStorage`): no env prefix. */
export const assertStateNamespace = (stateNamespace: string, platformResources: 'refuse' | 'allow'): void => {
	if (platformResources === 'refuse' && PLATFORM_RESOURCE_NAMES.has(stateNamespace)) {
		throw new Error(`cloudflare: state namespace \`${stateNamespace}\` is a Fabrika platform resource and cannot be used by an app`)
	}
}

/** The `assets.directory` of a generated config, relative to the config's own directory, once it has been bounded. */
export const assetDirectory = (generated: GeneratedConfig): string | null => {
	const directory = field(generated.config.assets, 'directory')
	return typeof directory === 'string' && directory !== '' ? directory : null
}
