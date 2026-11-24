// The build half of an isolated Cloudflare deploy (ADR-0086). It runs inside the runner's build sandbox: its own user,
// an empty environment, no credential and no network after the install. It runs everything of the checkout that a
// deploy runs (the config, `pipeline.build`, the checks, the bundler) and leaves only data for the deploy: wrangler's
// bundle, the assets, the migrations, the source maps, and a manifest describing the application Worker.

import { PLATFORM_TYPESCRIPT_VERSION } from '@fabrika/app/build'
import type { ContractArtifact } from '@fabrika/auth-core'
import { MAX_SOURCE_MAP_BYTES, MAX_SOURCE_MAP_TOTAL_BYTES, MAX_SOURCE_MAPS } from '@fabrika/check/source-maps'
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { Worker } from 'oblaka-iac'
import {
	BUILD_APP_DIR,
	BUILD_ASSETS_DIR,
	BUILD_BUNDLE_DIR,
	BUILD_MANIFEST_FILE,
	BUILD_MIGRATIONS_DIR,
	BUILD_RESOURCE_KINDS,
	BUILD_SOURCE_MAPS_DIR,
	type BuildBinding,
	type BuildManifest,
	type BuildResourceKind,
	isBuildBindingName,
} from './build-manifest'
import { runnerWorkerGraph } from './checkout'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { configSchema } from './config-schema'
import { pinsGeneratedEntry, runsInObject } from './contract-support'
import { type CheckTarget, entryBuildEnvironment, PLATFORM_CREDENTIAL_NAMES, runChecks, workerDir } from './provider'
import type { BuildValues, RunnerApprovedAccess } from './runner-protocol'
import { assetMounts, stageSpaAssets } from './spa-assets'

/** The same ceiling the deploy's assets walk has. */
const MAX_ASSET_ENTRIES = 50_000

/** The config the application CLI reads when it is named nothing else. */
const DEFAULT_CONFIG = 'fabrika.config.ts'

export interface CloudflareBuildOptions {
	readonly env: string
	/** The config, relative to `cwd`. */
	readonly configPath: string
	/** Where the runner installed the checkout's dependencies and runs the build: the worker directory. */
	readonly cwd: string
	/** The build's output directory, empty, outside the checkout. */
	readonly outDir: string
	readonly domain?: string
	/** The access Control approved; absent only for a dry run. Not a secret: the contract and the releases. */
	readonly approved?: RunnerApprovedAccess
	readonly values: BuildValues
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly log: (line: string) => void
	readonly collaborators?: Pick<CloudflareCollaborators, 'loadConfig' | 'readContract' | 'runCommand'>
}

const refuse = (detail: string): Error => new Error(`cloudflare build: ${detail}`)

/** A value the manifest can carry: JSON that reads back as itself, so no function, class or `undefined` hides in it. */
const plainData = (value: unknown, what: string): unknown => {
	let text: string | undefined
	try {
		text = JSON.stringify(value)
	} catch {
		text = undefined
	}
	const decoded: unknown = text === undefined ? undefined : JSON.parse(text)
	if (text === undefined || !Bun.deepEquals(decoded, value)) throw refuse(`${what} is not plain data, so the deploy could not rebuild it`)
	return decoded
}

const plainObject = (value: unknown, what: string): Record<string, unknown> => {
	const data = plainData(value, what)
	if (typeof data !== 'object' || data === null || Array.isArray(data)) throw refuse(`${what} is not an object`)
	const object: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(data)) object[key] = entry
	return object
}

const isResourceKind = (kind: unknown): kind is BuildResourceKind => BUILD_RESOURCE_KINDS.some((known) => known === kind)

type Binding = Worker['options']['bindings'][string]

/**
 * One binding as data. A resource is its kind and options, which the deploy hands to its own class; any other binding is
 * what its `configureBinding` writes into an empty config, replayed by the deploy and checked by the bounds there.
 */
