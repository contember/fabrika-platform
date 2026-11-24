import { contractDigest, parseManagedEnvironment } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { D1Database, generateWranglerConfigs, KVNamespace, Worker } from '..'
import { BUILD_MANIFEST_FILE, type BuildManifest, readBuildManifest } from '../build-manifest'
import {
	type CloudflareCollaborators,
	type CommandResult,
	type CommandSpec,
	defaultCloudflareCollaborators,
	type ProvisionInput,
} from '../collaborators'
import { deployCloudflareBundle } from '../command'
import { buildCloudflareBundle, parseBuildValues } from '../isolated-build'
import { openPrebuiltApplication, rebuildApplicationWorker, RecordedBinding } from '../isolated-deploy'
import { createCloudflareDeployer } from '../provider'
import { APPROVED_ACCESS_FILE_ENV, buildValuesOf, DEPLOY_VALUES_FILE_ENV, type RunnerApprovedAccess } from '../runner-protocol'

// The two halves of an isolated deploy (ADR-0086): the build runs the checkout's config and bundles it; the deploy
// rebuilds the config from the manifest and never imports, evaluates or bundles anything the build produced.

const PROVIDER = resolve(import.meta.dir, '..', 'index.ts')

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The access Control approved, without a framework release: the stateless shape, so the checks are the tests and the checker. */
const approved: RunnerApprovedAccess = { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact), checker: '0.9.1' }

interface Fixture {
	readonly root: string
	readonly app: string
	readonly out: string
	/** Written by the checkout's config when it runs, and by the bundle if anything ever evaluated it. */
	readonly configRan: string
	readonly bundleRan: string
}

/** A checkout whose config has side effects, as an attacker's would: it writes a file and replaces `fetch`. */
const fixture = async (resources?: string): Promise<Fixture> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-isolated-'))
	roots.push(root)
	const app = join(root, 'app')
	const configRan = join(root, 'config-ran')
	const bundleRan = join(root, 'bundle-ran')
	await mkdir(join(app, 'migrations'), { recursive: true })
	await mkdir(join(app, 'fabrika'), { recursive: true })
	await mkdir(join(app, 'dist', 'app'), { recursive: true })
	await mkdir(join(app, 'dist', 'share'), { recursive: true })
	await writeFile(join(app, 'migrations', '0001_init.sql'), 'CREATE TABLE notes (id TEXT);\n')
	await writeFile(join(app, 'migrations', 'README.md'), 'not a migration\n')
	await writeFile(join(app, 'fabrika', 'entry.generated.ts'), 'export default {}\n')
	await writeFile(join(app, 'app.js.map'), JSON.stringify({ version: 3, file: 'app.js', sources: [], mappings: '' }))
	await writeFile(
		join(app, 'fabrika.config.ts'),
		`import { writeFileSync } from 'node:fs'
import { Container, D1Database, defineApp, iamServiceReference, KVNamespace, Worker } from ${JSON.stringify(PROVIDER)}
writeFileSync(${JSON.stringify(configRan)}, String(process.env.CLOUDFLARE_API_TOKEN ?? 'no token'))
globalThis.fetch = () => { throw new Error('the checkout replaced fetch') }
export default defineApp({
	id: 'demo',
	pipeline: { secrets: ['API_KEY'], vars: ['PUBLIC_URL'] },
	resources: ({ env }) => ${
			resources
				?? `new Worker({
		dir: import.meta.dir,
		name: 'demo',
		main: 'fabrika/entry.generated.ts',
		compatibility_date: '2025-10-01',
		compatibility_flags: ['nodejs_compat_v2'],
		workers_dev: false,
		preview_urls: false,
		routes: [],
		vars: { ENVIRONMENT: env },
		bindings: {
			DB: new D1Database({ name: 'demo-db', migrationsDir: 'migrations' }),
			CACHE: new KVNamespace({ name: 'demo-cache' }),
			IAM: iamServiceReference(),
		},
	})`
		},
})
`,
	)
	return { root, app, out: join(root, 'out'), configRan, bundleRan }
}

