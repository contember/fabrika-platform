import {
	type AppActionDef,
	type AppEnvironment,
	artifactAccessDigest,
	type ContractArtifact,
	contractDigest,
	type GateRule,
} from '@fabrika/auth-core'
import { contractProxyTable, isContractProxyApp, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { D1Database, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type {
	CloudflareAppConfig,
	CloudflareAppConfigInput,
	CloudflareCollaborators,
	CommandResult,
	CommandRunner,
	CommandSpec,
	ProvisionInput,
} from '..'
import {
	createCloudflareDeployer,
	createCloudflareProxyWorker,
	defaultCloudflareCollaborators,
	defineApp,
	generateWranglerConfigs,
	IAM_APPLICATION_ENTRYPOINT,
	iamServiceReference,
} from '..'
import { CLOUDFLARE_PROXY_WORKER_DIR } from '../proxy'
import type { RunnerOutcomeFile } from '../runner-protocol'

interface Recorded {
	readonly commands: CommandSpec[]
	readonly provisions: ProvisionInput[]
	readonly outcomes: RunnerOutcomeFile[]
	readonly logs: string[]
	readonly provisionedVars: Array<Record<string, unknown> | undefined>
	readonly applicationVars: Array<Record<string, unknown> | undefined>
}

const config = (overrides: Partial<CloudflareAppConfigInput> = {}): CloudflareAppConfig =>
	defineApp({
		id: 'demo',
		resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		...overrides,
	})

/** An application Worker is reachable only through its proxy, so every fixture app turns both URLs off. */
const PRIVATE: { readonly workers_dev: false; readonly preview_urls: false } = { workers_dev: false, preview_urls: false }

const appWorker = (): Worker => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' })

const bindingIam = (iam: Bindable): Worker =>
	new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: { IAM: iam }, main: 'src/index.ts' })

/** The gates an application without a contract hands the platform-built proxy. */
const GATES = { rules: [{ path: '/*', kind: 'public' as const }] }

/** Where a checkout's own `bun install` puts this package: proxy code from here is the checkout's, never the platform's. */
const INSTALLED_PROXY_DIR = '/repo/node_modules/@fabrika/provider-cloudflare/src'

/** A binding that writes whatever it likes into the generated config: oblaka calls `configureBinding` on any object. */
const emitting = (extra: Record<string, unknown>): Bindable => ({ configureBinding: ({ config }) => ({ ...config, ...extra }) })

/** A checkout is plain JavaScript: its options object carries whatever raw wrangler keys it likes. */
const withRawOptions = (worker: Worker, raw: Record<string, unknown>): Worker => {
	Object.assign(worker.options, raw)
	return worker
}

type GeneratedService = { binding: string; service: string; entrypoint?: string }

/** Any object oblaka calls `configureBinding` on: a checkout can hand it one of its own. */
type Bindable = Pick<ServiceReference, 'configureBinding'>

const makeCollaborators = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	commandResult: (spec: CommandSpec) => CommandResult = () => ({ exitCode: 0, stdout: '', stderr: '' }),
	checkoutDir = '/repo/app',
	runCommand?: CommandRunner,
	generatedServices?: GeneratedService[],
	checkoutContract: ContractArtifact | null = null,
): CloudflareCollaborators => ({
	loadConfig: async (_cwd, configPath) => {
		expect(configPath).toBe('fabrika.config.ts')
		return { config: appConfig, cwd: checkoutDir }
	},
	readContract: async (root) => {
		expect(root).toBe(checkoutDir)
		return checkoutContract
	},
	runCommand: async (spec) => {
		rec.commands.push(spec)
		return runCommand === undefined ? commandResult(spec) : runCommand(spec)
	},
	provision: async (input) => {
		rec.provisions.push(input)
		rec.provisionedVars.push(input.definition instanceof Worker ? input.definition.options.vars : undefined)
		const app = input.definition instanceof Worker ? input.definition.options.bindings?.['APP'] : undefined
		rec.applicationVars.push(app instanceof Worker ? app.options.vars : undefined)
		if (input.definition === undefined) throw new Error('nothing to provision')
		// What oblaka writes, from its own processor; `generatedServices` stands in for a binding that emits differently the second time.
		const { configs } = await generateWranglerConfigs(input.definition, input.env)
		const wranglerConfigs = configs.map((generated) =>
			generatedServices === undefined || generated.config.name?.endsWith('-proxy') === true
				? generated
				: { ...generated, config: { ...generated.config, services: generatedServices } }
		)
		return { wranglerConfigs, wranglerConfig: wranglerConfigs[0]?.config ?? {} }
	},
	writeOutcome: async (outcome) => {
		rec.outcomes.push(outcome)
	},
})

const deploy = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	options: {
		readonly dryRun?: boolean
		readonly secrets?: Readonly<Record<string, string>>
		readonly signal?: AbortSignal
		readonly commandResult?: (spec: CommandSpec) => CommandResult
		readonly runCommand?: CommandRunner
		readonly appId?: string
		readonly managedEnvironment?: Readonly<Record<string, string | null>>
		readonly returnOrigins?: readonly string[]
		readonly domain?: string
		readonly platformResources?: 'refuse' | 'allow'
		readonly stateNamespace?: string
		readonly env?: string
		readonly checkoutDir?: string
		readonly generatedServices?: GeneratedService[]
		/** What `fabrika.contract.ts` in the checkout reads as; none by default. */
		readonly checkoutContract?: ContractArtifact
		/** The contract Control approved for the run, or null when Control read none at the commit. */
		readonly contract?: ContractArtifact | null
		readonly artifactApproval?: { readonly digest: string | null; readonly protected: boolean }
		readonly installationApps?: readonly AppEnvironment[]
	} = {},
) =>
	createCloudflareDeployer({
		accountId: 'acc-1',
		apiToken: 'tok-1',
		collaborators: makeCollaborators(
			rec,
			appConfig,
			options.commandResult,
			options.checkoutDir,
			options.runCommand,
			options.generatedServices,
			options.checkoutContract,
		),
		...(options.platformResources === undefined ? {} : { platformResources: options.platformResources }),
	})({
		appId: options.appId ?? 'demo',
		env: options.env ?? 'stage',
		domain: options.domain ?? 'stage.example.com',
		...(options.returnOrigins === undefined ? {} : { returnOrigins: options.returnOrigins }),
		cwd: '/repo',
		configPath: 'fabrika.config.ts',
		...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		secrets: options.secrets ?? {},
		vars: {},
		managedEnvironment: options.managedEnvironment ?? {},
		...(options.contract === undefined ? {} : { contract: options.contract }),
		...(options.artifactApproval === undefined ? {} : { artifactApproval: options.artifactApproval }),
		...(options.installationApps === undefined ? {} : { installationApps: options.installationApps }),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: (line) => {
			rec.logs.push(line)
		},
	})

const stepError = (result: Awaited<ReturnType<typeof deploy>>, id: string): string | undefined => result.steps.find((step) => step.id === id)?.error

const fixtures: string[] = []