const serializeBinding = (worker: string, name: string, binding: Binding, env: string): BuildBinding => {
	if (!isBuildBindingName(name)) throw refuse(`Worker \`${worker}\` binds \`${name}\`, which is not a binding name`)
	if (binding instanceof Worker) {
		throw refuse(`Worker \`${worker}\` binds the Worker \`${binding.options.name}\`; a deploy builds only the application Worker and its proxy`)
	}
	if (binding === false || binding === null || binding === undefined) throw refuse(`Worker \`${worker}\` binding \`${name}\` is empty`)
	if ('getId' in binding && 'apply' in binding) {
		const kind = binding.getId().resource
		if (!isResourceKind(kind)) {
			throw refuse(`Worker \`${worker}\` binding \`${name}\` is a \`${kind}\`, which a Cloudflare deploy does not build`)
		}
		return { type: 'resource', kind, options: plainObject(Reflect.get(binding, 'options'), `the options of binding \`${name}\``) }
	}
	return { type: 'config', config: plainObject(binding.configureBinding({ config: {}, binding: name, env }), `binding \`${name}\``) }
}

/** Options the build replaces or the deploy writes itself. */
const OWN_OPTIONS: ReadonlySet<string> = new Set(['dir', 'name', 'main', 'bindings'])

const isContained = (root: string, path: string): boolean => {
	const between = relative(root, path)
	return between !== '' && !between.startsWith('..') && !isAbsolute(between)
}

/** Copy a tree with `lstat`, refusing a link or a special file: the copy is uploaded, and a link would upload its target. */
const copyTree = async (source: string, target: string, what: string, budget: { count: number }): Promise<void> => {
	await mkdir(target, { recursive: true })
	for (const name of (await readdir(source)).sort()) {
		budget.count += 1
		if (budget.count > MAX_ASSET_ENTRIES) throw refuse(`${what} holds more than ${MAX_ASSET_ENTRIES} entries`)
		const from = join(source, name)
		const stats = await lstat(from)
		if (stats.isSymbolicLink()) throw refuse(`${what} contains \`${name}\`, a symbolic link`)
		if (stats.isDirectory()) await copyTree(from, join(target, name), what, budget)
		else if (stats.isFile()) await copyFile(from, join(target, name))
		else throw refuse(`${what} contains \`${name}\`, which is neither a regular file nor a directory`)
	}
}

/** Every `*.sql` file at the top of a D1 database's migrations directory, which is what `wrangler d1 migrations` reads. */
const copyMigrations = async (source: string, target: string, binding: string): Promise<void> => {
	await mkdir(target, { recursive: true })
	const stats = await lstat(source).catch(() => null)
	if (stats === null) return
	if (!stats.isDirectory()) throw refuse(`the migrations of \`${binding}\` are not a directory`)
	for (const name of (await readdir(source)).sort()) {
		if (!name.endsWith('.sql')) continue
		const file = await lstat(join(source, name))
		if (!file.isFile()) throw refuse(`migration \`${name}\` of \`${binding}\` is not a regular file`)
		await copyFile(join(source, name), join(target, name))
	}
}

const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** The checkout's source maps under `dir`, within Operations' limits, at their path below `dir`. */
const copySourceMaps = async (dir: string, target: string): Promise<boolean> => {
	let incomplete = false
	let count = 0
	let total = 0
	const glob = new Bun.Glob('**/*.map')
	for await (const path of glob.scan({ cwd: dir, dot: false, onlyFiles: true, followSymlinks: false })) {
		if (path.split('/').some((part) => IGNORED_SEGMENTS.has(part))) continue
		const stats = await lstat(join(dir, path))
		if (!stats.isFile()) continue
		if (count >= MAX_SOURCE_MAPS || stats.size > MAX_SOURCE_MAP_BYTES || total + stats.size > MAX_SOURCE_MAP_TOTAL_BYTES) {
			incomplete = true
			continue
		}
		await mkdir(dirname(join(target, path)), { recursive: true })
		await copyFile(join(dir, path), join(target, path))
		count += 1
		total += stats.size
	}
	return incomplete
}