const linkCli = async (dir: string): Promise<void> => {
	await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true })
	await writeFile(join(dir, 'node_modules', '.bin', 'fabrika'), '')
}

interface BuildRecord {
	readonly commands: CommandSpec[]
}

/** The build's commands: every check passes, and wrangler's bundle is a module that would record being evaluated. */
const buildCommands = (rec: BuildRecord, fx: Fixture) => async (spec: CommandSpec): Promise<CommandResult> => {
	rec.commands.push(spec)
	// The check's frozen reinstall links the application's CLI again, as `bun install` would.
	if (spec.command === 'bun' && spec.args[0] === 'install') await linkCli(spec.cwd)
	if (spec.command === 'wrangler') {
		const outdir = spec.args[spec.args.indexOf('--outdir') + 1] ?? ''
		await mkdir(outdir, { recursive: true })
		await writeFile(
			join(outdir, 'entry.generated.js'),
			`import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(fx.bundleRan)}, 'evaluated')\nexport default {}\n`,
		)
		await writeFile(join(outdir, 'README.md'), 'wrangler output\n')
	}
	return { exitCode: 0, stdout: '', stderr: '' }
}

const runBuild = async (fx: Fixture, options: { readonly approved?: RunnerApprovedAccess; readonly dryRun?: boolean } = {}) => {
	const rec: BuildRecord = { commands: [] }
	const logs: string[] = []
	const originalFetch = globalThis.fetch
	try {
		await buildCloudflareBundle({
			env: 'stage',
			configPath: 'fabrika.config.ts',
			cwd: fx.app,
			outDir: fx.out,
			domain: 'stage.example.com',
			...(options.approved === undefined ? {} : { approved: options.approved }),
			values: buildValuesOf({
				vars: { PUBLIC_URL: 'https://stage.example.com', UNDECLARED: 'never-in-the-build' },
				managedEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam.example.com', FABRIKA_PROXY_SECRET: 'proxy-secret-value' },
			}),
			dryRun: options.dryRun ?? false,
			signal: new AbortController().signal,
			log: (line) => logs.push(line),
			collaborators: {
				// The real loader: the config is imported, here in the build and nowhere else.
				loadConfig: defaultCloudflareCollaborators.loadConfig,
				readContract: async () => notesArtifact,
				runCommand: buildCommands(rec, fx),
			},
		})
	} finally {
		globalThis.fetch = originalFetch
	}
	return { rec, logs, manifest: await readBuildManifest(fx.out) }
}

interface DeployRecord {
	readonly commands: CommandSpec[]
	readonly provisions: ProvisionInput[]
}

/** The deploy's collaborators: no config loader of its own, the commands recorded, oblaka's own processor for the configs. */
const deployCollaborators = (rec: DeployRecord, prebuilt: Awaited<ReturnType<typeof openPrebuiltApplication>>): CloudflareCollaborators => ({
	loadConfig: async () => ({ config: prebuilt.config, cwd: prebuilt.appDir }),
	readContract: async () => prebuilt.contract,
	runCommand: async (spec) => {
		rec.commands.push(spec)
		return { exitCode: 0, stdout: spec.args[0] === 'secret' && spec.args[1] === 'list' ? '[]' : '', stderr: '' }
	},
	provision: async (input) => {
		rec.provisions.push(input)
		if (input.definition === undefined) throw new Error('nothing to provision')
		const { configs } = await generateWranglerConfigs(input.definition, input.env)
		return { wranglerConfigs: [...configs], wranglerConfig: configs[0]?.config ?? {} }
	},
	writeOutcome: async () => {},
})

const runDeploy = async (fx: Fixture, access: RunnerApprovedAccess = approved) => {
	const prebuilt = await openPrebuiltApplication(fx.out, 'stage')
	const rec: DeployRecord = { commands: [], provisions: [] }
	const result = await createCloudflareDeployer({
		accountId: 'acc-1',
		apiToken: 'tok-deploy',
		collaborators: deployCollaborators(rec, prebuilt),
		prebuilt: { main: prebuilt.main },
	})({
		appId: prebuilt.config.id,
		env: 'stage',
		domain: 'stage.example.com',
		cwd: prebuilt.appDir,
		configPath: join(prebuilt.appDir, prebuilt.manifest.configFile),
		secrets: { API_KEY: 'api-key-value' },
		vars: { PUBLIC_URL: 'https://stage.example.com' },
		managedEnvironment: parseManagedEnvironment({ FABRIKA_IAM_ISSUER: 'https://iam.example.com' }),
		approved: access,
		dryRun: false,
		signal: new AbortController().signal,
		log: () => {},
	})
	return { rec, result, prebuilt }
}

