// The data a Cloudflare build hands its deploy (ADR-0086). The build runs the checkout's code with no credential and
// writes this manifest beside the bundle; the deploy reads it as data and never imports anything the build produced.
// Oblaka-free, so the runner's own entry can read the layout.

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** The manifest's file name at the root of the build's output. */
export const BUILD_MANIFEST_FILE = 'fabrika-build.json'
/** The application Worker's directory as the deploy rebuilds it: its generated config is written here by the deploy alone. */
export const BUILD_APP_DIR = 'app'
/** Under the application directory: wrangler's bundle of the Worker, uploaded as it is (`wrangler deploy --no-bundle`). */
export const BUILD_BUNDLE_DIR = 'bundle'
/** Under the application directory: the Worker's own `assets.directory`, copied. */
export const BUILD_ASSETS_DIR = 'assets'
/** Under the application directory: each D1 database's migrations, at `migrations/<binding>`. */
export const BUILD_MIGRATIONS_DIR = 'migrations'
/** Under the application directory: where the platform stages the contract's SPA files (`SPA_ASSETS_DIRECTORY`). */
export const BUILD_STAGED_DIR = 'fabrika'
/** The checkout's source maps, at their path below the worker directory, for the upload to Operations. */
export const BUILD_SOURCE_MAPS_DIR = 'sourcemaps'

/** Larger than any manifest a real graph produces; the schema bounds every list in it as well. */
export const MAX_BUILD_MANIFEST_BYTES = 4 * 1024 * 1024

/**
 * What each directory of the build's output may hold. The deploy runs `wrangler` in the application directory, so nothing
 * there may be a file wrangler or a runtime reads on its own (`.env`, `wrangler.jsonc`, `package.json`, `bunfig.toml`).
 */
const LAYOUT: Readonly<Record<string, ReadonlySet<string>>> = {
	'': new Set([BUILD_MANIFEST_FILE, BUILD_APP_DIR, BUILD_SOURCE_MAPS_DIR]),
	[BUILD_APP_DIR]: new Set([BUILD_BUNDLE_DIR, BUILD_ASSETS_DIR, BUILD_MIGRATIONS_DIR, BUILD_STAGED_DIR]),
	[`${BUILD_APP_DIR}/${BUILD_STAGED_DIR}`]: new Set(['assets']),
}

/** A binding name as a Worker reads it, and as it becomes one path segment under `migrations/`. */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The resource kinds the deploy rebuilds out of its own oblaka classes. A container builds an image, so it is not one. */
export const BUILD_RESOURCE_KINDS = [
	'd1_database',
	'kv_namespace',
	'r2_bucket',
	'queue',
	'durable_object',
	'workflow',
	'vectorize_index',
	'analytics_engine',
] as const

export type BuildResourceKind = typeof BUILD_RESOURCE_KINDS[number]

const jsonObject = z.record(z.string(), z.unknown())

/**
 * One binding of the application Worker. A resource is rebuilt from its kind and its options by the deploy's own class,
 * whatever class the checkout used; any other binding is the config entries its `configureBinding` wrote, which the
 * deploy merges and the bounds check like every other generated entry.
 */
const buildBindingSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('resource'), kind: z.enum(BUILD_RESOURCE_KINDS), options: jsonObject }).strict(),
	z.object({ type: z.literal('config'), config: jsonObject }).strict(),
])

export type BuildBinding = z.infer<typeof buildBindingSchema>

/** Options the deploy writes itself, so the manifest never carries them. */
const RESERVED_OPTIONS: ReadonlySet<string> = new Set(['dir', 'name', 'main', 'bindings'])

const names = z.array(z.string().min(1).max(256)).max(256)