/** The Durable Object history of the Worker's committed `wrangler.jsonc`, which oblaka would read beside the config. */
const committedMigrations = async (dir: string): Promise<Record<string, unknown>[] | undefined> => {
	const text = await readFile(join(dir, 'wrangler.jsonc'), 'utf8').catch(() => null)
	if (text === null) return undefined
	let config: unknown
	try {
		config = Bun.JSONC.parse(text)
	} catch {
		throw refuse("the Worker's committed `wrangler.jsonc` is not JSON with comments")
	}
	const migrations: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'migrations') : undefined
	if (migrations === undefined) return undefined
	if (!Array.isArray(migrations)) throw refuse("the Worker's committed `wrangler.jsonc` has `migrations` that are not a list")
	return migrations.map((migration, index) => plainObject(migration, `migration ${index} of the committed \`wrangler.jsonc\``))
}

/** What `pipeline.build` gets over the sandbox's environment: the declared vars and the public managed values. */
const pipelineBuildEnvironment = (declaredVars: readonly string[], values: BuildValues): Record<string, string> => {
	const env = new Map<string, string>()
	for (const name of declaredVars) {
		const value = Object.hasOwn(values.vars, name) ? values.vars[name] : undefined
		if (value !== undefined) env.set(name, value)
	}
	for (const [name, value] of Object.entries(values.managed)) env.set(name, value)
	for (const name of PLATFORM_CREDENTIAL_NAMES) env.delete(name)
	return Object.fromEntries(env)
}

export interface CloudflareBuildResult {
	readonly manifest: BuildManifest
}

/**
 * Build an application for an isolated deploy: run its config, `pipeline.build` and the checks, bundle its Worker with
 * wrangler (`deploy --dry-run --outdir`, which needs no account), and write the bundle, the assets, the migrations, the
 * source maps and the manifest into `outDir`. Holds no credential: everything it writes is data the deploy validates.
 */
