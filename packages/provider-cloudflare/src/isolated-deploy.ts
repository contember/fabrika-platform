// The deploy half of an isolated Cloudflare deploy (ADR-0086): the application's config, rebuilt from the build's
// manifest out of this package's own oblaka classes. Nothing here imports, evaluates or bundles a file the build wrote;
// the bundle is uploaded as it is and the generated configs are checked by the same bounds as every other deploy.

import { contractArtifactSchema } from '@fabrika/app/contract'
import type { ContractArtifact } from '@fabrika/auth-core'
import { APP_PROVIDER } from '@fabrika/provider-contract'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
	AnalyticsEngine,
	D1Database,
	DurableObject,
	type GeneratedConfig,
	KVNamespace,
	Queue,
	R2Bucket,
	VectorizeIndex,
	Worker,
	Workflow,
} from 'oblaka-iac'
import { z } from 'zod'
import type { CloudflareAppConfig } from './authoring'
import {
	assertBuildLayout,
	BUILD_APP_DIR,
	BUILD_ASSETS_DIR,
	BUILD_MIGRATIONS_DIR,
	type BuildBinding,
	type BuildManifest,
	type BuildResourceKind,
	readBuildManifest,
} from './build-manifest'
import { configSchema } from './config-schema'

type Binding = Worker['options']['bindings'][string]
type Config = GeneratedConfig['config']

const resourceName = z.string().min(1).max(255)