/** A real checkout on disk: the symlink bound is about what wrangler would follow, not about a config value. */
const assetsCheckout = async (build: (assets: string) => Promise<void>): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
	fixtures.push(root)
	await writeFile(join(root, 'secret.txt'), 'not for the public')
	const assets = join(root, 'public')
	await mkdir(assets)
	await build(assets)
	return root
}

const assetsApp = (): CloudflareAppConfig =>
	config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory: 'public' } }) })

let rec: Recorded
beforeEach(() => {
	rec = { commands: [], provisions: [], outcomes: [], logs: [], provisionedVars: [], applicationVars: [] }
})

afterEach(async () => {
	for (const root of fixtures.splice(0)) {
		await rm(root, { recursive: true, force: true })
	}
})

describe('Cloudflare provider', () => {
	test('merges platform-managed values into the root Worker without exposing them in logs', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, config(), {
			dryRun: true,
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: dsn,
				FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit',
				FABRIKA_SERVICE_KEY: null,
			},
		})
		expect(rec.provisionedVars[0]).toMatchObject({
			FABRIKA_OPERATIONS_DSN: dsn,
			FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit',
		})
		expect(rec.provisionedVars[0]).not.toHaveProperty('FABRIKA_SERVICE_KEY')
		expect(rec.logs.join('\n')).not.toContain(dsn)
	})

	test('rejects authored collisions with platform-managed values by name only', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const authored = config({
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					vars: { FABRIKA_OPERATIONS_DSN: 'authored' },
				}),
		})
		await expect(deploy(rec, authored, { managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })).rejects.toThrow(
			'application variable `FABRIKA_OPERATIONS_DSN` is managed by Fabrika',
		)
		expect(rec.logs.join('\n')).not.toContain(dsn)
	})

	test('targets platform-managed values at the private application Worker behind the platform proxy', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, config({ gates: GATES }), { dryRun: true, managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })
		expect(rec.provisionedVars[0]).not.toHaveProperty('FABRIKA_OPERATIONS_DSN')
		expect(rec.applicationVars[0]).toMatchObject({ FABRIKA_OPERATIONS_DSN: dsn })
	})

	test('plans nested D1 migration and deploys every generated Worker config', async () => {
		const app = new Worker({
			dir: '.',
			...PRIVATE,
			name: 'demo',
			compatibility_flags: [],
			bindings: { DB: new D1Database({ name: 'main', migrationsDir: './migrations' }) },
			main: 'src/index.ts',
		})
		const authored = config({ gates: GATES, resources: () => app, pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] } })
		const result = await deploy(rec, authored, { secrets: { API_KEY: 'secret-value' } })
		expect(result.steps.map((step) => step.id)).toEqual(['build', 'provision-resources', 'migrate:APP.DB', 'deploy-worker', 'sync-secrets'])
		expect(result.status).toBe('succeeded')
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			['sh', '-c', 'bun run build'],
			['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote'],
			['wrangler', 'deploy'],
			['wrangler', 'deploy'],
			['wrangler', 'secret', 'put', 'API_KEY'],
		])
		expect(rec.commands[1]?.cwd).toBe('/repo/app/worker')
		// The proxy is deployed from the platform's own copy of this package, the application from the checkout.
		expect(rec.commands[2]?.cwd).toBe(CLOUDFLARE_PROXY_WORKER_DIR)
		expect(rec.commands[3]?.cwd).toBe('/repo/app/worker')
		expect(rec.commands[4]?.cwd).toBe('/repo/app/worker')
	})

	test('loads the checkout config and preserves the canonical Cloudflare plan', async () => {
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'main', migrationsDir: './migrations' }) },
				}),
		})
		const result = await deploy(rec, app, { secrets: { API_KEY: 'secret' } })

		expect(result.steps.map((step) => step.id)).toEqual([
			'build',
			'provision-resources',
			'migrate:DB',
			'deploy-worker',
			'reconcile-schema',
			'sync-secrets',
		])
	})

	test('executes the plan through the provider collaborator bundle', async () => {
		const controller = new AbortController()
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] },
		})
		await deploy(rec, app, { secrets: { API_KEY: 'secret-value' }, signal: controller.signal })

		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.accountId).toBe('acc-1')
		expect(rec.provisions[0]?.apiToken).toBe('tok-1')
		expect(rec.provisions[0]?.cwd).toBe('/repo/app/worker')
		expect(rec.provisions[0]?.stateNamespace).toBe('demo-state')
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			['sh', '-c', 'bun run build'],
			['wrangler', 'deploy'],
			['wrangler', 'secret', 'put', 'API_KEY'],
		])
		expect(rec.commands[1]?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
		expect(rec.commands[2]?.stdin).toBe('secret-value')
		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' } }])
	})

	test('reports the authz schema for the control plane instead of calling IAM from the container', async () => {
		const schema = { scopes: [{ type: 'team' }], actions: [{ action: 'notes.read' }], roles: {} }
		await deploy(rec, config({ schema }), { returnOrigins: ['https://demo.example.com'] })

		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: JSON.stringify(schema) } }])
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([['wrangler', 'deploy']])
	})

	test('refuses to report an outcome once the run is cancelled', async () => {
		const controller = new AbortController()
		const result = await deploy(rec, config({ schema: { scopes: [], actions: [], roles: {} } }), {
			signal: controller.signal,
			commandResult: () => {
				controller.abort()
				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'failed', 'skipped'])
		expect(stepError(result, 'deploy-worker')).toBe('deploy cancelled')
		expect(rec.outcomes).toHaveLength(0)
	})

	test('dry-run keeps Oblaka in plan mode and skips every other mutation', async () => {
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
		})
		const result = await deploy(rec, app, { dryRun: true, secrets: { API_KEY: 'secret-value' } })
		expect(result.status).toBe('succeeded')
		expect(rec.logs[0]).toBe('Deploy demo → stage (dry-run) — 5 step(s):')

		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.dryRun).toBe(true)
		expect(rec.commands).toHaveLength(0)
		expect(rec.outcomes).toHaveLength(0)
		expect(rec.logs.some((line) => line.includes('would run build'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('wrangler secret put API_KEY'))).toBe(true)
	})

	test('fails closed when the loaded config belongs to another app', async () => {
		await expect(deploy(rec, config({ id: 'other' }))).rejects.toThrow('declares app "other", expected "demo"')
	})

	test('honours an already-aborted run before the first mutation', async () => {
		const result = await deploy(rec, config(), { signal: AbortSignal.abort() })
		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['skipped', 'skipped'])
		expect(rec.logs).toContain('∅ provision-resources: deploy cancelled')
		expect(rec.provisions).toHaveLength(0)
	})

	test('abandons a step that ignores the cancellation and starts no later step', async () => {
		const controller = new AbortController()
		const result = await deploy(rec, config({ pipeline: { build: 'bun run build', secrets: ['API_KEY'] } }), {
			secrets: { API_KEY: 'secret-value' },
			signal: controller.signal,
			runCommand: () => {
				controller.abort()
				return new Promise<never>(() => {})
			},
		})
		expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped'])
		expect(stepError(result, 'build')).toBe('deploy cancelled')
		expect(rec.provisions).toHaveLength(0)
		expect(rec.commands.map((command) => command.command)).toEqual(['sh'])
	})

	test('reports shell failures without leaking beyond the bounded command detail', async () => {
		const result = await deploy(rec, config({ pipeline: { secrets: ['API_KEY'] } }), {
			secrets: { API_KEY: 'secret-value' },
			commandResult: (spec) =>
				spec.command === 'wrangler'
					? { exitCode: 1, stdout: '', stderr: 'deploy failed' }
					: { exitCode: 0, stdout: '', stderr: '' },
		})
		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'failed', 'skipped'])
		expect(stepError(result, 'deploy-worker')).toBe('wrangler deploy failed (exit 1): deploy failed')
		expect(rec.logs).toContain('  • deploy-worker — Deploy the Worker (`wrangler deploy`)')
		expect(rec.logs).toContain('✗ deploy-worker: wrangler deploy failed (exit 1): deploy failed')
		expect(rec.commands.map((command) => command.args[0])).toEqual(['deploy'])
	})

	test('runs the checkout build with no platform credential in its environment', async () => {
		await deploy(rec, config({ pipeline: { build: 'bun run build' } }))

		expect(rec.commands[0]?.omitEnv).toContain('CLOUDFLARE_API_TOKEN')
		expect(rec.commands[0]?.omitEnv).toContain('CLOUDFLARE_ACCOUNT_ID')
		expect(rec.commands[0]?.omitEnv).toContain('FABRIKA_IAM_PROVISIONING_KEY')

		process.env['CLOUDFLARE_API_TOKEN'] = 'tok-from-the-platform'
		try {
			const result = await defaultCloudflareCollaborators.runCommand({
				command: 'sh',
				args: ['-c', 'echo "[${CLOUDFLARE_API_TOKEN-}]"'],
				cwd: import.meta.dir,
				omitEnv: ['CLOUDFLARE_API_TOKEN'],
			})
			expect(result.stdout.trim()).toBe('[]')
		} finally {
			delete process.env['CLOUDFLARE_API_TOKEN']
		}
	})

	test('refuses a config that names a platform resource, before any provisioning', async () => {
		const platformWorker = config({
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'vozka', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, platformWorker)).rejects.toThrow(
			'Worker `vozka` becomes `stage-vozka`, which would take over the Fabrika platform resource `vozka`',
		)

		const platformBucket = config({
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					bindings: { LOGS: new R2Bucket({ name: 'vozka-run-logs' }), QUEUE: new Queue({ name: 'vozka-deploy' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, platformBucket)).rejects.toThrow(
			'R2 bucket `vozka-run-logs` becomes `stage-vozka-run-logs`, which would take over the Fabrika platform resource `vozka-run-logs`',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('lets fabrika deploy its own components under the explicit platform policy', async () => {
		const platformWorker = config({
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'vozka', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		const result = await deploy(rec, platformWorker, { platformResources: 'allow' })
		expect(result.steps[0]?.id).toBe('provision-resources')
		expect(result.status).toBe('succeeded')
	})

	test("only the platform proxy is routed, on this environment's own domain", async () => {
		const foreign = [{ pattern: 'other-app.example.com/*', zone_name: 'example.com' }]
		const routed = config({ gates: GATES, resources: () => bindingIam(emitting({ routes: foreign })) })
		await expect(deploy(rec, routed)).rejects.toThrow('application Worker `stage-demo` declares `routes`; only its proxy Worker is routed')
		expect(rec.provisions).toHaveLength(0)

		await expect(deploy(rec, config({ gates: GATES }))).resolves.toMatchObject({ status: 'succeeded' })
		const { root } = provisioned()
		expect(root.options.routes).toEqual([{ pattern: 'stage.example.com', custom_domain: true }])
	})

	test('refuses a route, workers.dev or preview URLs on an application Worker, proxied or not', async () => {
		const ownRoute = [{ pattern: 'stage.example.com', custom_domain: true }]
		const exposed: ReadonlyArray<readonly [Record<string, unknown>, string, string]> = [
			[
				{ routes: ownRoute },
				'application Worker `stage-demo` declares `routes`; only its proxy Worker is routed (omit it or set `[]`)',
				'cloudflare proxy app `demo` must not declare public routes',
			],
			[{ routes: 'stage.example.com' }, 'application Worker `stage-demo` declares `routes`', 'must not declare public routes'],
			[
				{ workers_dev: true },
				'application Worker `stage-demo` leaves `workers_dev` on; it would be public on workers.dev (set `workers_dev: false`)',
				'cloudflare proxy app `demo` must disable workers.dev',
			],
			[{ workers_dev: undefined }, 'application Worker `stage-demo` leaves `workers_dev` on', 'must disable workers.dev'],
			[
				{ preview_urls: true },
				'application Worker `stage-demo` leaves `preview_urls` on; every version would be public on workers.dev (set `preview_urls: false`)',
				'application Worker `stage-demo` leaves `preview_urls` on',
			],
			[
				{ preview_urls: undefined },
				'application Worker `stage-demo` leaves `preview_urls` on',
				'application Worker `stage-demo` leaves `preview_urls` on',
			],
		]
		for (const [raw, alone, proxied] of exposed) {
			await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), raw) }))).rejects.toThrow(alone)
			await expect(deploy(rec, config({ gates: GATES, resources: () => withRawOptions(appWorker(), raw) }))).rejects.toThrow(proxied)
		}
		expect(rec.provisions).toHaveLength(0)

		await expect(deploy(rec, config({ gates: GATES, resources: () => withRawOptions(appWorker(), { routes: [] }) }))).resolves.toMatchObject({
			status: 'succeeded',
		})
	})

	test('refuses a route, workers.dev or preview URLs that a binding writes into the generated config', async () => {
		const probes: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ routes: [{ pattern: 'stage.example.com', custom_domain: true }] }, 'application Worker `stage-demo` declares `routes`'],
			[{ workers_dev: true }, 'application Worker `stage-demo` leaves `workers_dev` on'],
			[{ preview_urls: true }, 'application Worker `stage-demo` leaves `preview_urls` on'],
		]
		for (const [extra, message] of probes) {
			await expect(deploy(rec, config({ gates: GATES, resources: () => bindingIam(emitting(extra)) }))).rejects.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('refuses every config Worker that binds `APP`, the provider proxy from the checkout included', async () => {
		const ownRoute = [{ pattern: 'stage.example.com', custom_domain: true }]
		const publicRoot = (dir: string, main: string): Worker =>
			new Worker({
				dir,
				name: 'demo-root',
				main,
				compatibility_flags: [],
				workers_dev: true,
				preview_urls: true,
				routes: ownRoute,
				bindings: { APP: appWorker() },
			})
		const checkoutProxy = createCloudflareProxyWorker({
			name: 'demo-proxy',
			app: appWorker(),
			appId: 'demo@stage',
			appHost: 'stage.example.com',
			domain: 'stage.example.com',
			gates: GATES,
		})
		const impostors = [
			publicRoot('.', 'src/app.ts'),
			publicRoot('.', './proxy-worker.ts'),
			publicRoot(INSTALLED_PROXY_DIR, './proxy-worker.ts'),
			publicRoot(CLOUDFLARE_PROXY_WORKER_DIR, './proxy-worker.ts'),
			checkoutProxy,
		]
		for (const impostor of impostors) {
			for (const gates of [GATES, undefined]) {
				await expect(deploy(rec, config({ gates, resources: () => impostor }))).rejects.toThrow(
					'binding `APP`, a proxy of its own; return the application Worker and declare `gates`',
				)
			}
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('leaves a platform component its own route and URLs under the platform policy', async () => {
		const component = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'propustka-worker',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					routes: [{ pattern: 'stage.example.com', custom_domain: true }],
				}),
		})
		await expect(deploy(rec, component, { platformResources: 'allow' })).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('refuses a service binding to a platform service, but not the IAM front door every app binds', async () => {
		const toRunner = config({ resources: () => bindingIam(new ServiceReference('vozka-runner')) })
		await expect(deploy(rec, toRunner)).rejects.toThrow(
			'Worker `stage-demo` binds service `stage-vozka-runner`, which would take over the Fabrika platform resource `vozka-runner`',
		)

		const toIam = config({ resources: () => bindingIam(iamServiceReference()) })
		await expect(deploy(rec, toIam)).resolves.toMatchObject({ status: 'succeeded' })
	})

	test("refuses IAM's default entrypoint and any entrypoint but the application one", async () => {
		await expect(deploy(rec, config({ resources: () => bindingIam(new ServiceReference('propustka-worker')) }))).rejects.toThrow(
			'Worker `stage-demo` binds `stage-propustka-worker` to its default entrypoint; an application binds `PropustkaApplication`',
		)
		for (const entrypoint of ['Propustka', '', 'default']) {
			await expect(deploy(rec, config({ resources: () => bindingIam(new ServiceReference('propustka-worker', entrypoint)) }))).rejects.toThrow(
				`Worker \`stage-demo\` binds \`stage-propustka-worker\` to entrypoint \`${entrypoint}\``,
			)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('checks the service bindings a Worker emits, whatever object emits them', async () => {
		const toFullIam: Bindable = {
			configureBinding: ({ config, binding, env }) => ({
				...config,
				services: [...(config.services ?? []), { binding, service: `${env}-propustka-worker` }],
			}),
		}
		await expect(deploy(rec, config({ resources: () => bindingIam(toFullIam) }))).rejects.toThrow(
			'Worker `stage-demo` binds `stage-propustka-worker` to its default entrypoint; an application binds `PropustkaApplication`',
		)

		class InnocentReference extends ServiceReference {
			override configureBinding(args: Parameters<ServiceReference['configureBinding']>[0]) {
				return { ...args.config, services: [{ binding: args.binding, service: `${args.env}-vozka-runner` }] }
			}
		}
		await expect(deploy(rec, config({ resources: () => bindingIam(new InnocentReference('demo-helper')) }))).rejects.toThrow(
			'Worker `stage-demo` binds service `stage-vozka-runner`, which would take over the Fabrika platform resource `vozka-runner`',
		)

		const rewritesEarlier: Bindable = {
			configureBinding: ({ config }) => ({ ...config, services: (config.services ?? []).map(({ entrypoint: _, ...entry }) => entry) }),
		}
		const twoBindings = new Worker({
			dir: '.',
			...PRIVATE,
			name: 'demo',
			compatibility_flags: [],
			bindings: { IAM: iamServiceReference(), OTHER: rewritesEarlier },
			main: 'src/index.ts',
		})
		await expect(deploy(rec, config({ resources: () => twoBindings }))).rejects.toThrow('binds `stage-propustka-worker` to its default entrypoint')
		expect(rec.provisions).toHaveLength(0)
	})

	test('checks the generated wrangler config again before each wrangler deploy', async () => {
		const result = await deploy(rec, config({ resources: () => bindingIam(iamServiceReference()) }), {
			generatedServices: [{ binding: 'IAM', service: 'stage-propustka-worker' }],
		})
		expect(result.status).toBe('failed')
		expect(stepError(result, 'deploy-worker')).toContain('Worker `stage-demo` binds `stage-propustka-worker` to its default entrypoint')
		expect(rec.commands.some((command) => command.command === 'wrangler' && command.args[0] === 'deploy')).toBe(false)

		const narrow = await deploy(rec, config({ resources: () => bindingIam(iamServiceReference()) }), {
			generatedServices: [{ binding: 'IAM', service: 'stage-propustka-worker', entrypoint: 'PropustkaApplication' }],
		})
		expect(narrow.status).toBe('succeeded')
	})

	// `packages/iam/src/__tests__/index.test.ts` pins the same name as the narrow class IAM exports.
	test('an application and its platform-built proxy bind IAM at PropustkaApplication', async () => {
		expect(IAM_APPLICATION_ENTRYPOINT).toBe('PropustkaApplication')
		await expect(deploy(rec, config({ gates: GATES, resources: () => bindingIam(iamServiceReference()) }))).resolves.toMatchObject({
			status: 'succeeded',
		})
		const { root, app } = provisioned()
		for (const worker of [app, root]) {
			const iam = worker.options.bindings?.['IAM']
			const services = iam instanceof ServiceReference ? iam.configureBinding({ config: {}, binding: 'IAM', env: 'stage' }).services : undefined
			expect(services).toEqual([{ binding: 'IAM', service: 'stage-propustka-worker', entrypoint: 'PropustkaApplication' }])
		}
	})

	test('a platform component keeps binding the default entrypoint under the platform policy', async () => {
		const control = config({ resources: () => bindingIam(new ServiceReference('propustka-worker')) })
		await expect(deploy(rec, control, { platformResources: 'allow' })).resolves.toMatchObject({ status: 'succeeded' })
	})

	test("refuses a deploy whose oblaka state namespace is the platform's own", async () => {
		await expect(deploy(rec, config(), { stateNamespace: 'propustka-state' })).rejects.toThrow(
			'state namespace `propustka-state` is a Fabrika platform resource',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('the platform policy relaxes resource names only — the route bound still holds', async () => {
		const platformOffHost = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'vozka',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					routes: [{ pattern: 'other-app.example.com/*', zone_name: 'example.com' }],
				}),
		})
		await expect(deploy(rec, platformOffHost, { platformResources: 'allow' })).rejects.toThrow(
			"routes `other-app.example.com`, which is not this environment's domain",
		)
	})

	test('refuses a Worker the deploy does not own, however it is bound', async () => {
		const smuggled = config({
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					bindings: { SIDECAR: new Worker({ dir: '.', ...PRIVATE, name: 'demo-sidecar', compatibility_flags: [], bindings: {}, main: 'src/other.ts' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, smuggled)).rejects.toThrow(
			'declares Worker `stage-demo-sidecar`; only the application Worker and its proxy are deployable',
		)
	})

	test('refuses every raw wrangler key that would bind a platform resource or run a command, proxied or not', async () => {
		const smuggled: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ services: [{ binding: 'CTRL', service: 'stage-vozka' }] }, 'binds service `stage-vozka`, which would take over'],
			[
				{ durable_objects: { bindings: [{ name: 'RC', class_name: 'RunnerContainer', script_name: 'stage-vozka-runner' }] } },
				'binds the Durable Object script `stage-vozka-runner`, which would take over',
			],
			[{ r2_buckets: [{ binding: 'LOGS', bucket_name: 'stage-vozka-run-logs' }] }, 'binds R2 bucket `stage-vozka-run-logs`, which would take over'],
			[{ queues: { producers: [{ binding: 'Q', queue: 'stage-vozka-deploy' }] } }, 'binds queue `stage-vozka-deploy`, which would take over'],
			[{ build: { command: 'cat /proc/self/environ' } }, 'Worker `stage-demo` sets `build`, which an app may not configure'],
			[{ site: { bucket: '../..' } }, 'Worker `stage-demo` sets `site`, which an app may not configure'],
			[{ tail_consumers: [{ service: 'stage-demo' }] }, 'Worker `stage-demo` sets `tail_consumers`, which an app may not configure'],
		]
		for (const [raw, message] of smuggled) {
			for (const gates of [undefined, GATES]) {
				await expect(deploy(rec, config({ gates, resources: () => withRawOptions(appWorker(), raw) }))).rejects.toThrow(message)
				await expect(deploy(rec, config({ gates, resources: () => bindingIam(emitting(raw)) }))).rejects.toThrow(message)
			}
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('a binding cannot bind a D1 database or KV namespace by a literal id', async () => {
		const probes: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ d1_databases: [{ binding: 'DB', database_name: 'stage-demo-db', database_id: '0000-other' }] }, 'binds a D1 database by an id'],
			[{ kv_namespaces: [{ binding: 'KV', id: 'another-namespace-id' }] }, 'binds a KV namespace by an id'],
		]
		for (const [extra, message] of probes) {
			await expect(deploy(rec, config({ gates: GATES, resources: () => bindingIam(emitting(extra)) }))).rejects.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)
		const declared = config({ gates: GATES, resources: () => bindingIam(new KVNamespace({ name: 'demo-cache' })) })
		await expect(deploy(rec, declared)).resolves.toMatchObject({ status: 'succeeded' })
	})

	test("the platform-built proxy mints for this deployment's own `<app>@<env>`", async () => {
		for (const env of ['stage', 'prod']) {
			rec.provisions.length = 0
			await expect(deploy(rec, config({ gates: GATES }), { env })).resolves.toMatchObject({ status: 'succeeded' })
			const manifest = provisioned().root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
			expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps.map((app) => app.id)).toEqual([`demo@${env}`])
		}
	})

	test('keeps the Worker options an application config legitimately sets', async () => {
		const app = new Worker({
			dir: '.',
			name: 'demo',
			main: 'src/index.ts',
			compatibility_flags: ['nodejs_compat_v2'],
			compatibility_date: '2025-10-01',
			workers_dev: false,
			preview_urls: false,
			observability: { enabled: true },
			triggers: { crons: ['0 3 * * *'] },
			assets: { binding: 'ASSETS', directory: 'dist', not_found_handling: 'single-page-application' },
			vars: { ENVIRONMENT: 'stage' },
			routes: [],
			bindings: { DB: new D1Database({ name: 'notes' }) },
		})
		await expect(deploy(rec, config({ gates: GATES, resources: () => app }))).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('bounds the name oblaka adopts, so an env name cannot split the platform prefix', async () => {
		const worker = config({
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'worker', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, worker, { env: 'prod-propustka' })).rejects.toThrow(
			'Worker `worker` becomes `prod-propustka-worker`, which would take over the Fabrika platform resource `propustka-worker`',
		)

		const split: ReadonlyArray<readonly [string, string, Record<string, D1Database | KVNamespace | R2Bucket>, string]> = [
			['prod-propustka', 'D1 database `worker`', { DB: new D1Database({ name: 'worker' }) }, 'propustka-worker'],
			['prod-propustka', 'KV namespace `state`', { CACHE: new KVNamespace({ name: 'state' }) }, 'propustka-state'],
			['prod-vozka', 'R2 bucket `run-logs`', { FILES: new R2Bucket({ name: 'run-logs' }) }, 'vozka-run-logs'],
		]
		for (const [env, described, bindings, platform] of split) {
			const authored = config({
				resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main: 'src/index.ts' }),
			})
			await expect(deploy(rec, authored, { env })).rejects.toThrow(`${described} becomes \`${env}-`)
			await expect(deploy(rec, authored, { env })).rejects.toThrow(`would take over the Fabrika platform resource \`${platform}\``)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('serves an assets directory the app keeps inside its own worker directory', async () => {
		for (const directory of ['public', 'dist/client', './public']) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory } }) })
			await expect(deploy(rec, authored)).resolves.toMatchObject({ status: 'succeeded' })
		}
	})

	test('refuses an assets directory that reaches outside the worker directory or into `.git`', async () => {
		for (const directory of ['..', '../..', '/etc', '.', '', 'public/../..', '.git', 'dist/.git/x']) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory } }) })
			await expect(deploy(rec, authored)).rejects.toThrow(
				`Worker \`stage-demo\` sets \`assets.directory\` to \`${directory}\`; it must be a relative path strictly inside the worker directory`,
			)
		}
		await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS' } }) }))).rejects.toThrow(
			'sets `assets.directory` to `(not a string)`',
		)
		for (const assets of ['public', ['public'], null]) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets }) })
			await expect(deploy(rec, authored)).rejects.toThrow('Worker `stage-demo` sets `assets` to something that is not an object')
		}
		const unknownKey = config({ resources: () => withRawOptions(appWorker(), { assets: { directory: 'public', bucket: '../..' } }) })
		await expect(deploy(rec, unknownKey)).rejects.toThrow('Worker `stage-demo` sets `assets.bucket`, which an app may not configure')
		expect(rec.provisions).toHaveLength(0)
	})

	test('deploys an assets directory that holds only regular files and directories', async () => {
		const checkoutDir = await assetsCheckout(async (assets) => {
			await mkdir(join(assets, 'nested'))
			await writeFile(join(assets, 'index.html'), '<!doctype html>')
			await writeFile(join(assets, 'nested', 'app.js'), 'export {}')
		})
		await deploy(rec, assetsApp(), { checkoutDir })
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([['wrangler', 'deploy']])
	})

	test('refuses the deploy when the assets directory holds a symbolic link, wherever it sits', async () => {
		const cases: ReadonlyArray<readonly [string, (assets: string) => Promise<void>]> = [
			['leak.txt', async (assets) => await symlink('../secret.txt', join(assets, 'leak.txt'))],
			['etc', async (assets) => await symlink('/etc', join(assets, 'etc'))],
			[
				'a/b/c',
				async (assets) => {
					await mkdir(join(assets, 'a', 'b'), { recursive: true })
					await writeFile(join(assets, 'a', 'b', 'ok.txt'), 'fine')
					await symlink('/proc/self/environ', join(assets, 'a', 'b', 'c'))
				},
			],
		]
		for (const [path, build] of cases) {
			const checkoutDir = await assetsCheckout(build)
			const result = await deploy(rec, assetsApp(), { checkoutDir })
			expect(stepError(result, 'deploy-worker')).toContain(
				`Worker \`stage-demo\` assets directory \`public\` contains \`${path}\`, which is a symbolic link; wrangler follows it and would publish its target`,
			)
		}
		expect(rec.commands).toHaveLength(0)
	})

	test('refuses the deploy when the assets directory is itself a symbolic link', async () => {
		const checkoutDir = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
		fixtures.push(checkoutDir)
		await symlink('/etc', join(checkoutDir, 'public'))
		const result = await deploy(rec, assetsApp(), { checkoutDir })
		expect(stepError(result, 'deploy-worker')).toContain(
			'Worker `stage-demo` assets directory `public` is a symbolic link; wrangler follows it and would publish its target',
		)
		expect(rec.commands).toHaveLength(0)
	})

	test('refuses a symbolic link the checkout plants in its own build step, after `open` has returned', async () => {
		const checkoutDir = await assetsCheckout(async () => {})
		const authored = config({
			resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory: 'public' } }),
			pipeline: { build: 'ln -s /proc/self/environ public/x' },
		})
		const result = await deploy(rec, authored, {
			checkoutDir,
			commandResult: (spec) => {
				if (spec.command === 'sh') symlinkSync('/proc/self/environ', join(checkoutDir, 'public', 'x'))
				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})
		expect(stepError(result, 'deploy-worker')).toContain('Worker `stage-demo` assets directory `public` contains `x`, which is a symbolic link')
		expect(rec.commands.map((command) => command.command)).toEqual(['sh'])
	})

	test('walks no assets directory when fabrika is deploying its own components', async () => {
		const checkoutDir = await assetsCheckout(async (assets) => {
			await symlink('../secret.txt', join(assets, 'leak.txt'))
		})
		await deploy(rec, assetsApp(), { checkoutDir, platformResources: 'allow' })
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([['wrangler', 'deploy']])
	})

	test('leaves a hyphenated environment that lands on no platform resource alone', async () => {
		const authored = config({
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'notes',
					compatibility_flags: [],
					bindings: { DB: new D1Database({ name: 'notes' }), FILES: new R2Bucket({ name: 'notes-uploads' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, authored, { env: 'prod-eu', domain: 'notes.example.com' })).resolves.toMatchObject({ status: 'succeeded' })
	})
})

const CONTRACT_SCHEMA = { scopes: [], actions: [], roles: {}, contract: true }

/** The Worker the deploy provisioned, and the application Worker behind its `APP` binding. */
const provisioned = (): { readonly root: Worker; readonly app: Worker } => {
	const root = rec.provisions[0]?.definition
	if (!(root instanceof Worker)) throw new Error('nothing was provisioned')
	const app = root.options.bindings?.['APP']
	if (!(app instanceof Worker)) throw new Error('the provisioned root binds no application Worker')
	return { root, app }
}

describe('a contract application on Cloudflare (ADR-0048)', () => {
	test('the platform builds the proxy Worker from the contract around the application Worker the config returns', async () => {
		const result = await deploy(rec, config({ schema: CONTRACT_SCHEMA }), {
			checkoutContract: notesArtifact,
			managedEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam.example.test' },
		})
		expect(result.status).toBe('succeeded')
		const { root, app } = provisioned()
		expect(root.options).toMatchObject({
			name: 'demo-proxy',
			main: './proxy-worker.ts',
			routes: [{ pattern: 'stage.example.com', custom_domain: true }],
		})
		// The proxy code is the platform's own copy, never the one a checkout installs into its `node_modules`.
		expect(root.options.dir).not.toContain('node_modules')
		expect(root.options.vars?.['FABRIKA_IAM_ISSUER']).toBe('https://iam.example.test')
		const manifest = root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toEqual([
			{ id: 'demo@stage', hosts: ['stage.example.com'], upstream: 'APP', scheme: 'https', ...contractProxyTable(notesArtifact) },
		])
		expect(app.options.name).toBe('demo')
		expect(app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(contractDigest(notesArtifact))
	})

	test('a config that builds its own proxy Worker is refused, with gates or with the endpoint table', async () => {
		const ownProxy = (protection: { readonly gates: typeof GATES } | { readonly endpoints: ReturnType<typeof contractProxyTable> }): Worker =>
			createCloudflareProxyWorker({
				name: 'demo-proxy',
				app: appWorker(),
				appId: 'demo@stage',
				appHost: 'stage.example.com',
				domain: 'stage.example.com',
				...protection,
			})
		for (const authored of [ownProxy({ gates: GATES }), ownProxy({ endpoints: contractProxyTable(notesArtifact) })]) {
			await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA, resources: () => authored }), { checkoutContract: notesArtifact })).rejects.toThrow(
				'`resources` returns the Worker `demo-proxy` binding `APP`, a proxy of its own',
			)
		}
		const named = config({
			schema: CONTRACT_SCHEMA,
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo-proxy', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, named, { checkoutContract: notesArtifact })).rejects.toThrow('takes the name of the proxy Worker the platform builds')
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA, gates: GATES }), { checkoutContract: notesArtifact })).rejects.toThrow(
			'a contract application is protected by its endpoint table; remove `gates`',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('the application Worker behind the platform proxy is still refused a route, workers.dev or preview URLs', async () => {
		const exposed = config({
			schema: CONTRACT_SCHEMA,
			resources: () => new Worker({ dir: '.', workers_dev: false, name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, exposed, { checkoutContract: notesArtifact })).rejects.toThrow('application Worker `stage-demo` leaves `preview_urls` on')
		expect(rec.provisions).toHaveLength(0)
	})

	test('the lock-down follows the contract: an IAM schema that disagrees with it is refused', async () => {
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA }))).rejects.toThrow(
			'the IAM schema says `contract: true`, but the checkout has no `fabrika.contract.ts`',
		)
		const loose = { scopes: [], actions: [], roles: {} }
		for (const schema of [loose, undefined]) {
			await expect(deploy(rec, config(schema === undefined ? {} : { schema }), { checkoutContract: notesArtifact })).rejects.toThrow(
				'this deployment serves a contract, so its IAM schema is `schemaFromContract(artifact)`',
			)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('the contract digest is the platform’s: an authored one is refused, a different one sent with the run too', async () => {
		const authored = config({
			schema: CONTRACT_SCHEMA,
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					vars: { FABRIKA_CONTRACT_DIGEST: 'x' },
				}),
		})
		await expect(deploy(rec, authored, { checkoutContract: notesArtifact })).rejects.toThrow(
			'application variable `FABRIKA_CONTRACT_DIGEST` is managed by Fabrika',
		)
		await expect(
			deploy(rec, config({ schema: CONTRACT_SCHEMA }), { checkoutContract: notesArtifact, managedEnvironment: { FABRIKA_CONTRACT_DIGEST: 'other' } }),
		).rejects.toThrow('FABRIKA_CONTRACT_DIGEST is `other`, but the contract this deployment serves has digest')
		expect(rec.provisions).toHaveLength(0)
	})

	test("the run's snapshot, when Control sends one, is the contract the proxy serves", async () => {
		const unreadable: CloudflareCollaborators = {
			...makeCollaborators(rec, config({ schema: CONTRACT_SCHEMA })),
			readContract: () => Promise.reject(new Error('the checkout is not read when the run carries its snapshot')),
		}
		const result = await createCloudflareDeployer({ accountId: 'acc-1', apiToken: 'tok-1', collaborators: unreadable })({
			appId: 'demo',
			env: 'stage',
			domain: 'stage.example.com',
			cwd: '/repo',
			configPath: 'fabrika.config.ts',
			secrets: {},
			vars: {},
			managedEnvironment: {},
			contract: notesArtifact,
			dryRun: true,
			signal: new AbortController().signal,
			log: () => {},
		})
		expect(result.status).toBe('succeeded')
		expect(provisioned().app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(contractDigest(notesArtifact))
	})

	test('what the checkout reads as cannot change the proxy table or the digest Control approved (ADR-0050)', async () => {
		// Control classified the run `unchanged` against the approved contract; the checkout and its config moved on.
		const widened: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.slice(0, 1) }
		const result = await deploy(rec, config({ schema: CONTRACT_SCHEMA }), { checkoutContract: widened, contract: notesArtifact })
		expect(result.status).toBe('succeeded')
		const { root, app } = provisioned()
		const manifest = root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toEqual([
			{ id: 'demo@stage', hosts: ['stage.example.com'], upstream: 'APP', scheme: 'https', ...contractProxyTable(notesArtifact) },
		])
		expect(app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(contractDigest(notesArtifact))
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA, gates: GATES }), { contract: notesArtifact })).rejects.toThrow(
			'a contract application is protected by its endpoint table; remove `gates`',
		)
	})

	test("a contract proxy admits the origin of the application's Operations DSN in its policy, never the key", async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, config({ schema: CONTRACT_SCHEMA }), { contract: notesArtifact, managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })
		const manifest = provisioned().root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
		const [app] = parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps ?? []
		expect(app !== undefined && isContractProxyApp(app) ? app.operationsOrigin : null).toBe('https://errors.test')
		expect(typeof manifest === 'string' ? manifest : '').not.toContain('operations-public-key')
		await expect(
			deploy(rec, config({ schema: CONTRACT_SCHEMA }), {
				contract: notesArtifact,
				managedEnvironment: { FABRIKA_OPERATIONS_DSN: 'ftp://errors.test/1' },
			}),
		).rejects.toThrow('FABRIKA_OPERATIONS_DSN is not an http(s) URL with a literal host')
	})

	test('a binding cannot overwrite, drop or add a framework variable in the generated config', async () => {
		const widened: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.slice(0, 1) }
		type Vars = NonNullable<Parameters<Bindable['configureBinding']>[0]['config']['vars']>
		const rewriting = (vars: (current: Vars) => Vars): Bindable => ({
			configureBinding: ({ config }) => ({ ...config, vars: vars({ ...(config.vars ?? {}) }) }),
		})
		const cases = [
			rewriting((vars) => ({ ...vars, FABRIKA_CONTRACT_DIGEST: contractDigest(widened) })),
			rewriting(({ FABRIKA_CONTRACT_DIGEST: _dropped, ...vars }) => vars),
			rewriting((vars) => ({ ...vars, FABRIKA_RELEASE: 'r-forged' })),
		]
		for (const binding of cases) {
			const app = config({ schema: CONTRACT_SCHEMA, resources: () => bindingIam(binding) })
			await expect(deploy(rec, app, { checkoutContract: notesArtifact, contract: notesArtifact })).rejects.toThrow(
				'sets `FABRIKA_',
			)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('a checkout with a contract Control did not read is refused when Control says the application has none', async () => {
		await expect(deploy(rec, config({ gates: GATES }), { checkoutContract: notesArtifact, contract: null })).rejects.toThrow(
			'the checkout has a `fabrika.contract.ts`, but the commit Control read has none',
		)
		expect(rec.provisions).toHaveLength(0)
		await expect(deploy(rec, config({ gates: GATES }), { contract: null })).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('a first deploy to a protected environment stops before provisioning and reports the gates and schema', async () => {
		const schema = { scopes: [], actions: [{ action: 'notes.read' }], roles: {} }
		const app = config({ gates: GATES, schema })
		await expect(deploy(rec, app, { contract: null, artifactApproval: { digest: null, protected: true } })).rejects.toThrow(
			"the config's gates and IAM schema are not the access Control approved",
		)
		expect(rec.provisions).toHaveLength(0)
		expect(rec.commands).toHaveLength(0)
		expect(rec.outcomes).toEqual([{ artifactAccess: { state: 'pending', accessJson: JSON.stringify({ gates: GATES, schema }) } }])
	})

	test('the approved gates and schema deploy and are reported; an unprotected change deploys too', async () => {
		const schema = { scopes: [], actions: [{ action: 'notes.read' }], roles: {} }
		const app = config({ gates: GATES, schema })
		const digest = artifactAccessDigest({ gates: GATES, schema })
		const deployedReport: RunnerOutcomeFile = { artifactAccess: { state: 'deployed', accessJson: JSON.stringify({ gates: GATES, schema }) } }
		expect(await deploy(rec, app, { contract: null, artifactApproval: { digest, protected: true } })).toMatchObject({ status: 'succeeded' })
		// Control applies the reported schema; the reconcile-schema step reports nothing of its own.
		expect(rec.outcomes).toEqual([deployedReport])
		rec.outcomes.length = 0
		expect(await deploy(rec, app, { contract: null, artifactApproval: { digest: null, protected: false } })).toMatchObject({ status: 'succeeded' })
		expect(rec.outcomes).toEqual([deployedReport])
	})

	test('an application without a contract hands its gates to the proxy the platform builds', async () => {
		await expect(deploy(rec, config({ gates: GATES }))).resolves.toMatchObject({ status: 'succeeded' })
		const { root, app } = provisioned()
		expect(root.options).toMatchObject({ name: 'demo-proxy', dir: CLOUDFLARE_PROXY_WORKER_DIR, main: './proxy-worker.ts' })
		expect(app.options.name).toBe('demo')
		const manifest = root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toEqual([
			{ id: 'demo@stage', hosts: ['stage.example.com'], upstream: 'APP', scheme: 'https', gates: GATES },
		])
		const malformed = config({ gates: { rules: [{ path: 'no-slash', kind: 'public' }] } })
		await expect(deploy(rec, malformed)).rejects.toThrow("the config's `gates` or IAM `schema` are malformed")
	})

	test('the proxy, the report and IAM come from the access read before `resources()` runs, whatever it changes', async () => {
		const rules: GateRule[] = [{ path: '/*', kind: 'human' }]
		const actions: AppActionDef[] = [{ action: 'notes.read' }]
		const schema = { scopes: [], actions, roles: {} }
		const approved = {
			gates: { rules: [{ path: '/*', kind: 'human' as const }] },
			schema: { scopes: [], actions: [{ action: 'notes.read' }], roles: {} },
		}
		const app = config({
			gates: { rules },
			schema,
			resources: () => {
				rules[0] = { path: '/*', kind: 'public' }
				actions.push({ action: 'notes.delete' })
				return appWorker()
			},
		})
		const run = { contract: null, artifactApproval: { digest: artifactAccessDigest(approved), protected: true } }
		await expect(deploy(rec, app, run)).resolves.toMatchObject({ status: 'succeeded' })
		const manifest = provisioned().root.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toMatchObject([{ id: 'demo@stage', gates: approved.gates }])
		expect(rec.outcomes).toEqual([{ artifactAccess: { state: 'deployed', accessJson: JSON.stringify(approved) } }])
	})
})

describe("another application's names (ADR-0048)", () => {
	const installationApps: readonly AppEnvironment[] = [
		{ app: 'demo', env: 'prod' },
		{ app: 'otherapp', env: 'prod' },
		{ app: 'otherapp', env: 'stage' },
		{ app: 'notes', env: 'prod' },
	]
	const binding = (bindings: Worker['options']['bindings'], name = 'demo'): CloudflareAppConfig =>
		config({ resources: () => new Worker({ dir: '.', ...PRIVATE, name, compatibility_flags: [], bindings, main: 'src/index.ts' }) })

	test('a binding to `prod-otherapp` is refused, as a service or as a resource of another kind', async () => {
		await expect(deploy(rec, binding({ OTHER: new ServiceReference('otherapp') }), { env: 'prod', installationApps })).rejects.toThrow(
			'Worker `prod-demo` binds service `prod-otherapp`, a name of application `otherapp` (environment `prod`); an application binds only its own resources',
		)
		const resources: ReadonlyArray<readonly [string, Worker['options']['bindings']]> = [
			['D1 database `otherapp-db`', { DB: new D1Database({ name: 'otherapp-db' }) }],
			['KV namespace `otherapp-cache`', { CACHE: new KVNamespace({ name: 'otherapp-cache' }) }],
			['R2 bucket `otherapp-files`', { FILES: new R2Bucket({ name: 'otherapp-files' }) }],
			['queue `otherapp-jobs`', { JOBS: new Queue({ name: 'otherapp-jobs' }) }],
		]
		for (const [described, bindings] of resources) {
			await expect(deploy(rec, binding(bindings), { env: 'prod', installationApps })).rejects.toThrow(`${described} becomes \`prod-otherapp-`)
		}
		await expect(deploy(rec, binding({}, 'otherapp-worker'), { env: 'stage', installationApps })).rejects.toThrow(
			'Worker `otherapp-worker` becomes `stage-otherapp-worker`, a name of application `otherapp` (environment `stage`)',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test("another application's name is refused whatever binding writes it into the generated config", async () => {
		const probes: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[
				{ r2_buckets: [{ binding: 'FILES', bucket_name: 'prod-otherapp-files' }] },
				'binds R2 bucket `prod-otherapp-files`, a name of application `otherapp`',
			],
			[
				{ d1_databases: [{ binding: 'DB', database_name: 'prod-otherapp-db', database_id: 'x' }] },
				'binds D1 database `prod-otherapp-db`, a name of application `otherapp`',
			],
			[{ queues: { consumers: [{ queue: 'prod-otherapp-jobs' }] } }, 'binds queue `prod-otherapp-jobs`, a name of application `otherapp`'],
			[{ services: [{ binding: 'OTHER', service: 'prod-otherapp-api' }] }, 'binds service `prod-otherapp-api`, a name of application `otherapp`'],
			[
				{ durable_objects: { bindings: [{ name: 'DO', class_name: 'Room', script_name: 'prod-otherapp' }] } },
				'binds the Durable Object script `prod-otherapp`, a name of application `otherapp`',
			],
		]
		for (const [extra, message] of probes) {
			await expect(deploy(rec, config({ gates: GATES, resources: () => bindingIam(emitting(extra)) }), { env: 'prod', installationApps })).rejects
				.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('an environment name cannot split another application’s prefix', async () => {
		await expect(deploy(rec, binding({}, 'worker'), { env: 'prod-otherapp', installationApps })).rejects.toThrow(
			'Worker `worker` becomes `prod-otherapp-worker`, a name of application `otherapp`',
		)
	})

	test('the service bindings a Worker emits are checked against the registry too, before each wrangler deploy', async () => {
		class InnocentReference extends ServiceReference {
			override configureBinding(args: Parameters<ServiceReference['configureBinding']>[0]) {
				return { ...args.config, services: [{ binding: args.binding, service: `${args.env}-otherapp` }] }
			}
		}
		await expect(deploy(rec, binding({ HELPER: new InnocentReference('demo-helper') }), { env: 'prod', installationApps })).rejects.toThrow(
			'Worker `prod-demo` binds service `prod-otherapp`, a name of application `otherapp`',
		)
		const result = await deploy(rec, binding({}), {
			env: 'prod',
			installationApps,
			generatedServices: [{ binding: 'OTHER', service: 'prod-otherapp' }],
		})
		expect(result.status).toBe('failed')
		expect(stepError(result, 'deploy-worker')).toContain('binds service `prod-otherapp`, a name of application `otherapp`')
		expect(rec.commands.some((command) => command.command === 'wrangler' && command.args[0] === 'deploy')).toBe(false)
	})

	test('an application keeps its own names, including those under a shorter application id', async () => {
		const own = binding({ DB: new D1Database({ name: 'demo-db' }), OTHER_ENV: new ServiceReference('demo') })
		await expect(deploy(rec, own, { env: 'prod', installationApps })).resolves.toMatchObject({ status: 'succeeded' })
		const admin = config({
			id: 'notes-admin',
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'notes-admin', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, admin, { appId: 'notes-admin', env: 'prod', installationApps })).resolves.toMatchObject({ status: 'succeeded' })
		// …and `notes` cannot take `notes-admin`'s.
		const registry = [...installationApps, { app: 'notes-admin', env: 'prod' }]
		const notes = config({
			id: 'notes',
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'notes-admin-api', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, notes, { appId: 'notes', env: 'prod', installationApps: registry })).rejects.toThrow(
			'a name of application `notes-admin` (environment `prod`)',
		)
	})

	test('a platform component is not bound by the registry', async () => {
		await expect(deploy(rec, binding({ OTHER: new ServiceReference('otherapp') }), { env: 'prod', installationApps, platformResources: 'allow' }))
			.resolves.toMatchObject({ status: 'succeeded' })
	})
})