export const buildCloudflareBundle = async (options: CloudflareBuildOptions): Promise<CloudflareBuildResult> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const { env, approved, dryRun, log, signal } = options
	const loaded = await cf.loadConfig(options.cwd, options.configPath)
	const config = loaded.config
	// Read once, before `resources()` runs the checkout's code again; the deploy parses it again from the manifest.
	const schema = configSchema(config)
	const contract: ContractArtifact | null = approved?.contract ?? await cf.readContract(loaded.cwd)
	if (contract === null) throw refuse('the checkout has no `fabrika.contract.ts`; Fabrika deploys an application only with a contract')
	const dir = workerDir(config, loaded.cwd)
	const release = approved?.framework
	const objectRuntime = approved === undefined || (release !== undefined && runsInObject(release))
	const regeneratesEntry = objectRuntime && release !== undefined && pinsGeneratedEntry(release)

	const build = config.pipeline?.build
	if (build !== undefined && dryRun) {
		log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
	} else if (build !== undefined) {
		log(`  build: \`${build}\``)
		const result = await cf.runCommand({
			command: 'sh',
			args: ['-c', build],
			cwd: dir,
			env: pipelineBuildEnvironment(config.pipeline?.vars ?? [], options.values),
			omitEnv: PLATFORM_CREDENTIAL_NAMES,
			signal,
		})
		if (result.exitCode !== 0) {
			throw refuse(`\`${build}\` failed (exit ${result.exitCode}): ${(result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2000)}`)
		}
	}

	if (approved !== undefined) {
		const target: CheckTarget = {
			cwd: loaded.cwd,
			config: basename(resolve(options.cwd, options.configPath)),
			root: resolve(options.cwd),
			regeneratesEntry,
			tables: Object.keys(approved.contract.tables).length > 0,
		}
		await runChecks(target, { approved, dryRun, log, signal }, cf)
	}

	const authored = runnerWorkerGraph(config.resources({ env, ...(options.domain === undefined ? {} : { domain: options.domain }) }))
	const name = authored.options.name
	const main = authored.options.main
	if (typeof main !== 'string' || main === '') throw refuse(`the application Worker \`${name}\` names no \`main\``)
	// oblaka resolves a Worker's `dir` against the executor's working directory.
	const authoredDir = resolve(authored.options.dir)
	const entry = resolve(authoredDir, main)
	const bundleMain = `${BUILD_BUNDLE_DIR}/${parse(entry).name}.js`
	const appOut = join(options.outDir, BUILD_APP_DIR)

	const bindings: Record<string, BuildBinding> = {}
	for (const [binding, value] of Object.entries(authored.options.bindings ?? {})) {
		const serialized = serializeBinding(name, binding, value, env)
		if (serialized.type === 'resource' && serialized.kind === 'd1_database' && typeof serialized.options['migrationsDir'] === 'string') {
			const source = resolve(authoredDir, serialized.options['migrationsDir'])
			const copy = `${BUILD_MIGRATIONS_DIR}/${binding}`
			if (!dryRun) await copyMigrations(source, join(appOut, copy), binding)
			serialized.options['migrationsDir'] = copy
		}
		bindings[binding] = serialized
	}

	const workerOptions: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(authored.options)) {
		if (OWN_OPTIONS.has(key) || value === undefined) continue
		workerOptions[key] = plainData(value, `option \`${key}\` of Worker \`${name}\``)
	}
	const assets: unknown = workerOptions['assets']
	if (assets !== undefined) {
		const directory: unknown = typeof assets === 'object' && assets !== null ? Reflect.get(assets, 'directory') : undefined
		const source = typeof directory === 'string' ? resolve(authoredDir, directory) : ''
		if (typeof directory !== 'string' || !isContained(authoredDir, source) || directory.split('/').includes('.git')) {
			throw refuse(`Worker \`${name}\` sets \`assets.directory\` outside its directory`)
		}
		if (!dryRun) await copyTree(source, join(appOut, BUILD_ASSETS_DIR), `assets directory \`${directory}\``, { count: 0 })
		workerOptions['assets'] = { ...assets, directory: BUILD_ASSETS_DIR }
	}

	let sourceMapsIncomplete = false
	if (dryRun) {
		log(`  [dry-run] would bundle \`${relative(options.cwd, entry)}\` into ${bundleMain}`)
	} else {
		const mounts = objectRuntime ? assetMounts(contract) : []
		if (mounts.length > 0 && assets === undefined) {
			const staged = await stageSpaAssets(mounts, loaded.cwd, appOut)
			log(`  staged ${staged} SPA files`)
		}
		await bundleWorker(cf, options, authored, entry, join(appOut, BUILD_BUNDLE_DIR))
		const bundled = await lstat(join(appOut, bundleMain)).catch(() => null)
		if (bundled === null || !bundled.isFile()) throw refuse(`wrangler wrote no \`${bundleMain}\``)
		sourceMapsIncomplete = await copySourceMaps(dir, join(options.outDir, BUILD_SOURCE_MAPS_DIR))
	}

	const migrations = await committedMigrations(authoredDir)
	const manifest: BuildManifest = {
		version: 1,
		appId: config.id,
		env,
		configFile: basename(options.configPath) || DEFAULT_CONFIG,
		schema,
		...(approved === undefined ? { contract } : {}),
		pipeline: { secrets: [...(config.pipeline?.secrets ?? [])], vars: [...(config.pipeline?.vars ?? [])] },
		worker: { name, main: bundleMain, options: workerOptions, bindings, ...(migrations === undefined ? {} : { migrations }) },
		...(sourceMapsIncomplete ? { sourceMapsIncomplete } : {}),
	}
	await mkdir(options.outDir, { recursive: true })
	await writeFile(join(options.outDir, BUILD_MANIFEST_FILE), JSON.stringify(manifest), { flag: 'wx' })
	log(`  built \`${name}\` into ${bundleMain}`)
	return { manifest }
}

/** The config file wrangler bundles with, beside the Worker so it resolves what the Worker's own config would. */
const BUNDLE_CONFIG = '.fabrika-bundle.wrangler.json'