/** What each rebuilt resource takes: exactly its class's options, so a value the class does not read is refused. */
const resourceOptions = {
	d1_database: z.object({ name: resourceName, migrationsDir: z.string().optional(), locationHint: z.string().optional() }).strict(),
	kv_namespace: z.object({ name: resourceName }).strict(),
	r2_bucket: z.object({ name: resourceName, locationHint: z.enum(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']).optional() }).strict(),
	queue: z.object({
		name: resourceName,
		binding: z.enum(['producer', 'consumer', 'both']).optional(),
		producer: z.union([z.literal(false), z.object({ deliveryDelay: z.number().optional(), remote: z.boolean().optional() }).strict()]).optional(),
		consumer: z.object({
			type: z.literal('worker').optional(),
			maxBatchSize: z.number().optional(),
			maxBatchTimeout: z.number().optional(),
			maxRetries: z.number().optional(),
			deadLetterQueue: z.string().optional(),
			maxConcurrency: z.number().nullable().optional(),
			visibilityTimeoutMs: z.number().optional(),
			retryDelay: z.number().optional(),
		}).strict().optional(),
	}).strict(),
	durable_object: z.object({ name: resourceName, className: z.string().min(1).max(255), renamedFrom: z.string().optional() }).strict(),
	workflow: z.object({ name: resourceName, className: z.string().min(1).max(255) }).strict(),
	vectorize_index: z.object({
		name: resourceName,
		config: z.object({ dimensions: z.number().int().positive(), metric: z.enum(['cosine', 'euclidean', 'dot-product']) }).strict(),
	}).strict(),
	analytics_engine: z.object({ name: resourceName }).strict(),
} satisfies Record<BuildResourceKind, z.ZodTypeAny>

const refused = (detail: string): Error => new Error(`cloudflare: the build's output ${detail}`)

const parsed = <T>(schema: z.ZodType<T>, value: unknown, binding: string): T => {
	const result = schema.safeParse(value)
	if (!result.success) throw refused(`describes binding \`${binding}\` with options its resource does not take`)
	return result.data
}

/** The migrations of a D1 database are the build's copy at `migrations/<binding>`, never a path the manifest chooses. */
const migrationsDirOf = (binding: string): string => `${BUILD_MIGRATIONS_DIR}/${binding}`

const rebuildResource = (binding: string, kind: BuildResourceKind, options: unknown): Binding => {
	switch (kind) {
		case 'd1_database': {
			const d1 = parsed(resourceOptions.d1_database, options, binding)
			if (d1.migrationsDir !== undefined && d1.migrationsDir !== migrationsDirOf(binding)) {
				throw refused(`names migrations for binding \`${binding}\` outside \`${migrationsDirOf(binding)}\``)
			}
			return new D1Database(d1)
		}
		case 'kv_namespace':
			return new KVNamespace(parsed(resourceOptions.kv_namespace, options, binding))
		case 'r2_bucket':
			return new R2Bucket(parsed(resourceOptions.r2_bucket, options, binding))
		case 'queue':
			return new Queue(parsed(resourceOptions.queue, options, binding))
		case 'durable_object':
			return new DurableObject(parsed(resourceOptions.durable_object, options, binding))
		case 'workflow':
			return new Workflow(parsed(resourceOptions.workflow, options, binding))
		case 'vectorize_index':
			return new VectorizeIndex(parsed(resourceOptions.vectorize_index, options, binding))
		case 'analytics_engine':
			return new AnalyticsEngine(parsed(resourceOptions.analytics_engine, options, binding))
	}
}

/** Append a recorded list to the config's own, as each oblaka binding appends its entry; any other key is set. */
const mergeConfig = (config: Config, recorded: Readonly<Record<string, unknown>>): Config => {
	const merged: Config = { ...config }
	for (const [key, value] of Object.entries(recorded)) {
		const current: unknown = Reflect.get(merged, key)
		Reflect.set(merged, key, Array.isArray(current) && Array.isArray(value) ? [...current, ...value] : value)
	}
	return merged
}

/**
 * A binding that is not a resource, replayed from the config entries its `configureBinding` wrote in the build (a
 * service, IAM, AI). What it writes is data: the generated config is checked by the bounds like any other.
 */
export class RecordedBinding {
	constructor(private readonly recorded: Readonly<Record<string, unknown>>) {}

	configureBinding(args: { config: Config; binding: string; env: string }): Config {
		return mergeConfig(args.config, this.recorded)
	}
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What a recorded binding may write: its own entry in \`services\` (a service, IAM) or its own \`ai\` binding, and nothing
 * else. A recorded entry is merged after oblaka wrote the Worker, so any other key would replace what the deploy built:
 * \`main\` outside the copy makes wrangler read the checkout as root and upload what its links point at (the token in
 * \`/proc/self/environ\`, the values file), another \`name\` makes the deploy bundle the Worker, and a D1 entry names
 * migrations of its own.
 */
const recordedConfig = (name: string, config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
	const keys = Object.keys(config)
	const services: unknown = config['services']
	const ai: unknown = config['ai']
	const ownService = keys.length === 1 && Array.isArray(services) && services.length === 1 && isPlainObject(services[0])
		&& services[0]['binding'] === name
	const ownAi = keys.length === 1 && isPlainObject(ai) && ai['binding'] === name
	if (!ownService && !ownAi) throw refused(`describes binding \`${name}\` with config entries other than its own service or AI binding`)
	return config
}

const rebuildBinding = (name: string, binding: BuildBinding): Binding =>
	binding.type === 'resource'
		? rebuildResource(name, binding.kind, binding.options)
		: new RecordedBinding(recordedConfig(name, binding.config))

const compatibilityFlags = z.array(z.string().max(128)).max(64)

/** The assets directory is the build's copy at `assets`, whatever the checkout named it. */
const rebuiltAssets = (assets: unknown): unknown => {
	if (assets === undefined) return undefined
	if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) return assets
	const directory: unknown = Reflect.get(assets, 'directory')
	if (directory !== BUILD_ASSETS_DIR) throw refused(`sets \`assets.directory\` to something other than \`${BUILD_ASSETS_DIR}\``)
	return assets
}

/**
 * The application Worker of the manifest, in `appDir`, out of this package's classes: its `main` is the bundle, every
 * resource is this package's class, and every other binding replays its recorded entries.
 */
export const rebuildApplicationWorker = (manifest: BuildManifest, appDir: string): Worker => {
	const { worker } = manifest
	const flags = compatibilityFlags.safeParse(worker.options['compatibility_flags'] ?? [])
	if (!flags.success) throw refused('sets `compatibility_flags` to something that is not a list of flags')
	const bindings: Record<string, Binding> = {}
	for (const [name, binding] of Object.entries(worker.bindings)) bindings[name] = rebuildBinding(name, binding)
	const rebuilt = new Worker({ dir: appDir, name: worker.name, main: worker.main, compatibility_flags: flags.data, bindings })
	for (const [key, value] of Object.entries(worker.options)) {
		if (key === 'compatibility_flags') continue
		Reflect.set(rebuilt.options, key, key === 'assets' ? rebuiltAssets(value) : value)
	}
	return rebuilt
}

/** The contract the build read statically, parsed as Control parses one. */
const contractOf = (manifest: BuildManifest): ContractArtifact | null => {
	if (manifest.contract === undefined) return null
	const contract = contractArtifactSchema.safeParse(manifest.contract)
	if (!contract.success) throw refused('carries a contract that is not a contract artifact')
	return contract.data
}

/** The application's config, as the deployer reads one, rebuilt from the manifest: no module of the build is imported. */
export interface PrebuiltApplication {
	readonly config: CloudflareAppConfig
	/** The application directory of the copied output: the Worker's `dir`, where the deploy writes its generated config. */
	readonly appDir: string
	/** The bundle's entry, absolute: the only `main` the application Worker may run. */
	readonly main: string
	/** The contract the build read statically; only a run without the access Control approved (a dry run) uses it. */
	readonly contract: ContractArtifact | null
	readonly manifest: BuildManifest
}

/**
 * Open the runner's copy of a build's output for the deploy: the layout, then the manifest, checked against the run's
 * environment. The Worker's committed Durable Object history becomes the one file the deploy writes into the application
 * directory before oblaka reads it.
 */
export const openPrebuiltApplication = async (dir: string, env: string): Promise<PrebuiltApplication> => {
	await assertBuildLayout(dir)
	const manifest = await readBuildManifest(dir)
	if (manifest.env !== env) throw refused(`was built for environment \`${manifest.env}\`, not \`${env}\``)
	const appDir = resolve(dir, BUILD_APP_DIR)
	await mkdir(appDir, { recursive: true })
	if (manifest.worker.migrations !== undefined) {
		await writeFile(join(appDir, 'wrangler.jsonc'), `${JSON.stringify({ migrations: manifest.worker.migrations }, null, '\t')}\n`, { flag: 'wx' })
	}
	// Parsed as a config's schema is: `appSchemaSchema`, deep-frozen.
	const schema = manifest.schema === null || manifest.schema === undefined ? null : configSchema({ schema: manifest.schema })
	const config: CloudflareAppConfig = {
		id: manifest.appId,
		pipeline: { secrets: [...manifest.pipeline.secrets], vars: [...manifest.pipeline.vars] },
		...(schema === null ? {} : { schema }),
		// A fresh graph on each call, as a config's `resources` returns one.
		resources: () => rebuildApplicationWorker(manifest, appDir),
		[APP_PROVIDER]: 'cloudflare',
	}
	return { config, appDir, main: resolve(appDir, manifest.worker.main), contract: contractOf(manifest), manifest }
}