export const buildManifestSchema = z.object({
	version: z.literal(1),
	appId: z.string().min(1).max(63),
	env: z.string().regex(/^[a-z0-9-]+$/).max(63),
	/** The config's file name, for the messages that name it. */
	configFile: z.string().regex(/^[^/\\\0]{1,255}$/),
	/** The config's IAM schema as it declared it, or null; the deploy parses it with `configSchema`. */
	schema: z.unknown(),
	/** The contract the build read statically, only for a run Control approved no access for (a dry run). */
	contract: z.unknown().optional(),
	pipeline: z.object({ secrets: names, vars: names }).strict(),
	worker: z.object({
		name: z.string().min(1).max(63),
		/** The bundle's entry, relative to the application directory. */
		main: z.string().regex(/^bundle\/[A-Za-z0-9._-]{1,200}\.m?js$/),
		options: jsonObject.refine((options) => Object.keys(options).every((key) => !RESERVED_OPTIONS.has(key)), 'reserved option'),
		bindings: z.record(z.string().regex(BINDING_NAME), buildBindingSchema).refine(
			(bindings) => Object.keys(bindings).length <= 256,
			'too many bindings',
		),
		/** The Durable Object migration history of the Worker's committed `wrangler.jsonc`, when it has one. */
		migrations: z.array(jsonObject).max(1000).optional(),
	}).strict(),
	/** The build left out a source map over Operations' limits. */
	sourceMapsIncomplete: z.boolean().optional(),
}).strict()

export type BuildManifest = z.infer<typeof buildManifestSchema>

/** Every message the deploy gives about the build's output names nothing from it. */
const refused = (detail: string): Error => new Error(`cloudflare: the build's output ${detail}`)

/** JSON.parse that refuses a `__proto__` key anywhere, so no later spread or assignment of the data can change a prototype. */
const parseJsonData = (text: string): unknown =>
	JSON.parse(text, (key, value: unknown) => {
		if (key === '__proto__') throw refused('carries a `__proto__` key')
		return value
	})

/**
 * Read and validate the manifest of a build's output, which the runner has already copied file by file into a tree of
 * its own (`copyBuildOutput`). The file is only ever parsed as JSON.
 */
export const readBuildManifest = async (dir: string): Promise<BuildManifest> => {
	const path = join(dir, BUILD_MANIFEST_FILE)
	const stats = await lstat(path).catch(() => null)
	if (stats === null || !stats.isFile()) throw refused(`has no \`${BUILD_MANIFEST_FILE}\``)
	if (stats.size > MAX_BUILD_MANIFEST_BYTES) throw refused(`\`${BUILD_MANIFEST_FILE}\` exceeds ${MAX_BUILD_MANIFEST_BYTES} bytes`)
	let decoded: unknown
	try {
		decoded = parseJsonData(await readFile(path, 'utf8'))
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("cloudflare: the build's output")) throw error
		throw refused(`\`${BUILD_MANIFEST_FILE}\` is not JSON`)
	}
	const manifest = buildManifestSchema.safeParse(decoded)
	if (!manifest.success) throw refused(`\`${BUILD_MANIFEST_FILE}\` is malformed (${manifest.error.issues[0]?.path.join('.') ?? 'root'})`)
	return manifest.data
}

/**
 * Check that the output holds only what the layout admits at each level, so the application directory the deploy runs
 * `wrangler` in holds nothing but the bundle, the assets and the migrations. Run on the copied tree, before the manifest
 * is used.
 */
export const assertBuildLayout = async (dir: string): Promise<void> => {
	for (const [level, admitted] of Object.entries(LAYOUT)) {
		const path = level === '' ? dir : join(dir, level)
		const stats = await lstat(path).catch(() => null)
		if (stats === null) continue
		if (!stats.isDirectory()) throw refused(`holds \`${level}\`, which is not a directory`)
		for (const name of await readdir(path)) {
			if (!admitted.has(name)) throw refused(`holds \`${level === '' ? name : `${level}/${name}`}\`, which the build may not produce`)
		}
	}
}

/** Whether a binding name may name a directory under `migrations/`. */
export const isBuildBindingName = (name: string): boolean => BINDING_NAME.test(name)