describe('the isolated build', () => {
	test('runs the config, the build and the checks, and leaves only data: the bundle, the migrations, the maps and the manifest', async () => {
		const fx = await fixture()
		const { rec, manifest } = await runBuild(fx, { approved })
		// The config ran here, and found no credential: the build holds none.
		expect(await readFile(fx.configRan, 'utf8')).toBe('no token')
		expect(rec.commands.map((spec) => spec.command)).toEqual(['sh', 'sh', 'wrangler'])
		const bundle = rec.commands.find((spec) => spec.command === 'wrangler')
		expect(bundle?.args.slice(0, 2)).toEqual(['deploy', '--dry-run'])
		// Bundling inherits nothing of the process but what Bun and wrangler need.
		expect(Object.keys(bundle?.env ?? {}).sort()).toEqual(
			['HOME', 'PATH', 'TMPDIR', 'WRANGLER_SEND_METRICS'].filter((name) => name === 'WRANGLER_SEND_METRICS' || process.env[name] !== undefined),
		)
		expect(existsSync(join(fx.app, '.fabrika-bundle.wrangler.json'))).toBe(false)
		expect(manifest.worker.main).toBe('bundle/entry.generated.js')
		expect(manifest.worker.bindings).toEqual({
			DB: { type: 'resource', kind: 'd1_database', options: { name: 'demo-db', migrationsDir: 'migrations/DB' } },
			CACHE: { type: 'resource', kind: 'kv_namespace', options: { name: 'demo-cache' } },
			IAM: { type: 'config', config: { services: [{ binding: 'IAM', service: 'stage-propustka-worker', entrypoint: 'PropustkaApplication' }] } },
		})
		expect(manifest.worker.options['vars']).toEqual({ ENVIRONMENT: 'stage' })
		expect(manifest.pipeline).toEqual({ secrets: ['API_KEY'], vars: ['PUBLIC_URL'] })
		expect(manifest.contract).toBeUndefined()
		expect(await readFile(join(fx.out, 'app', 'migrations', 'DB', '0001_init.sql'), 'utf8')).toContain('CREATE TABLE')
		expect(existsSync(join(fx.out, 'app', 'migrations', 'DB', 'README.md'))).toBe(false)
		expect(existsSync(join(fx.out, 'app', 'bundle', 'README.md'))).toBe(false)
		expect(existsSync(join(fx.out, 'sourcemaps', 'app.js.map'))).toBe(true)
		// Nothing of the build evaluated the bundle it wrote.
		expect(existsSync(fx.bundleRan)).toBe(false)
	})

	test('pipeline.build gets the declared vars and the public managed values, never an undeclared var or a managed credential', async () => {
		const fx = await fixture()
		const configPath = join(fx.app, 'fabrika.config.ts')
		await writeFile(
			configPath,
			(await readFile(configPath, 'utf8')).replace(
				"pipeline: { secrets: ['API_KEY'], vars: ['PUBLIC_URL'] }",
				"pipeline: { build: 'make', secrets: ['API_KEY'], vars: ['PUBLIC_URL'] }",
			),
		)
		const { rec } = await runBuild(fx, { approved })
		const build = rec.commands.find((spec) => spec.command === 'sh' && spec.args[1] === 'make')
		expect(build?.env).toEqual({ PUBLIC_URL: 'https://stage.example.com', FABRIKA_IAM_ISSUER: 'https://iam.example.com' })
		expect(build?.omitEnv).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FABRIKA_IAM_PROVISIONING_KEY'])
	})

	test('a dry run without approved access records the contract it read and runs nothing of the build', async () => {
		const fx = await fixture()
		const { rec, manifest } = await runBuild(fx, { dryRun: true })
		expect(rec.commands).toEqual([])
		expect(manifest.contract).toEqual(notesArtifact)
		expect(existsSync(join(fx.out, 'app'))).toBe(false)
	})

	test('a binding the deploy could not rebuild is refused in the build', async () => {
		const cases: Array<[string, string]> = [
			[
				`new Worker({ dir: import.meta.dir, name: 'demo', main: 'fabrika/entry.generated.ts', compatibility_flags: [], bindings: { OTHER: new Worker({ dir: import.meta.dir, name: 'other', compatibility_flags: [], bindings: {} }) } })`,
				'binds the Worker `other`',
			],
			[
				`new Worker({ dir: import.meta.dir, name: 'demo', main: 'fabrika/entry.generated.ts', compatibility_flags: [], bindings: {}, tail: () => 1 })`,
				'option `tail` of Worker `demo` is not plain data',
			],
			[
				`new Worker({ dir: import.meta.dir, name: 'demo', main: 'fabrika/entry.generated.ts', compatibility_flags: [], bindings: {}, assets: { directory: '../..' } })`,
				'sets `assets.directory` outside its directory',
			],
			// A container builds an image from the checkout's Dockerfile, which no deploy runs.
			[
				`new Worker({ dir: import.meta.dir, name: 'demo', main: 'fabrika/entry.generated.ts', compatibility_flags: [], bindings: { JOB: new Container({ name: 'job', className: 'Job', image: './Dockerfile', maxInstances: 1, instanceType: 'dev' }) } })`,
				'binding `JOB` is a `container`, which a Cloudflare deploy does not build',
			],
		]
		for (const [resources, message] of cases) {
			const fx = await fixture(resources)
			await expect(runBuild(fx, { approved })).rejects.toThrow(message)
		}
	})
})