/**
 * Bundle the Worker as `wrangler deploy` would, without deploying: `--dry-run --outdir` needs no account and no network.
 * The config names only what bundling reads (the entry, the compatibility date and flags); everything else is the
 * deploy's, from the manifest.
 */
const bundleWorker = async (
	cf: Pick<CloudflareCollaborators, 'runCommand'>,
	options: CloudflareBuildOptions,
	worker: Worker,
	entry: string,
	outDir: string,
): Promise<void> => {
	const configPath = join(resolve(worker.options.dir), BUNDLE_CONFIG)
	const config = {
		name: worker.options.name,
		main: entry,
		...(worker.options.compatibility_date === undefined ? {} : { compatibility_date: worker.options.compatibility_date }),
		compatibility_flags: worker.options.compatibility_flags,
	}
	await rm(configPath, { force: true })
	await writeFile(configPath, JSON.stringify(config), { flag: 'wx' })
	try {
		const result = await cf.runCommand({
			command: 'wrangler',
			args: ['deploy', '--dry-run', '--config', configPath, '--outdir', outDir],
			cwd: dirname(configPath),
			...entryBuildEnvironment({ WRANGLER_SEND_METRICS: 'false' }),
			signal: options.signal,
		})
		if (result.exitCode !== 0) {
			throw refuse(
				`wrangler could not bundle the Worker (exit ${result.exitCode}): ${(result.stderr.trim() || result.stdout.trim() || '(no output)').slice(-2000)}`,
			)
		}
	} finally {
		await rm(configPath, { force: true })
	}
	// wrangler's note about the directory; not a module.
	await rm(join(outDir, 'README.md'), { force: true })
}

/**
 * Fetch the tools the checks run at the platform's pinned releases (`contractChecks`: TypeScript and `@fabrika/check` at
 * the release Control read the application with) into the `bun x` cache of this user, while the sandbox may still reach
 * the registry; the build that follows runs without network and finds them there. Runs in `cwd`, never the checkout, and
 * runs no code of it. A failure is logged and left to the check, which then names what it could not run.
 */
export const fetchCheckTools = async (options: {
	readonly approved: RunnerApprovedAccess | undefined
	readonly cwd: string
	readonly signal: AbortSignal
	readonly log: (line: string) => void
	readonly collaborators?: Pick<CloudflareCollaborators, 'runCommand'>
}): Promise<void> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const checker = options.approved?.checker
	if (checker === undefined) return
	const tools = [
		{ label: `typescript@${PLATFORM_TYPESCRIPT_VERSION}`, args: ['x', '--bun', '-p', `typescript@${PLATFORM_TYPESCRIPT_VERSION}`, 'tsc', '--version'] },
		{ label: `@fabrika/check@${checker}`, args: ['x', '--bun', '-p', `@fabrika/check@${checker}`, 'fabrika-check', '--help'] },
	]
	for (const tool of tools) {
		const result = await cf.runCommand({ command: 'bun', args: tool.args, cwd: options.cwd, ...entryBuildEnvironment(), signal: options.signal })
		options.log(
			result.exitCode === 0 ? `  fetched ${tool.label}` : `  could not fetch ${tool.label} (exit ${result.exitCode}); the check that runs it will fail`,
		)
	}
}

/** Read the build values file the runner wrote for the sandbox. A Map, so a name such as `__proto__` stays a name. */
export const parseBuildValues = (text: string): BuildValues => {
	let decoded: unknown
	try {
		decoded = JSON.parse(text)
	} catch {
		throw refuse('the build values file is not JSON')
	}
	const group = (key: 'vars' | 'managed'): Record<string, string> => {
		const value: unknown = typeof decoded === 'object' && decoded !== null ? Reflect.get(decoded, key) : undefined
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse(`the build values file has no \`${key}\` object`)
		const entries = new Map<string, string>()
		for (const [name, entry] of Object.entries(value)) {
			if (typeof entry !== 'string') throw refuse(`the build values file has a value under \`${key}\` that is not text`)
			entries.set(name, entry)
		}
		return Object.fromEntries(entries)
	}
	return { vars: group('vars'), managed: group('managed') }
}