describe('the deploy of a build', () => {
	test('runs no checkout code: the config is rebuilt from the manifest, and the bundle is uploaded as it is', async () => {
		const fx = await fixture()
		await runBuild(fx, { approved })
		await rm(fx.configRan)
		const { rec, result, prebuilt } = await runDeploy(fx)
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual(['provision-resources', 'migrate:APP.DB', 'deploy-worker', 'sync-secrets'])
		// Neither the config nor the bundle ran, and nothing but wrangler was started: no `sh`, no `bun`.
		expect(existsSync(fx.configRan)).toBe(false)
		expect(existsSync(fx.bundleRan)).toBe(false)
		expect(new Set(rec.commands.map((spec) => spec.command))).toEqual(new Set(['wrangler']))
		const deploys = rec.commands.filter((spec) => spec.args[0] === 'deploy')
		const application = deploys.find((spec) => spec.cwd === prebuilt.appDir)
		expect(application?.args.slice(0, 2)).toEqual(['deploy', '--no-bundle'])
		// The platform's own proxy is bundled from this package's source, never from the build's output.
		expect(deploys.filter((spec) => spec.cwd !== prebuilt.appDir).every((spec) => spec.args[1] !== '--no-bundle')).toBe(true)
		const migrate = rec.commands.find((spec) => spec.args[0] === 'd1')
		expect(migrate).toMatchObject({ args: ['d1', 'migrations', 'apply', 'DB', '--remote'], cwd: prebuilt.appDir })
		// What oblaka provisioned is this package's classes, with the bundle as the application Worker's `main`.
		const definition = rec.provisions[0]?.definition
		expect(definition).toBeInstanceOf(Worker)
		const { configs } = await generateWranglerConfigs(definition ?? new Worker({ dir: '.', name: 'x', compatibility_flags: [], bindings: {} }), 'stage')
		const app = configs.find((generated) => generated.config.name === 'stage-demo')?.config
		expect(app?.main).toBe('bundle/entry.generated.js')
		expect(app?.d1_databases?.[0]).toMatchObject({ binding: 'DB', database_name: 'stage-demo-db', migrations_dir: 'migrations/DB' })
		// The recorded IAM binding is wrapped by the deployer like an authored one: it names its application.
		expect(app?.services?.find((service) => service.binding === 'IAM')).toMatchObject({
			service: 'stage-propustka-worker',
			entrypoint: 'PropustkaApplication',
			props: { app: 'demo@stage', worker: 'application' },
		})
	})

	test('a release that runs in its object: the build stages the SPA files and the deploy pins the bundle as the entry', async () => {
		const fx = await fixture()
		await linkCli(fx.app)
		for (const mount of ['app', 'share']) await writeFile(join(fx.app, 'dist', mount, 'index.html'), `<title>${mount}</title>`)
		const access: RunnerApprovedAccess = { ...approved, framework: '0.9.0' }
		const { rec: built } = await runBuild(fx, { approved: access })
		// The checks of a pinned release: the tests, a frozen reinstall, the entry, tsc, the checker, the schema types.
		expect(built.commands.map((spec) => spec.command === 'sh' ? 'sh' : `${spec.command} ${spec.args[0]}`)).toEqual([
			'sh',
			'bun install',
			`${join(fx.app, 'node_modules', '.bin', 'fabrika')} app`,
			'sh',
			'sh',
			`${join(fx.app, 'node_modules', '.bin', 'fabrika')} db`,
			'wrangler deploy',
		])
		expect(await readFile(join(fx.out, 'app', 'fabrika', 'assets', 'index.html'), 'utf8')).toBe('<title>app</title>')
		const { rec, result, prebuilt } = await runDeploy(fx, access)
		expect(result.status).toBe('succeeded')
		expect(rec.commands.some((spec) => spec.command !== 'wrangler')).toBe(false)
		const { configs } = await generateWranglerConfigs(
			rec.provisions[0]?.definition ?? new Worker({ dir: '.', name: 'x', compatibility_flags: [], bindings: {} }),
			'stage',
		)
		const app = configs.find((generated) => generated.config.name === 'stage-demo')?.config
		expect(app?.main).toBe('bundle/entry.generated.js')
		expect(app?.assets).toMatchObject({ directory: 'fabrika/assets', binding: 'ASSETS' })
		expect(prebuilt.main).toBe(join(prebuilt.appDir, 'bundle', 'entry.generated.js'))
	})

	test('refuses an output that holds anything wrangler or a runtime would read in the application directory', async () => {
		for (
			const path of ['fabrika.config.ts', 'app/.env', 'app/wrangler.jsonc', 'app/package.json', 'app/bunfig.toml', 'app/fabrika/entry.generated.ts']
		) {
			const fx = await fixture()
			await runBuild(fx, { approved })
			await mkdir(dirname(join(fx.out, path)), { recursive: true })
			await writeFile(join(fx.out, path), 'export default {}\n')
			await expect(openPrebuiltApplication(fx.out, 'stage')).rejects.toThrow(`holds \`${path}\`, which the build may not produce`)
		}
	})

	test('refuses a manifest that is not exactly the data the deploy rebuilds', async () => {
		const fx = await fixture()
		await runBuild(fx, { approved })
		const original = JSON.parse(await readFile(join(fx.out, BUILD_MANIFEST_FILE), 'utf8'))
		const write = async (manifest: unknown): Promise<void> => {
			await rm(join(fx.out, BUILD_MANIFEST_FILE))
			await writeFile(join(fx.out, BUILD_MANIFEST_FILE), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
		}
		const cases: Array<[unknown, string]> = [
			['{"version":1,"__proto__":{"polluted":true}}', 'carries a `__proto__` key'],
			[{ ...original, extra: true }, 'is malformed'],
			[{ ...original, worker: { ...original.worker, main: '../../etc/passwd.js' } }, 'is malformed (worker.main)'],
			[{ ...original, worker: { ...original.worker, options: { ...original.worker.options, dir: '/' } } }, 'is malformed (worker.options)'],
			[{ ...original, env: 'prod' }, 'was built for environment `prod`, not `stage`'],
			['not json', 'is not JSON'],
		]
		for (const [manifest, message] of cases) {
			await write(manifest)
			await expect(openPrebuiltApplication(fx.out, 'stage')).rejects.toThrow(message)
		}
	})

	test('rebuilds each resource only from the options its class takes, and the migrations only from the copy', () => {
		const manifest = (bindings: BuildManifest['worker']['bindings']): BuildManifest => ({
			version: 1,
			appId: 'demo',
			env: 'stage',
			configFile: 'fabrika.config.ts',
			schema: null,
			pipeline: { secrets: [], vars: [] },
			worker: { name: 'demo', main: 'bundle/entry.js', options: {}, bindings },
		})
		expect(() =>
			rebuildApplicationWorker(manifest({ DB: { type: 'resource', kind: 'd1_database', options: { name: 'db', migrationsDir: '../../etc' } } }), '/w')
		)
			.toThrow('names migrations for binding `DB` outside `migrations/DB`')
		expect(() =>
			rebuildApplicationWorker(manifest({ KV: { type: 'resource', kind: 'kv_namespace', options: { name: 'kv', id: 'another-namespace' } } }), '/w')
		)
			.toThrow('describes binding `KV` with options its resource does not take')
		const rebuilt = rebuildApplicationWorker(
			manifest({
				DB: { type: 'resource', kind: 'd1_database', options: { name: 'db', migrationsDir: 'migrations/DB' } },
				KV: { type: 'resource', kind: 'kv_namespace', options: { name: 'kv' } },
				AI: { type: 'config', config: { ai: { binding: 'AI' } } },
			}),
			'/w',
		)
		expect(rebuilt.options.bindings['DB']).toBeInstanceOf(D1Database)
		expect(rebuilt.options.bindings['KV']).toBeInstanceOf(KVNamespace)
		expect(rebuilt.options.bindings['AI']).toBeInstanceOf(RecordedBinding)
		expect(rebuilt.options.main).toBe('bundle/entry.js')
		expect(rebuilt.options.dir).toBe('/w')
	})

	test('takes only the Worker options an authored Worker sets, never a resource by literal name or id', () => {
		const manifest = (options: Record<string, unknown>): BuildManifest => ({
			version: 1,
			appId: 'demo',
			env: 'stage',
			configFile: 'fabrika.config.ts',
			schema: null,
			pipeline: { secrets: [], vars: [] },
			worker: { name: 'demo', main: 'bundle/entry.js', options, bindings: {} },
		})
		// oblaka spreads every option into the generated config, so each would bind past the classes the deploy rebuilds.
		const smuggled: Array<Record<string, unknown>> = [
			{ kv_namespaces: [{ binding: 'STATE', id: 'platform-state-namespace' }] },
			{ d1_databases: [{ binding: 'DB', database_name: 'stage-demo-db', database_id: 'platform-database' }] },
			{ r2_buckets: [{ binding: 'B', bucket_name: 'stage-demo-files' }] },
			{ services: [{ binding: 'S', service: 'stage-demo' }] },
			{ queues: { producers: [{ binding: 'Q', queue: 'stage-demo-q' }] } },
			{ durable_objects: { bindings: [{ name: 'D', class_name: 'D', script_name: 'stage-demo' }] } },
			{ containers: [{ class_name: 'C', image: './Dockerfile' }] },
			{ workflows: [{ binding: 'W', name: 'w', class_name: 'W' }] },
			{ tail_consumers: [{ service: 'stage-demo' }] },
		]
		for (const options of smuggled) {
			expect(() => rebuildApplicationWorker(manifest(options), '/w')).toThrow(`sets the Worker option \`${Object.keys(options)[0]}\``)
		}
		expect(() => rebuildApplicationWorker(manifest({ routes: [{ pattern: 'example.com/*' }] }), '/w')).toThrow(
			'sets the Worker option `routes` to something the deploy does not take',
		)
		expect(() => rebuildApplicationWorker(manifest({ deletedDurableObjects: 'all' }), '/w')).toThrow(
			'sets the Worker option `deletedDurableObjects` to something the deploy does not take',
		)
		const rebuilt = rebuildApplicationWorker(
			manifest({ compatibility_date: '2025-10-01', workers_dev: false, preview_urls: false, routes: [], vars: { MODE: 'x' } }),
			'/w',
		)
		expect(rebuilt.options.vars).toEqual({ MODE: 'x' })
	})

	test("the committed Durable Object history cannot transfer another script's classes into the application", async () => {
		const fx = await fixture()
		await runBuild(fx, { approved })
		const manifest = JSON.parse(await readFile(join(fx.out, BUILD_MANIFEST_FILE), 'utf8'))
		// A transfer moves the class with every object's storage; the token in the deploy may move it from any script.
		manifest.worker.migrations = [{ tag: 'v1', transferred_classes: [{ from: 'Control', from_script: 'stage-vozka', to: 'Room' }] }]
		await rm(join(fx.out, BUILD_MANIFEST_FILE))
		await writeFile(join(fx.out, BUILD_MANIFEST_FILE), JSON.stringify(manifest))
		await expect(runDeploy(fx)).rejects.toThrow('binds the Durable Object classes of script `stage-vozka`, which would take over')
	})

	test('a deploy of a build reads its values only from the values file, and goes without approved access only as a dry run', async () => {
		const fx = await fixture()
		await runBuild(fx, { approved })
		const saved = { values: process.env[DEPLOY_VALUES_FILE_ENV], access: process.env[APPROVED_ACCESS_FILE_ENV] }
		try {
			delete process.env[DEPLOY_VALUES_FILE_ENV]
			delete process.env[APPROVED_ACCESS_FILE_ENV]
			// Without the file the lookup would read this environment, where the manifest could name the token.
			await expect(deployCloudflareBundle({ env: 'stage', bundleDir: fx.out })).rejects.toThrow(`reads its values from ${DEPLOY_VALUES_FILE_ENV}`)
			const valuesFile = join(fx.root, 'values.json')
			await writeFile(valuesFile, '{}')
			process.env[DEPLOY_VALUES_FILE_ENV] = valuesFile
			await expect(deployCloudflareBundle({ env: 'stage', bundleDir: fx.out })).rejects.toThrow('needs the access Control approved')
		} finally {
			for (const [name, value] of [[DEPLOY_VALUES_FILE_ENV, saved.values], [APPROVED_ACCESS_FILE_ENV, saved.access]] as const) {
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
		}
	})

	test('a recorded binding writes only its own service or AI entry, never a key that steers what wrangler reads or deploys', async () => {
		// Each would replace what oblaka wrote for the Worker: \`main\` outside the copy makes wrangler read the checkout as
		// root and upload what its links point at; another \`name\` would bundle the Worker; a D1 entry names its own migrations.
		const steering: Array<Record<string, unknown>> = [
			{ main: '/workspace/run/evil/index.mjs' },
			{ name: 'stage-demo-shadow' },
			{ migrations: [] },
			{ d1_databases: [{ binding: 'X', database_name: 'stage-demo-db', database_id: 'id', migrations_dir: '/workspace/run/sql' }] },
			{ services: [{ binding: 'OTHER', service: 'stage-demo-x' }] },
			{ services: [{ binding: 'X', service: 'stage-demo-x' }], main: '/elsewhere.mjs' },
		]
		for (const config of steering) {
			const fx = await fixture()
			await runBuild(fx, { approved })
			const manifest = JSON.parse(await readFile(join(fx.out, BUILD_MANIFEST_FILE), 'utf8'))
			manifest.worker.bindings = { ...manifest.worker.bindings, X: { type: 'config', config } }
			await rm(join(fx.out, BUILD_MANIFEST_FILE))
			await writeFile(join(fx.out, BUILD_MANIFEST_FILE), JSON.stringify(manifest))
			await expect(runDeploy(fx)).rejects.toThrow('describes binding `X` with config entries other than its own service or AI binding')
		}
	})

	test('the deploy itself uploads only the bundle unbundled and only its proxy bundled, whatever rebuilt the config', async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ main: '/workspace/run/evil/index.mjs' }, 'runs something other than the bundle the build produced'],
			[{ name: 'stage-demo-shadow' }, 'is neither the application the build described nor its proxy'],
		]
		for (const [recorded, message] of cases) {
			const fx = await fixture()
			await runBuild(fx, { approved })
			const prebuilt = await openPrebuiltApplication(fx.out, 'stage')
			// Past the manifest's check, as a regression there would be.
			const steered = {
				...prebuilt.config,
				resources: () => {
					const worker = rebuildApplicationWorker(prebuilt.manifest, prebuilt.appDir)
					worker.options.bindings['X'] = new RecordedBinding(recorded)
					return worker
				},
			}
			const rec: DeployRecord = { commands: [], provisions: [] }
			const result = await createCloudflareDeployer({
				accountId: 'acc-1',
				apiToken: 'tok-deploy',
				collaborators: { ...deployCollaborators(rec, prebuilt), loadConfig: async () => ({ config: steered, cwd: prebuilt.appDir }) },
				prebuilt: { main: prebuilt.main },
			})({
				appId: prebuilt.config.id,
				env: 'stage',
				domain: 'stage.example.com',
				cwd: prebuilt.appDir,
				configPath: join(prebuilt.appDir, prebuilt.manifest.configFile),
				secrets: { API_KEY: 'api-key-value' },
				vars: { PUBLIC_URL: 'https://stage.example.com' },
				managedEnvironment: parseManagedEnvironment({ FABRIKA_IAM_ISSUER: 'https://iam.example.com' }),
				approved,
				dryRun: false,
				signal: new AbortController().signal,
				log: () => {},
			})
			expect(result.status).toBe('failed')
			expect(JSON.stringify(result.steps)).toContain(message)
			expect(rec.commands.some((spec) => spec.args[0] === 'deploy')).toBe(false)
		}
	})

	test('refuses a build that describes another application than the one Control approved', async () => {
		const fx = await fixture()
		await runBuild(fx, { approved })
		const manifest = JSON.parse(await readFile(join(fx.out, BUILD_MANIFEST_FILE), 'utf8'))
		await rm(join(fx.out, BUILD_MANIFEST_FILE))
		await writeFile(join(fx.out, BUILD_MANIFEST_FILE), JSON.stringify({ ...manifest, appId: 'other' }))
		const accessFile = join(fx.root, 'access.json')
		await writeFile(accessFile, JSON.stringify(approved))
		const valuesFile = join(fx.root, 'values.json')
		await writeFile(valuesFile, '{}')
		const saved = { values: process.env[DEPLOY_VALUES_FILE_ENV], access: process.env[APPROVED_ACCESS_FILE_ENV] }
		process.env[APPROVED_ACCESS_FILE_ENV] = accessFile
		process.env[DEPLOY_VALUES_FILE_ENV] = valuesFile
		try {
			await expect(deployCloudflareBundle({ env: 'stage', bundleDir: fx.out })).rejects.toThrow(
				`the build describes application \`other\`, but Control approved \`${notesArtifact.app}\``,
			)
		} finally {
			for (const [name, value] of [[DEPLOY_VALUES_FILE_ENV, saved.values], [APPROVED_ACCESS_FILE_ENV, saved.access]] as const) {
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
		}
	})
})

describe('build values', () => {
	test('carry the vars and the public managed values, never a managed credential, and keep `__proto__` a name', () => {
		const values = buildValuesOf({
			vars: { PUBLIC_URL: 'u', ['__proto__']: 'p' },
			managedEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam', FABRIKA_PROXY_SECRET: 'secret', FABRIKA_OPERATIONS_DSN: 'https://key@ops/1' },
		})
		expect(Object.hasOwn(values.vars, '__proto__')).toBe(true)
		expect(values.managed).toEqual({ FABRIKA_IAM_ISSUER: 'https://iam' })
		const parsed = parseBuildValues(JSON.stringify(values))
		expect(Object.hasOwn(parsed.vars, '__proto__')).toBe(true)
		expect(parsed.managed).toEqual({ FABRIKA_IAM_ISSUER: 'https://iam' })
		expect(() => parseBuildValues('{"vars":{"A":1},"managed":{}}')).toThrow('a value under `vars` that is not text')
	})
})
