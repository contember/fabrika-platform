import { schemaFromContract } from '@fabrika/app/contract'
import { type AppActionDef, type AppEnvironment, type ContractArtifact, contractDigest, parseManagedEnvironment } from '@fabrika/auth-core'
import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { contractProxyTable, isApplicationEntry, OPS_ROW_MAX_BYTES, opsProxyRow, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { D1Database, DurableObject, type GeneratedConfig, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
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
import type { PlatformIamTarget } from '../provider'
import { CLOUDFLARE_PROXY_WORKER_DIR, PROXY_MANIFEST_DEFINE, proxyManifestJson } from '../proxy'
import type { RunnerOutcomeFile } from '../runner-protocol'

/** Link the application's CLI where the checkout's `bun install` would, under `dir`. */
const withApplicationCli = async (dir: string): Promise<string> => {
	const cli = join(dir, 'node_modules', '.bin', 'fabrika')
	await mkdir(dirname(cli), { recursive: true })
	await writeFile(cli, '')
	return cli
}

/** The build directories of `notesArtifact`'s SPA and link mounts, as the checkout's build writes them. */
const withBuiltMounts = async (dir: string): Promise<void> => {
	for (const mount of ['dist/app', 'dist/share']) {
		await mkdir(join(dir, mount), { recursive: true })
		await writeFile(join(dir, mount, 'index.html'), `<!doctype html><title>${mount}</title>`)
	}
}

/** The checkout on disk the runner installed: the entry build looks for the application's CLI in it. */
const REPO = await mkdtemp(join(tmpdir(), 'fabrika-checkout-'))
await withApplicationCli(join(REPO, 'app'))
await withBuiltMounts(join(REPO, 'app'))

afterAll(async () => {
	await rm(REPO, { recursive: true, force: true })
})

interface Recorded {
	readonly commands: CommandSpec[]
	readonly provisions: ProvisionInput[]
	readonly outcomes: RunnerOutcomeFile[]
	readonly reconciled: SchemaReconcileInput[]
	readonly logs: string[]
	readonly provisionedVars: Array<Record<string, unknown> | undefined>
	readonly applicationVars: Array<Record<string, unknown> | undefined>
}

const config = (overrides: Partial<CloudflareAppConfigInput> = {}): CloudflareAppConfig =>
	defineApp({
		id: 'demo',
		resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: {}, main: ENTRY }),
		...overrides,
	})

/** The entry `fabrika app build` generates: from framework 0.9 an application Worker runs exactly this one. */
const ENTRY = 'fabrika/entry.generated.ts'

/** An application Worker is reachable only through its proxy, so every fixture app turns both URLs off. */
const PRIVATE: { readonly workers_dev: false; readonly preview_urls: false } = { workers_dev: false, preview_urls: false }

const appWorker = (): Worker => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: {}, main: ENTRY })

const bindingIam = (iam: Bindable): Worker =>
	new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: { IAM: iam }, main: ENTRY })

/** What a config written before the gates were removed still declares. */
const GATES = { rules: [{ path: '/*', kind: 'public' }] }

/** Where a checkout's own `bun install` puts this package: proxy code from here is the checkout's, never the platform's. */
const INSTALLED_PROXY_DIR = '/repo/node_modules/@fabrika/provider-cloudflare/src'

/** A binding that writes whatever it likes into the generated config: oblaka calls `configureBinding` on any object. */
const emitting = (extra: Record<string, unknown>): Bindable => ({ configureBinding: ({ config }) => ({ ...config, ...extra }) })

/** A checkout is plain JavaScript: its options object carries whatever raw wrangler keys it likes. */
const withRawOptions = (worker: Worker, raw: Record<string, unknown>): Worker => {
	Object.assign(worker.options, raw)
	return worker
}

type GeneratedService = { binding: string; service: string; entrypoint?: string; props?: Record<string, unknown> }

/** Any object oblaka calls `configureBinding` on: a checkout can hand it one of its own. */
type Bindable = Pick<ServiceReference, 'configureBinding'>

/** Every command succeeds; the application Worker holds no secret yet, so `wrangler secret list` prints an empty list. */
const succeeded = (spec: CommandSpec): CommandResult => ({ exitCode: 0, stdout: isSecretList(spec) ? '[]' : '', stderr: '' })

const isSecretList = (spec: CommandSpec): boolean => spec.args[0] === 'secret' && spec.args[1] === 'list'

/** The command the deploy runs after the application Worker's `wrangler deploy`, to find the managed secrets it no longer writes. */
const SECRET_LIST = ['wrangler', 'secret', 'list', '--format', 'json']

const makeCollaborators = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	commandResult: (spec: CommandSpec) => CommandResult = succeeded,
	checkoutDir = `${REPO}/app`,
	runCommand?: CommandRunner,
	generatedServices?: GeneratedService[],
	checkoutContract: ContractArtifact | null = null,
	expectedConfigPath = 'fabrika.config.ts',
): CloudflareCollaborators => ({
	loadConfig: async (_cwd, configPath) => {
		expect(configPath).toBe(expectedConfigPath)
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
		readonly crossOrigins?: readonly string[]
		readonly operationsOrigin?: string
		/** `stage.example.com` by default; `null` deploys an environment without a domain. */
		readonly domain?: string | null
		readonly platformResources?: 'refuse' | 'allow'
		readonly stateNamespace?: string
		readonly env?: string
		readonly checkoutDir?: string
		/** Where the runner installed the checkout: the parent of `checkoutDir` by default. */
		readonly cwd?: string
		readonly configPath?: string
		readonly generatedServices?: GeneratedService[]
		/** What `fabrika.contract.ts` in the checkout reads as; none by default. */
		readonly checkoutContract?: ContractArtifact
		/**
		 * The contract Control approved for the run. An application gets `notesArtifact` by default, and a config without
		 * a schema gets its `schemaFromContract`; a platform component (`allow`) gets none.
		 */
		readonly contract?: ContractArtifact
		/** The digest Control sends with `contract`: the application's own release's; `contractDigest(contract)` by default. */
		readonly contractDigest?: string
		/** The application's framework release Control names with `contract`: `0.9.0` by default, `null` for none. */
		readonly framework?: string | null
		readonly installationApps?: readonly AppEnvironment[]
		readonly platformIam?: PlatformIamTarget
	} = {},
) => {
	const contract = options.contract ?? (options.platformResources === 'allow' || options.checkoutContract !== undefined ? undefined : notesArtifact)
	const served = contract === undefined || appConfig.schema !== undefined ? appConfig : { ...appConfig, schema: schemaFromContract(contract) }
	return createCloudflareDeployer({
		accountId: 'acc-1',
		apiToken: 'tok-1',
		collaborators: makeCollaborators(
			rec,
			served,
			options.commandResult,
			options.checkoutDir,
			options.runCommand,
			options.generatedServices,
			options.checkoutContract,
			options.configPath,
		),
		...(options.platformResources === undefined ? {} : { platformResources: options.platformResources }),
		...(options.platformIam === undefined ? {} : { platformIam: options.platformIam }),
		reconcileSchema: async (input) => {
			rec.reconciled.push(input)
		},
	})({
		appId: options.appId ?? 'demo',
		env: options.env ?? 'stage',
		...(options.domain === null ? {} : { domain: options.domain ?? 'stage.example.com' }),
		...(options.returnOrigins === undefined ? {} : { returnOrigins: options.returnOrigins }),
		...(options.crossOrigins === undefined ? {} : { crossOrigins: options.crossOrigins }),
		...(options.operationsOrigin === undefined ? {} : { operationsOrigin: options.operationsOrigin }),
		cwd: options.cwd ?? dirname(options.checkoutDir ?? `${REPO}/app`),
		configPath: options.configPath ?? 'fabrika.config.ts',
		...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		secrets: options.secrets ?? {},
		vars: {},
		managedEnvironment: parseManagedEnvironment(options.managedEnvironment ?? {}),
		...(contract === undefined
			? {}
			: {
				approved: {
					kind: 'contract' as const,
					contract,
					contractDigest: options.contractDigest ?? contractDigest(contract),
					...(options.framework === null ? {} : { framework: options.framework ?? '0.9.0' }),
				},
			}),
		...(options.installationApps === undefined ? {} : { installationApps: options.installationApps }),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: (line) => {
			rec.logs.push(line)
		},
	})
}

const stepError = (result: Awaited<ReturnType<typeof deploy>>, id: string): string | undefined => result.steps.find((step) => step.id === id)?.error

const fixtures: string[] = []

/** A real checkout on disk: the symlink bound is about what wrangler would follow, not about a config value. */
const assetsCheckout = async (build: (assets: string) => Promise<void>): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
	fixtures.push(root)
	await withApplicationCli(root)
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
	rec = { commands: [], provisions: [], outcomes: [], reconciled: [], logs: [], provisionedVars: [], applicationVars: [] }
})

afterEach(async () => {
	for (const root of fixtures.splice(0)) {
		await rm(root, { recursive: true, force: true })
	}
})

describe('Cloudflare provider', () => {
	test('merges the public platform-managed values into the application Worker, and no credential, without exposing them in logs', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, config(), {
			dryRun: true,
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: dsn,
				FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit',
				FABRIKA_SERVICE_KEY: null,
			},
		})
		expect(rec.applicationVars[0]).toMatchObject({ FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit' })
		expect(rec.applicationVars[0]).not.toHaveProperty('FABRIKA_OPERATIONS_DSN')
		expect(rec.applicationVars[0]).not.toHaveProperty('FABRIKA_SERVICE_KEY')
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
					main: ENTRY,
					vars: { FABRIKA_OPERATIONS_DSN: 'authored' },
				}),
		})
		await expect(deploy(rec, authored, { managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })).rejects.toThrow(
			'application variable `FABRIKA_OPERATIONS_DSN` is managed by Fabrika',
		)
		expect(rec.logs.join('\n')).not.toContain(dsn)
	})

	test('targets platform-managed values at the private application Worker behind the platform proxy', async () => {
		const release = 'fabrika/demo/stage/default/commit'
		await deploy(rec, config(), { dryRun: true, managedEnvironment: { FABRIKA_RELEASE: release } })
		expect(rec.provisionedVars[0]).not.toHaveProperty('FABRIKA_RELEASE')
		expect(rec.applicationVars[0]).toMatchObject({ FABRIKA_RELEASE: release })
	})

	test('plans nested D1 migration and deploys every generated Worker config', async () => {
		const app = new Worker({
			dir: '.',
			...PRIVATE,
			name: 'demo',
			compatibility_flags: [],
			bindings: { DB: new D1Database({ name: 'main', migrationsDir: './migrations' }) },
			// The Worker's config is written in `worker/`, and the entry beside the application's config.
			main: `../${ENTRY}`,
		})
		const authored = config({ resources: () => app, pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] } })
		const result = await deploy(rec, authored, { secrets: { API_KEY: 'secret-value' } })
		expect(result.steps.map((step) => step.id)).toEqual([
			'build',
			'provision-resources',
			'migrate:APP.DB',
			'deploy-worker',
			'reconcile-schema',
			'sync-secrets',
		])
		expect(result.status).toBe('succeeded')
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			['sh', '-c', 'bun run build'],
			APP_BUILD,
			['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote'],
			['wrangler', 'deploy'],
			['wrangler', 'deploy'],
			SECRET_LIST,
			['wrangler', 'secret', 'put', 'API_KEY'],
		])
		expect(rec.commands[0]?.cwd).toBe(`${REPO}/app/worker`)
		expect(rec.commands[1]?.cwd).toBe(`${REPO}/app`)
		expect(rec.commands[2]?.cwd).toBe(`${REPO}/app/worker`)
		// The proxy is deployed from the platform's own copy of this package, the application from the checkout.
		expect(rec.commands[3]?.cwd).toBe(CLOUDFLARE_PROXY_WORKER_DIR)
		expect(rec.commands[4]?.cwd).toBe(`${REPO}/app/worker`)
		expect(rec.commands[5]?.cwd).toBe(`${REPO}/app/worker`)
		expect(rec.commands[6]?.cwd).toBe(`${REPO}/app/worker`)
	})

	test('loads the checkout config and preserves the canonical Cloudflare plan', async () => {
		const app = config({
			schema: { scopes: [], actions: [], roles: {}, contract: true },
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					...PRIVATE,
					name: 'demo',
					compatibility_flags: [],
					main: ENTRY,
					bindings: { DB: new D1Database({ name: 'main', migrationsDir: './migrations' }) },
				}),
		})
		const result = await deploy(rec, app, { secrets: { API_KEY: 'secret' } })

		expect(result.steps.map((step) => step.id)).toEqual([
			'build',
			'provision-resources',
			'migrate:APP.DB',
			'deploy-worker',
			'reconcile-schema',
			'sync-secrets',
		])
	})

	test('executes the plan through the provider collaborator bundle', async () => {
		const controller = new AbortController()
		const app = config({
			schema: { scopes: [], actions: [], roles: {}, contract: true },
			pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] },
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings: {}, main: `../${ENTRY}` }),
		})
		await deploy(rec, app, { secrets: { API_KEY: 'secret-value' }, signal: controller.signal })

		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.accountId).toBe('acc-1')
		expect(rec.provisions[0]?.apiToken).toBe('tok-1')
		expect(rec.provisions[0]?.cwd).toBe(`${REPO}/app/worker`)
		expect(rec.provisions[0]?.stateNamespace).toBe('demo-state')
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			['sh', '-c', 'bun run build'],
			APP_BUILD,
			['wrangler', 'deploy'],
			['wrangler', 'deploy'],
			SECRET_LIST,
			['wrangler', 'secret', 'put', 'API_KEY'],
		])
		expect(rec.commands[2]?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
		expect(rec.commands[5]?.stdin).toBe('secret-value')
		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: '{"scopes":[],"actions":[],"roles":{},"contract":true}' } }])
	})

	test('reports the authz schema for the control plane instead of calling IAM from the container', async () => {
		const schema = { scopes: [{ type: 'team' }], actions: [{ action: 'notes.read' }], roles: {}, contract: true }
		await deploy(rec, config({ schema }), { returnOrigins: ['https://demo.example.com'] })

		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: JSON.stringify(schema) } }])
		expect(rec.reconciled).toEqual([])
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			APP_BUILD,
			['wrangler', 'deploy'],
			['wrangler', 'deploy'],
			SECRET_LIST,
		])
	})

	test("a platform deploy registers its component's schema with IAM itself, with the provisioning key", async () => {
		const schema = { scopes: [], actions: [{ action: 'deploy.read' }], roles: {} }
		const result = await deploy(rec, config({ schema }), {
			platformResources: 'allow',
			platformIam: { url: 'https://iam.example.com', adminKey: 'px_provisioning' },
			returnOrigins: ['https://console.example.com'],
		})

		expect(result.status).toBe('succeeded')
		expect(rec.outcomes).toEqual([])
		expect(rec.reconciled.map(({ signal: _signal, ...input }) => input)).toEqual([
			{ url: 'https://iam.example.com', app: 'demo', schema, returnOrigins: ['https://console.example.com'], adminKey: 'px_provisioning' },
		])
	})

	test('a platform deploy without IAM coordinates fails its schema step naming them, and reports nothing', async () => {
		const result = await deploy(rec, config({ schema: { scopes: [], actions: [], roles: {} } }), { platformResources: 'allow' })

		expect(result.status).toBe('failed')
		expect(stepError(result, 'reconcile-schema')).toContain('FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY')
		expect(rec.outcomes).toEqual([])
		expect(rec.reconciled).toEqual([])
	})

	test('refuses to report an outcome once the run is cancelled', async () => {
		const controller = new AbortController()
		const result = await deploy(rec, config({ schema: { scopes: [], actions: [], roles: {}, contract: true } }), {
			signal: controller.signal,
			commandResult: (spec) => {
				if (spec.command === 'wrangler') controller.abort()
				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'failed', 'skipped'])
		expect(stepError(result, 'deploy-worker')).toBe('deploy cancelled')
		expect(rec.outcomes).toHaveLength(0)
	})

	test('dry-run keeps Oblaka in plan mode and skips every other mutation', async () => {
		const app = config({
			schema: { scopes: [], actions: [], roles: {}, contract: true },
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
		expect(result.steps.map((step) => step.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped'])
		expect(rec.logs).toContain('∅ build: deploy cancelled')
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
		expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped', 'skipped'])
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
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'failed', 'skipped', 'skipped'])
		expect(stepError(result, 'deploy-worker')).toBe('wrangler deploy failed (exit 1): deploy failed')
		expect(rec.logs).toContain('  • deploy-worker — Deploy the Worker (`wrangler deploy`)')
		expect(rec.logs).toContain('✗ deploy-worker: wrangler deploy failed (exit 1): deploy failed')
		expect(rec.commands.map((command) => command.args[0])).toEqual(['app', 'deploy'])
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
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'vozka', compatibility_flags: [], bindings: {}, main: ENTRY }),
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
					main: ENTRY,
				}),
		})
		await expect(deploy(rec, platformBucket)).rejects.toThrow(
			'R2 bucket `vozka-run-logs` becomes `stage-vozka-run-logs`, which would take over the Fabrika platform resource `vozka-run-logs`',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('lets fabrika deploy its own components under the explicit platform policy', async () => {
		const platformWorker = config({
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'vozka', compatibility_flags: [], bindings: {}, main: ENTRY }),
		})
		const result = await deploy(rec, platformWorker, { platformResources: 'allow' })
		expect(result.steps[0]?.id).toBe('provision-resources')
		expect(result.status).toBe('succeeded')
	})

	test("only the platform proxy is routed, on this environment's own domain", async () => {
		const foreign = [{ pattern: 'other-app.example.com/*', zone_name: 'example.com' }]
		const routed = config({ resources: () => bindingIam(emitting({ routes: foreign })) })
		await expect(deploy(rec, routed)).rejects.toThrow('application Worker `stage-demo` declares `routes`; only its proxy Worker is routed')
		expect(rec.provisions).toHaveLength(0)

		await expect(deploy(rec, config())).resolves.toMatchObject({ status: 'succeeded' })
		const { root } = provisioned()
		expect(root.options.routes).toEqual([{ pattern: 'stage.example.com', custom_domain: true }])
	})

	test('refuses a route, workers.dev or preview URLs on an application Worker behind its proxy', async () => {
		const ownRoute = [{ pattern: 'stage.example.com', custom_domain: true }]
		const exposed: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ routes: ownRoute }, 'cloudflare proxy app `demo` must not declare public routes'],
			[{ routes: 'stage.example.com' }, 'must not declare public routes'],
			[{ workers_dev: true }, 'cloudflare proxy app `demo` must disable workers.dev'],
			[{ workers_dev: undefined }, 'must disable workers.dev'],
			[{ preview_urls: true }, 'application Worker `stage-demo` leaves `preview_urls` on'],
			[{ preview_urls: undefined }, 'application Worker `stage-demo` leaves `preview_urls` on'],
		]
		for (const [raw, message] of exposed) {
			await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), raw) }))).rejects.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)

		await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), { routes: [] }) }))).resolves.toMatchObject({
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
			await expect(deploy(rec, config({ resources: () => bindingIam(emitting(extra)) }))).rejects.toThrow(message)
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
			endpoints: contractProxyTable(notesArtifact),
		})
		const impostors = [
			publicRoot('.', 'src/app.ts'),
			publicRoot('.', './proxy-worker.ts'),
			publicRoot(INSTALLED_PROXY_DIR, './proxy-worker.ts'),
			publicRoot(CLOUDFLARE_PROXY_WORKER_DIR, './proxy-worker.ts'),
			checkoutProxy,
		]
		for (const impostor of impostors) {
			await expect(deploy(rec, config({ resources: () => impostor }))).rejects.toThrow(
				'binding `APP`, a proxy of its own; return the application Worker, and the platform builds the proxy Worker from its contract',
			)
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
					main: ENTRY,
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
			main: ENTRY,
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
			generatedServices: [{ binding: 'IAM', service: 'stage-propustka-worker', entrypoint: 'PropustkaApplication', props: { app: 'demo@stage' } }],
		})
		expect(narrow.status).toBe('succeeded')
	})

	// IAM reads `props.app` as the calling application (ADR-0067 §3): an application must not name another, or none.
	test('refuses an IAM binding that does not name this deployment as its application', async () => {
		for (
			const props of [undefined, { app: 'other@stage' }, { app: 'demo@prod' }, { app: 'demo@stage', admin: true }]
		) {
			const result = await deploy(rec, config({ resources: () => bindingIam(iamServiceReference()) }), {
				generatedServices: [{
					binding: 'IAM',
					service: 'stage-propustka-worker',
					entrypoint: 'PropustkaApplication',
					...(props === undefined ? {} : { props }),
				}],
			})
			expect(result.status).toBe('failed')
			expect(stepError(result, 'deploy-worker')).toContain('binds IAM as `IAM` without naming its own application `demo@stage`')
		}
		const second: Bindable = {
			configureBinding: ({ config }) => ({
				...config,
				services: [...(config.services ?? []), {
					binding: 'IAM2',
					service: 'stage-propustka-worker',
					entrypoint: 'PropustkaApplication',
					props: { app: 'other@stage' },
				}],
			}),
		}
		await expect(deploy(rec, config({ resources: () => bindingIam(second) }))).rejects.toThrow('binds IAM as `IAM2` without naming its own application')
	})

	// `packages/iam/src/__tests__/index.test.ts` pins the same name as the narrow class IAM exports.
	test('an application and its platform-built proxy bind IAM at PropustkaApplication', async () => {
		expect(IAM_APPLICATION_ENTRYPOINT).toBe('PropustkaApplication')
		await expect(deploy(rec, config({ resources: () => bindingIam(iamServiceReference()) }))).resolves.toMatchObject({
			status: 'succeeded',
		})
		const { root, app } = provisioned()
		for (const worker of [app, root]) {
			const iam = worker.options.bindings?.['IAM']
			const services = iam !== undefined && 'configureBinding' in iam && !('getId' in iam)
				? iam.configureBinding({ config: {}, binding: 'IAM', env: 'stage' }).services
				: undefined
			expect(services).toEqual([{ binding: 'IAM', service: 'stage-propustka-worker', entrypoint: 'PropustkaApplication', props: { app: 'demo@stage' } }])
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
					main: ENTRY,
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
					main: ENTRY,
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
			await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), raw) }))).rejects.toThrow(message)
			await expect(deploy(rec, config({ resources: () => bindingIam(emitting(raw)) }))).rejects.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('a binding cannot bind a D1 database or KV namespace by a literal id', async () => {
		const probes: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ d1_databases: [{ binding: 'DB', database_name: 'stage-demo-db', database_id: '0000-other' }] }, 'binds a D1 database by an id'],
			[{ kv_namespaces: [{ binding: 'KV', id: 'another-namespace-id' }] }, 'binds a KV namespace by an id'],
		]
		for (const [extra, message] of probes) {
			await expect(deploy(rec, config({ resources: () => bindingIam(emitting(extra)) }))).rejects.toThrow(message)
		}
		expect(rec.provisions).toHaveLength(0)
		const declared = config({ resources: () => bindingIam(new KVNamespace({ name: 'demo-cache' })) })
		await expect(deploy(rec, declared)).resolves.toMatchObject({ status: 'succeeded' })
	})

	test("the platform-built proxy mints for this deployment's own `<app>@<env>`", async () => {
		for (const env of ['stage', 'prod']) {
			rec.provisions.length = 0
			await expect(deploy(rec, config(), { env })).resolves.toMatchObject({ status: 'succeeded' })
			const manifest = proxyManifestJson(provisioned().root)
			expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps.map((app) => app.id)).toEqual([`demo@${env}`])
		}
	})

	test('keeps the Worker options an application config legitimately sets', async () => {
		const app = new Worker({
			dir: '.',
			name: 'demo',
			main: ENTRY,
			compatibility_flags: ['nodejs_compat_v2'],
			compatibility_date: '2025-10-01',
			workers_dev: false,
			preview_urls: false,
			observability: { enabled: true },
			assets: { binding: 'ASSETS', directory: 'dist', not_found_handling: 'single-page-application' },
			vars: { ENVIRONMENT: 'stage' },
			routes: [],
			bindings: { DB: new D1Database({ name: 'notes' }) },
		})
		await expect(deploy(rec, config({ resources: () => app }))).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('bounds the name oblaka adopts, so an env name cannot split the platform prefix', async () => {
		const worker = config({
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'worker', compatibility_flags: [], bindings: {}, main: ENTRY }),
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
				resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main: ENTRY }),
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
		expect(rec.commands.map((command) => [command.command, ...command.args, command.cwd === CLOUDFLARE_PROXY_WORKER_DIR])).toEqual([
			[join(checkoutDir, 'node_modules', '.bin', 'fabrika'), ...APP_BUILD.slice(1), false],
			['wrangler', 'deploy', true],
			['wrangler', 'deploy', false],
			[...SECRET_LIST, false],
		])
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
		// The entry build runs before the walk; nothing of the application is deployed.
		expect(rec.commands.filter((command) => command.cwd !== CLOUDFLARE_PROXY_WORKER_DIR).map((command) => command.args[0])).toEqual([
			'app',
			'app',
			'app',
		])
	})

	test('refuses the deploy when the assets directory is itself a symbolic link', async () => {
		const checkoutDir = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
		fixtures.push(checkoutDir)
		await withApplicationCli(checkoutDir)
		await symlink('/etc', join(checkoutDir, 'public'))
		const result = await deploy(rec, assetsApp(), { checkoutDir })
		expect(stepError(result, 'deploy-worker')).toContain(
			'Worker `stage-demo` assets directory `public` is a symbolic link; wrangler follows it and would publish its target',
		)
		expect(rec.commands.filter((command) => command.cwd !== CLOUDFLARE_PROXY_WORKER_DIR).map((command) => command.args[0])).toEqual(['app'])
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
		expect(rec.commands.filter((command) => command.cwd !== CLOUDFLARE_PROXY_WORKER_DIR).map((command) => command.args[0])).toEqual(['-c', 'app'])
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
					main: ENTRY,
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
		const manifest = proxyManifestJson(root)
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toEqual([
			{ id: 'demo@stage', hosts: ['stage.example.com'], upstream: 'APP', scheme: 'https', ...contractProxyTable(notesArtifact) },
		])
		expect(app.options.name).toBe('demo')
		expect(app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(contractDigest(notesArtifact))
	})

	test('a config that builds its own proxy Worker is refused', async () => {
		const authored = createCloudflareProxyWorker({
			name: 'demo-proxy',
			app: appWorker(),
			appId: 'demo@stage',
			appHost: 'stage.example.com',
			domain: 'stage.example.com',
			endpoints: contractProxyTable(notesArtifact),
		})
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA, resources: () => authored }), { checkoutContract: notesArtifact })).rejects.toThrow(
			'`resources` returns the Worker `demo-proxy` binding `APP`, a proxy of its own',
		)
		const named = config({
			schema: CONTRACT_SCHEMA,
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo-proxy', compatibility_flags: [], bindings: {}, main: ENTRY }),
		})
		await expect(deploy(rec, named, { checkoutContract: notesArtifact })).rejects.toThrow('takes the name of the proxy Worker the platform builds')
		expect(rec.provisions).toHaveLength(0)
	})

	test('the application Worker behind the platform proxy is still refused a route, workers.dev or preview URLs', async () => {
		const exposed = config({
			schema: CONTRACT_SCHEMA,
			resources: () => new Worker({ dir: '.', workers_dev: false, name: 'demo', compatibility_flags: [], bindings: {}, main: ENTRY }),
		})
		await expect(deploy(rec, exposed, { checkoutContract: notesArtifact })).rejects.toThrow('application Worker `stage-demo` leaves `preview_urls` on')
		expect(rec.provisions).toHaveLength(0)
	})

	test('the lock-down follows the contract: an IAM schema that disagrees with it is refused', async () => {
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA }), { platformResources: 'allow' })).rejects.toThrow(
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
					main: ENTRY,
					vars: { FABRIKA_CONTRACT_DIGEST: 'x' },
				}),
		})
		await expect(deploy(rec, authored, { checkoutContract: notesArtifact })).rejects.toThrow(
			'application variable `FABRIKA_CONTRACT_DIGEST` is managed by Fabrika',
		)
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
			approved: { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact) },
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
		const manifest = proxyManifestJson(root)
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps).toEqual([
			{
				id: 'demo@stage',
				hosts: ['stage.example.com'],
				upstream: 'APP',
				scheme: 'https',
				...contractProxyTable(notesArtifact, undefined, { ops: true }),
			},
		])
		expect(app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(contractDigest(notesArtifact))
	})

	test("an application on an older framework release starts with its own release's digest, which no upcast contract recomputes", async () => {
		const older = `sha256:${'5'.repeat(64)}`
		const result = await deploy(rec, config({ schema: CONTRACT_SCHEMA }), { contract: notesArtifact, contractDigest: older })
		expect(result.status).toBe('succeeded')
		const { root, app } = provisioned()
		const manifest = proxyManifestJson(root)
		expect(parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps[0]).toMatchObject({ snapshot: older })
		expect(app.options.vars?.['FABRIKA_CONTRACT_DIGEST']).toBe(older)
	})

	test("a contract proxy admits the origin of the application's Operations DSN in its policy, never the key", async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, config({ schema: CONTRACT_SCHEMA }), { contract: notesArtifact, managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })
		const manifest = proxyManifestJson(provisioned().root)
		const [app] = parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps ?? []
		expect(app !== undefined && isApplicationEntry(app) ? app.operationsOrigin : null).toBe('https://errors.test')
		expect(typeof manifest === 'string' ? manifest : '').not.toContain('operations-public-key')
		await expect(
			deploy(rec, config({ schema: CONTRACT_SCHEMA }), {
				contract: notesArtifact,
				managedEnvironment: { FABRIKA_OPERATIONS_DSN: 'ftp://errors.test/1' },
			}),
		).rejects.toThrow('FABRIKA_OPERATIONS_DSN is not an http(s) URL with a literal host')
	})

	test('a contract proxy admits the Operations origin Control names over one derived from the DSN', async () => {
		const managedEnvironment = { FABRIKA_OPERATIONS_DSN: 'https://operations-public-key@errors.test/1' }
		await deploy(rec, config({ schema: CONTRACT_SCHEMA }), {
			contract: notesArtifact,
			managedEnvironment,
			operationsOrigin: 'https://ingest.example.com',
		})
		const manifest = proxyManifestJson(provisioned().root)
		const [app] = parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps ?? []
		expect(app !== undefined && isApplicationEntry(app) ? app.operationsOrigin : null).toBe('https://ingest.example.com')
		await expect(
			deploy(rec, config({ schema: CONTRACT_SCHEMA }), { contract: notesArtifact, operationsOrigin: 'https://ingest.example.com/1' }),
		).rejects.toThrow('proxy entry `demo@stage` is one the proxy manifest refuses (operationsOrigin)')
	})

	test("the platform's proxy entry lists the environment's cross origins, and none when it lists none", async () => {
		const entry = async (crossOrigins?: readonly string[]) => {
			rec.provisions.length = 0
			await deploy(rec, config({ schema: CONTRACT_SCHEMA }), { contract: notesArtifact, ...(crossOrigins === undefined ? {} : { crossOrigins }) })
			const manifest = proxyManifestJson(provisioned().root)
			const [app] = parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps ?? []
			return app !== undefined && isApplicationEntry(app) ? app : null
		}
		expect((await entry(['https://partner.example.org']))?.crossOrigins).toEqual(['https://partner.example.org'])
		expect(await entry()).not.toHaveProperty('crossOrigins')
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

	test('an application checkout without a contract is refused before anything runs; a platform component needs none', async () => {
		const missing = 'the checkout has no `fabrika.contract.ts`; Fabrika deploys an application only with a contract'
		const contractless = createCloudflareDeployer({ accountId: 'acc-1', apiToken: 'tok-1', collaborators: makeCollaborators(rec, config()) })
		const run = { appId: 'demo', env: 'stage', cwd: '/repo', configPath: 'fabrika.config.ts', secrets: {}, vars: {}, managedEnvironment: {} }
		for (const dryRun of [false, true]) {
			await expect(contractless({ ...run, dryRun, signal: new AbortController().signal, log: () => {} })).rejects.toThrow(missing)
		}
		expect(rec.provisions).toHaveLength(0)
		expect(rec.commands).toHaveLength(0)
		await expect(deploy(rec, config(), { platformResources: 'allow' })).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('a config that declares `gates` is refused, whatever else it declares', async () => {
		const gated = { ...config(), gates: GATES }
		await expect(deploy(rec, gated)).rejects.toThrow('the config declares `gates`, which no deployment reads any more')
		await expect(deploy(rec, gated, { platformResources: 'allow' })).rejects.toThrow('the config declares `gates`')
		expect(rec.provisions).toHaveLength(0)
	})

	test('the IAM schema is the one read before `resources()` runs, whatever it changes', async () => {
		const actions: AppActionDef[] = [{ action: 'notes.read' }]
		const app = config({
			schema: { scopes: [], actions, roles: {} },
			resources: () => {
				actions.push({ action: 'notes.delete' })
				return appWorker()
			},
		})
		const platformIam = { url: 'https://iam.example.com', adminKey: 'px_provisioning' }
		await expect(deploy(rec, app, { platformResources: 'allow', platformIam })).resolves.toMatchObject({ status: 'succeeded' })
		expect(rec.reconciled.map((input) => input.schema)).toEqual([{ scopes: [], actions: [{ action: 'notes.read' }], roles: {} }])
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
		config({ resources: () => new Worker({ dir: '.', ...PRIVATE, name, compatibility_flags: [], bindings, main: ENTRY }) })

	const connectorHanded = {
		FABRIKA_IAM_ISSUER: 'https://iam.example.test',
		FABRIKA_CONNECT_CATALOG_KEY: 'px_private-catalog-edge',
		FABRIKA_CONNECT_CATALOG_URL: 'https://catalog.example.com',
	}
	const owners: readonly AppEnvironment[] = [...installationApps, { app: 'catalog', env: 'prod' }]

	test("an import gets the platform's FABRIKA_CONNECT_<IMPORT> binding to the owner's proxy Worker, and only that (F4)", async () => {
		const result = await deploy(rec, config({ schema: CONTRACT_SCHEMA }), {
			env: 'prod',
			domain: 'notes.example.com',
			installationApps: owners,
			checkoutContract: notesArtifact,
			managedEnvironment: connectorHanded,
		})
		expect(result.status).toBe('succeeded')
		const { app } = provisioned()
		const reference = app.options.bindings?.['FABRIKA_CONNECT_CATALOG']
		expect(reference).toBeInstanceOf(ServiceReference)
		expect(reference?.configureBinding({ config: {}, binding: 'FABRIKA_CONNECT_CATALOG', env: 'prod' })).toEqual({
			services: [{ binding: 'FABRIKA_CONNECT_CATALOG', service: 'prod-catalog-proxy', entrypoint: undefined }],
		})
		expect(app.options.vars?.['FABRIKA_CONNECT_CATALOG_URL']).toBe('https://catalog.example.com')
		expect(rec.logs.join('\n')).not.toContain('private-catalog-edge')
	})

	test("an authored binding to the owner's proxy Worker, or one named for an import, is refused", async () => {
		const contract = { schema: CONTRACT_SCHEMA }
		const authored = (bindings: Worker['options']['bindings']): CloudflareAppConfig =>
			config({
				...contract,
				resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main: ENTRY }),
			})
		const options = {
			env: 'prod',
			domain: 'notes.example.com',
			installationApps: owners,
			checkoutContract: notesArtifact,
			managedEnvironment: connectorHanded,
		}
		await expect(deploy(rec, authored({ CATALOG: new ServiceReference('catalog-proxy') }), options)).rejects.toThrow(
			'binds service `prod-catalog-proxy`, a name of application `catalog` (environment `prod`)',
		)
		await expect(deploy(rec, authored({ FABRIKA_CONNECT_CATALOG: new ServiceReference('catalog-proxy') }), options)).rejects.toThrow(
			'application variable `FABRIKA_CONNECT_CATALOG` is managed by Fabrika',
		)
		await expect(deploy(rec, authored({ FABRIKA_CONNECT_CATALOG: emitting({ services: [] }) }), options)).rejects.toThrow('is managed by Fabrika')
	})

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
			await expect(deploy(rec, config({ resources: () => bindingIam(emitting(extra)) }), { env: 'prod', installationApps })).rejects
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
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'notes-admin', compatibility_flags: [], bindings: {}, main: ENTRY }),
		})
		await expect(deploy(rec, admin, { appId: 'notes-admin', env: 'prod', installationApps })).resolves.toMatchObject({ status: 'succeeded' })
		// …and `notes` cannot take `notes-admin`'s.
		const registry = [...installationApps, { app: 'notes-admin', env: 'prod' }]
		const notes = config({
			id: 'notes',
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'notes-admin-api', compatibility_flags: [], bindings: {}, main: ENTRY }),
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

/** The wrangler config oblaka generates for the provisioned graph's Worker `name`. */
const generatedConfig = async (name: string): Promise<GeneratedConfig['config']> => {
	const { configs } = await generateWranglerConfigs(provisioned().root, 'stage')
	const found = configs.find((generated) => generated.config.name === name)
	if (found === undefined) throw new Error(`oblaka generated no config for \`${name}\``)
	return found.config
}

/** A contract whose proxy manifest is past a Worker variable's 5,120 bytes: `notes` with forty more query endpoints. */
const largeContract = (): ContractArtifact => {
	const [me] = notesArtifact.endpoints
	if (me === undefined) throw new Error('the fixture has endpoints')
	const bulk = Array.from({ length: 40 }, (_, index) => ({ ...me, id: `api.bulk${index}`, path: `/api/bulk${index}` }))
	return { ...notesArtifact, endpoints: [...notesArtifact.endpoints, ...bulk] }
}

/** The managed values Control hands an application that has a job, a webhook, mail, signed tokens and an Operations DSN. */
const CREDENTIALS = {
	FABRIKA_OPERATIONS_DSN: 'https://operations-private-key@errors.test/1',
	FABRIKA_SERVICE_KEY: 'service-key-value',
	FABRIKA_TOKEN_KEYS: 'kid12345:token-secret',
	FABRIKA_JOB_NIGHTLY_KEY: 'px_job-secret',
	FABRIKA_WEBHOOK_BILLING_KEY: 'px_webhook-secret',
	FABRIKA_EMAIL_RESEND_API_KEY: 're_mail-secret',
	FABRIKA_PLATFORM_MAIL_KEY: 'px_relay-secret',
	FABRIKA_IAM_RPC_KEY: 'px_membership-secret',
}

const PUBLIC_MANAGED = {
	FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit',
	FABRIKA_APP_ORIGIN: 'https://stage.example.com',
	FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.com',
}

describe('a full contract application on Cloudflare (ADR-0065)', () => {
	test("a manifest past a Worker variable's 5 KB deploys, baked into the proxy Worker's bundle instead of a variable", async () => {
		const contract = largeContract()
		const result = await deploy(rec, config(), { contract })
		expect(result.status).toBe('succeeded')
		const proxy = await generatedConfig('stage-demo-proxy')
		const literal = proxy.define?.[PROXY_MANIFEST_DEFINE]
		const baked: unknown = literal === undefined ? undefined : JSON.parse(literal)
		if (typeof baked !== 'string') throw new Error('the proxy config bakes no manifest')
		expect(new TextEncoder().encode(baked).length).toBeGreaterThan(5120)
		expect(baked).toBe(proxyManifestJson(provisioned().root) ?? '')
		expect(parseProxyManifestJson(baked)?.apps[0]?.endpoints).toHaveLength(contractProxyTable(contract, undefined, { ops: true }).endpoints.length)
		expect(Object.keys(proxy.vars ?? {})).toEqual(['FABRIKA_IAM_ISSUER'])
		expect(PROXY_MANIFEST_DEFINE).toBe('__FABRIKA_PROXY_MANIFEST__')
	})

	test('an application config cannot substitute values into its bundle (`define`): only the platform proxy carries one', async () => {
		const authored = config({ resources: () => withRawOptions(appWorker(), { define: { FABRIKA_IAM_ISSUER: '"https://forged.example"' } }) })
		await expect(deploy(rec, authored)).rejects.toThrow('Worker `stage-demo` sets `define`, which an app may not configure')
	})

	test('a managed credential never lands in the generated vars; it is uploaded with the version, from a file removed after a failed deploy', async () => {
		const files: Array<{ readonly path: string; readonly mode: number; readonly secrets: unknown }> = []
		const result = await deploy(rec, config(), {
			managedEnvironment: { ...CREDENTIALS, ...PUBLIC_MANAGED, FABRIKA_IAM_ISSUER: 'https://iam.example.test' },
			runCommand: async (spec) => {
				const flag = spec.args.indexOf('--secrets-file')
				const path = flag === -1 ? undefined : spec.args[flag + 1]
				if (path === undefined) return succeeded(spec)
				files.push({ path, mode: (await stat(path)).mode & 0o777, secrets: JSON.parse(await readFile(path, 'utf8')) })
				return { exitCode: 1, stdout: '', stderr: 'upload refused' }
			},
		})
		expect(result.status).toBe('failed')
		expect(stepError(result, 'deploy-worker')).toBe('wrangler deploy failed (exit 1): upload refused')
		const application = await generatedConfig('stage-demo')
		for (const name of Object.keys(CREDENTIALS)) expect(application.vars).not.toHaveProperty(name)
		expect(application.vars).toMatchObject(PUBLIC_MANAGED)
		expect(files).toHaveLength(1)
		expect(files[0]?.secrets).toEqual(CREDENTIALS)
		expect(files[0]?.mode).toBe(0o600)
		// Gone with its directory, although the deploy failed.
		expect(existsSync(dirname(files[0]?.path ?? '/'))).toBe(false)
		// The proxy is deployed first and gets none of them.
		const deploys = rec.commands.filter((command) => command.args[0] === 'deploy')
		expect(deploys.map((command) => command.cwd === CLOUDFLARE_PROXY_WORKER_DIR ? command.args : command.args.slice(0, 2))).toEqual([
			['deploy'],
			['deploy', '--secrets-file'],
		])
		const printed = [...rec.logs, ...(result.steps.map((step) => step.error ?? ''))].join('\n')
		for (const value of Object.values(CREDENTIALS)) expect(printed).not.toContain(value)
	})

	test('a dry run names the secrets it would upload, never their values, and writes no file', async () => {
		await deploy(rec, config(), { dryRun: true, managedEnvironment: { FABRIKA_TOKEN_KEYS: CREDENTIALS.FABRIKA_TOKEN_KEYS } })
		expect(rec.commands).toEqual([])
		expect(rec.logs.join('\n')).toContain('with the secrets FABRIKA_TOKEN_KEYS')
		expect(rec.logs.join('\n')).not.toContain(CREDENTIALS.FABRIKA_TOKEN_KEYS)
	})

	test('a managed secret the deploy no longer writes is deleted after the deploy; an operator secret is kept', async () => {
		const held = ['FABRIKA_OPERATIONS_DSN', 'FABRIKA_JOB_RETIRED_KEY', 'FABRIKA_TOKEN_KEYS', 'API_KEY'].map((name) => ({ name, type: 'secret_text' }))
		const result = await deploy(rec, config(), {
			managedEnvironment: { FABRIKA_OPERATIONS_DSN: CREDENTIALS.FABRIKA_OPERATIONS_DSN, FABRIKA_TOKEN_KEYS: null },
			commandResult: (spec) => ({ exitCode: 0, stdout: isSecretList(spec) ? JSON.stringify(held) : '', stderr: '' }),
		})
		expect(result.status).toBe('succeeded')
		const commands = rec.commands.map((command) => [command.command, ...command.args.filter((arg) => !arg.startsWith('/'))])
		expect(commands).toEqual([
			APP_BUILD,
			['wrangler', 'deploy'],
			['wrangler', 'deploy', '--secrets-file'],
			SECRET_LIST,
			['wrangler', 'secret', 'delete', 'FABRIKA_JOB_RETIRED_KEY'],
			['wrangler', 'secret', 'delete', 'FABRIKA_TOKEN_KEYS'],
		])
		const deletes = rec.commands.filter((command) => command.args[1] === 'delete')
		expect(deletes.every((command) => command.stdin === '' && command.cwd === `${REPO}/app`)).toBe(true)
	})

	test('a platform component sweeps no secret: its own carry framework names', async () => {
		await deploy(rec, config(), { platformResources: 'allow' })
		expect(rec.commands.some(isSecretList)).toBe(false)
	})

	test('an unreadable secret list fails the deploy rather than leaving a stale credential', async () => {
		const result = await deploy(rec, config(), { commandResult: (spec) => ({ exitCode: 0, stdout: isSecretList(spec) ? 'Not JSON' : '', stderr: '' }) })
		expect(stepError(result, 'deploy-worker')).toBe('wrangler secret list printed no readable list of secrets')
	})

	test('the application Worker binds its object under a fixed migration, the files bucket, and the minute tick of a job or a file kind', async () => {
		await deploy(rec, config(), { contract: notesArtifact })
		const application = await generatedConfig('stage-demo')
		expect(application.durable_objects).toEqual({ bindings: [{ name: 'FABRIKA_APPLICATION', class_name: 'FabrikaApplication' }] })
		expect(application.migrations).toEqual([{ tag: 'v0001', new_sqlite_classes: ['FabrikaApplication'] }])
		expect(application.r2_buckets).toEqual([{ binding: 'FABRIKA_FILES', bucket_name: 'stage-demo-files' }])
		expect(application.triggers).toEqual({ crons: ['* * * * *'] })
		const { resources } = await generateWranglerConfigs(provisioned().root, 'stage')
		expect(resources.filter((resource) => resource.kind === 'r2_bucket').map((resource) => resource.remote)).toEqual(['stage-demo-files'])
	})

	test('an application on a framework before 0.9, or a run from a Control that names no release, keeps the stateless Worker (ADR-0062)', async () => {
		for (const framework of ['0.8.1', null]) {
			await deploy(rec, config(), { contract: notesArtifact, framework })
			const application = await generatedConfig('stage-demo')
			expect(application.durable_objects).toBeUndefined()
			expect(application.migrations).toBeUndefined()
			expect(application.r2_buckets).toBeUndefined()
			rec.provisions.shift()
		}
	})

	test('a contract with neither a job nor a file kind gets the object, the bucket and an empty cron list, which clears an older tick', async () => {
		const quiet: ContractArtifact = {
			...notesArtifact,
			jobs: {},
			files: {},
			endpoints: notesArtifact.endpoints.filter((row) => row.source.kind !== 'files'),
		}
		await deploy(rec, config(), { contract: quiet })
		const application = await generatedConfig('stage-demo')
		expect(application.triggers).toEqual({ crons: [] })
		expect(application.durable_objects?.bindings).toHaveLength(1)
		expect(application.r2_buckets).toEqual([{ binding: 'FABRIKA_FILES', bucket_name: 'stage-demo-files' }])
		const fileKind: ContractArtifact = { ...quiet, fileKinds: { photo: { types: ['image/png'], maxBytes: 1024 } } }
		await deploy(rec, config(), { contract: fileKind })
		expect(rec.provisions).toHaveLength(2)
		rec.provisions.shift()
		expect((await generatedConfig('stage-demo')).triggers).toEqual({ crons: ['* * * * *'] })
	})

	test("an application authors none of its object's binding, migration, bucket or cron triggers", async () => {
		const binds = (bindings: Record<string, Bindable>): CloudflareAppConfig =>
			config({
				resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main: ENTRY }),
			})
		await expect(deploy(rec, binds({ FABRIKA_APPLICATION: new DurableObject({ name: 'mine', className: 'Mine' }) }))).rejects.toThrow(
			'application variable `FABRIKA_APPLICATION` is managed by Fabrika',
		)
		await expect(deploy(rec, binds({ FABRIKA_FILES: new R2Bucket({ name: 'demo-mine' }) }))).rejects.toThrow(
			'application variable `FABRIKA_FILES` is managed by Fabrika',
		)
		await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), { triggers: { crons: ['0 3 * * *'] } }) }))).rejects.toThrow(
			'application Worker `demo` sets `triggers`; the platform writes its cron triggers',
		)
		await expect(deploy(rec, binds({ X: emitting({ triggers: { crons: ['0 3 * * *'] } }) }))).rejects.toThrow(
			'sets `triggers` the platform did not write',
		)
		await expect(deploy(rec, binds({ X: emitting({ migrations: [{ tag: 'v0001', new_sqlite_classes: ['Other'] }] }) }))).rejects.toThrow(
			'must open its migrations with `v0001` creating `FabrikaApplication`',
		)
		await expect(deploy(rec, binds({ X: emitting({ durable_objects: { bindings: [] } }) }))).rejects.toThrow(
			'must bind `FABRIKA_APPLICATION` once, to its own `FabrikaApplication`',
		)
		const moved = { r2_buckets: [{ binding: 'FABRIKA_FILES', bucket_name: 'stage-demo-elsewhere' }] }
		await expect(deploy(rec, binds({ X: emitting(moved) }))).rejects.toThrow('must bind `FABRIKA_FILES` once, to `stage-demo-files`')
	})

	test('an environment whose files bucket would not be a valid R2 name is refused before anything runs', async () => {
		const id = `a${'b'.repeat(60)}`
		const long = config({
			id,
			resources: () => new Worker({ dir: '.', ...PRIVATE, name: id, compatibility_flags: [], bindings: {}, main: ENTRY }),
		})
		await expect(deploy(rec, long, { appId: id })).rejects.toThrow(
			`the files bucket \`stage-${id}-files\` of \`${id}@stage\` is not a valid R2 bucket name`,
		)
		expect(rec.provisions).toEqual([])
	})

	test('a local deploy refuses a scanning file kind and raw SQL from the contract it reads, as Control does', async () => {
		const scanning: ContractArtifact = { ...notesArtifact, fileKinds: { scans: { types: ['application/pdf'], maxBytes: 1024, scan: true } } }
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA }), { checkoutContract: scanning })).rejects.toThrow(
			'cloudflare: file kind `scans` scans its uploads (`scan: true`), and no scanner runs on Cloudflare yet',
		)
		const raw: ContractArtifact = { ...notesArtifact, declared: { 'api.notes.report': { sql: 'write', unscoped: {}, connect: [], issues: null } } }
		await expect(deploy(rec, config({ schema: CONTRACT_SCHEMA }), { checkoutContract: raw })).rejects.toThrow(
			'cloudflare: `api.notes.report` declares raw SQL (`ctx.sql`)',
		)
		expect(rec.provisions).toEqual([])
	})
})

/** The application's own CLI, as the checkout's `bun install` puts it in the application directory. */
const APP_CLI = `${REPO}/app/node_modules/.bin/fabrika`

const APP_BUILD = [APP_CLI, 'app', 'build', '--provider=cloudflare', '--config=fabrika.config.ts']

const authoredWorker = (main: string, bindings: Record<string, Bindable> = {}): CloudflareAppConfig =>
	config({ resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main }) })

describe('the generated entry of a gated release (pinsGeneratedEntry)', () => {
	test('a hand-written `main` is refused before anything runs', async () => {
		for (const main of ['src/index.ts', 'fabrika/entry.ts', '../fabrika/entry.generated.ts']) {
			await expect(deploy(rec, authoredWorker(main))).rejects.toThrow(
				`application Worker \`stage-demo\` runs \`${main}\`; on its framework release it runs \`fabrika/entry.generated.ts\` beside its config, which the deploy regenerates`,
			)
		}
		expect(rec.provisions).toEqual([])
		expect(rec.commands).toEqual([])
	})

	test('a run without approved access (a local deploy) names no release, and keeps its authored `main` and plan', async () => {
		const local = { ...authoredWorker('src/index.ts'), schema: CONTRACT_SCHEMA }
		const result = await deploy(rec, local, { checkoutContract: notesArtifact })
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual(['provision-resources', 'deploy-worker', 'reconcile-schema'])
		expect(rec.commands.some((command) => command.command.endsWith('/node_modules/.bin/fabrika'))).toBe(false)
	})

	test('the config keys no generated entry serves are refused: workflows, containers and an object of its own', async () => {
		const workflow = { workflows: [{ binding: 'FLOW', name: 'stage-demo-flow', class_name: 'Flow' }] }
		await expect(deploy(rec, authoredWorker(ENTRY, { X: emitting(workflow) }))).rejects.toThrow(
			'application Worker `stage-demo` declares `workflows`, which the generated entry does not export',
		)
		const container = { containers: [{ name: 'stage-demo-box', class_name: 'Box', image: './Dockerfile' }] }
		await expect(deploy(rec, authoredWorker(ENTRY, { X: emitting(container) }))).rejects.toThrow(
			'application Worker `stage-demo` declares `containers`, which the generated entry does not export',
		)
		await expect(deploy(rec, authoredWorker(ENTRY, { COUNTER: new DurableObject({ name: 'counter', className: 'Counter' }) }))).rejects.toThrow(
			'application Worker `stage-demo` binds the Durable Object `COUNTER`; the generated entry exports only `FabrikaApplication`',
		)
		expect(rec.provisions).toEqual([])
	})

	test("the build step runs the authored pipeline, then the application's own `fabrika app build`", async () => {
		const result = await deploy(rec, config({ pipeline: { build: 'bun run build' } }))
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual(['build', 'provision-resources', 'deploy-worker', 'reconcile-schema'])
		expect(rec.commands.slice(0, 2).map((command) => [command.command, ...command.args])).toEqual([['sh', '-c', 'bun run build'], APP_BUILD])
		expect(rec.commands[1]?.cwd).toBe(`${REPO}/app`)
	})

	test("the application's CLI gets only PATH, HOME and TMPDIR of the executor's environment, and a failed build logs none of the rest", async () => {
		// What the runner puts into the executor's environment: the account credential, an application secret, a managed one.
		const executor = { CLOUDFLARE_API_TOKEN: 'tok-sentinel', API_KEY: 'app-secret-sentinel', FABRIKA_PROXY_SECRET: 'proxy-secret-sentinel' }
		Object.assign(process.env, executor)
		try {
			for (const pipeline of [undefined, { build: 'true' }]) {
				rec.provisions.splice(0)
				rec.commands.splice(0)
				// The real command runner, with the CLI swapped for one that prints the environment it got and fails.
				const result = await deploy(rec, config(pipeline === undefined ? {} : { pipeline }), {
					secrets: { API_KEY: executor.API_KEY },
					managedEnvironment: { FABRIKA_PROXY_SECRET: executor.FABRIKA_PROXY_SECRET },
					runCommand: (spec) =>
						defaultCloudflareCollaborators.runCommand(spec.command === APP_CLI ? { ...spec, command: 'sh', args: ['-c', 'env >&2; exit 1'] } : spec),
				})
				const error = stepError(result, 'build') ?? ''
				expect(error).toStartWith('fabrika app build failed (exit 1): ')
				expect(error).toContain('PATH=')
				for (const value of Object.values(executor)) expect(error).not.toContain(value)
				expect(rec.provisions).toEqual([])
				// `env` itself, not a shell, which sets a variable or two of its own.
				const spec = rec.commands.find((command) => command.command === APP_CLI)
				if (spec === undefined) throw new Error('the entry build ran no command')
				const printed = await defaultCloudflareCollaborators.runCommand({ ...spec, command: 'env', args: [] })
				const names = printed.stdout.trim().split('\n').map((line) => line.slice(0, line.indexOf('=')))
				expect(names.filter((name) => !['PATH', 'HOME', 'TMPDIR'].includes(name))).toEqual([])
				expect(names).toContain('PATH')
			}
		} finally {
			for (const name of Object.keys(executor)) delete process.env[name]
		}
	})

	test("a nested config finds the application's CLI where the workspace links it, up to the checkout and no higher", async () => {
		const checkout = await mkdtemp(join(tmpdir(), 'fabrika-workspace-'))
		fixtures.push(checkout)
		const cli = await withApplicationCli(checkout)
		const demo = join(checkout, 'apps', 'demo')
		await withBuiltMounts(demo)
		const nested = { checkoutDir: demo, cwd: checkout, configPath: 'apps/demo/fabrika.config.ts' }
		const result = await deploy(rec, config(), nested)
		expect(result.status).toBe('succeeded')
		expect(rec.commands[0]).toMatchObject({ command: cli, args: ['app', 'build', '--provider=cloudflare', '--config=fabrika.config.ts'], cwd: demo })
		// The runner installed in `apps/`, so a CLI above it is not the application's.
		rec.commands.splice(0)
		const above = await deploy(rec, config(), { ...nested, cwd: join(checkout, 'apps'), configPath: 'demo/fabrika.config.ts' })
		expect(stepError(above, 'build')).toBe(
			`fabrika app build: no \`node_modules/.bin/fabrika\` from \`${demo}\` up to \`${
				join(checkout, 'apps')
			}\`; the application installs \`@fabrika/cli\``,
		)
		expect(rec.commands).toEqual([])
	})

	test("without an authored pipeline the plan still builds, with the application's `fabrika app build` alone", async () => {
		const result = await deploy(rec, config())
		expect(result.steps.map((step) => step.id)).toEqual(['build', 'provision-resources', 'deploy-worker', 'reconcile-schema'])
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			APP_BUILD,
			['wrangler', 'deploy'],
			['wrangler', 'deploy'],
			SECRET_LIST,
		])
	})

	test('a failed entry build fails the build step, and nothing is provisioned', async () => {
		const result = await deploy(rec, config(), {
			commandResult: (spec) => spec.command === APP_CLI ? { exitCode: 1, stdout: '', stderr: 'no contract' } : succeeded(spec),
		})
		expect(result.status).toBe('failed')
		expect(stepError(result, 'build')).toBe('fabrika app build failed (exit 1): no contract')
		expect(rec.provisions).toEqual([])
	})

	test('a dry run names the entry build and runs nothing', async () => {
		await deploy(rec, config({ pipeline: { build: 'bun run build' } }), { dryRun: true })
		expect(rec.commands).toEqual([])
		expect(rec.logs).toContain(`  [dry-run] would run: fabrika app build --provider=cloudflare --config=fabrika.config.ts in ${REPO}/app`)
	})

	test('an older release, or a Control that names none, deploys as before: its own `main`, its keys, no entry build', async () => {
		const workflow = { workflows: [{ binding: 'FLOW', name: 'stage-demo-flow', class_name: 'Flow' }] }
		for (const framework of ['0.8.2', null]) {
			const result = await deploy(rec, authoredWorker('src/index.ts', { X: emitting(workflow) }), { contract: notesArtifact, framework })
			expect(result.status).toBe('succeeded')
			expect(result.steps.map((step) => step.id)).toEqual(['provision-resources', 'deploy-worker', 'reconcile-schema'])
			expect(rec.commands.some((command) => command.command === APP_CLI)).toBe(false)
			rec.commands.splice(0)
		}
		const built = await deploy(rec, config({ pipeline: { build: 'bun run build' } }), { framework: '0.8.2' })
		expect(built.steps.map((step) => step.id)).toEqual(['build', 'provision-resources', 'deploy-worker', 'reconcile-schema'])
		expect(rec.commands.map((command) => command.command)).toEqual(['sh', 'wrangler', 'wrangler', 'wrangler'])
	})
})

describe('the ops channel of a gated release (servesOps, ADR-0069)', () => {
	/** The endpoint table the proxy Worker of the provisioned graph serves. */
	const proxiedEndpoints = () => {
		const manifest = parseProxyManifestJson(proxyManifestJson(provisioned().root) ?? '')
		const entry = manifest?.apps[0]
		if (entry === undefined || !isApplicationEntry(entry)) throw new Error('the proxy Worker serves no application entry')
		return entry.endpoints
	}
	const OBJECT_VARIABLES = { FABRIKA_APPLICATION_OBJECT: 'application', FABRIKA_APPLICATION_OBJECTS: 'application' }

	test('a gated release gets the ops row in its proxy and both object variables in its Worker', async () => {
		const result = await deploy(rec, config(), { contract: notesArtifact, framework: '0.9.0' })
		expect(result.status).toBe('succeeded')
		expect(proxiedEndpoints()).toEqual(contractProxyTable(notesArtifact, undefined, { ops: true }).endpoints)
		expect(proxiedEndpoints()).toContainEqual(opsProxyRow())
		expect(opsProxyRow().admission?.maxBytes).toBe(OPS_ROW_MAX_BYTES)
		const application = await generatedConfig('stage-demo')
		expect(application.vars).toMatchObject(OBJECT_VARIABLES)
		// Plain variables: a deploy without them removes them, as every var of a Worker version.
		expect(rec.commands.some((command) => command.args.includes('FABRIKA_APPLICATION_OBJECT'))).toBe(false)
	})

	test('a redeploy of an older pin, or from a Control that names no release, writes neither the row nor the variables (ADR-0062)', async () => {
		for (const framework of ['0.8.1', null]) {
			await deploy(rec, config(), { contract: notesArtifact, framework })
			expect(proxiedEndpoints()).toEqual(contractProxyTable(notesArtifact).endpoints)
			const application = await generatedConfig('stage-demo')
			expect(application.vars ?? {}).not.toHaveProperty('FABRIKA_APPLICATION_OBJECT')
			expect(application.vars ?? {}).not.toHaveProperty('FABRIKA_APPLICATION_OBJECTS')
			rec.provisions.shift()
		}
	})

	test('an environment without a domain has no ops channel: no row (Q1)', async () => {
		await deploy(rec, config(), { contract: notesArtifact, framework: '0.9.0', domain: null })
		expect(proxiedEndpoints()).toEqual(contractProxyTable(notesArtifact).endpoints)
	})

	test('an application authors neither object variable, and a generated config carries them only as the platform wrote them', async () => {
		const authored = (vars: Record<string, string>, bindings: Record<string, Bindable> = {}): CloudflareAppConfig =>
			config({ resources: () => new Worker({ dir: '.', ...PRIVATE, name: 'demo', compatibility_flags: [], bindings, main: ENTRY, vars }) })
		for (const name of Object.keys(OBJECT_VARIABLES)) {
			await expect(deploy(rec, authored({ [name]: 'application' }), { contract: notesArtifact })).rejects.toThrow(
				`application variable \`${name}\` is managed by Fabrika`,
			)
		}
		// A binding that adds a variable to whatever the deployer wrote, after the deployer wrote it.
		const redirecting: Bindable = {
			configureBinding: ({ config }) => ({ ...config, vars: { ...config.vars, FABRIKA_APPLICATION_OBJECT: 'restored' } }),
		}
		const redirected = (framework: string) => deploy(rec, authored({}, { X: redirecting }), { contract: notesArtifact, framework })
		await expect(redirected('0.9.0')).rejects.toThrow('sets `FABRIKA_APPLICATION_OBJECT` to a value Fabrika did not write')
		await expect(redirected('0.8.1')).rejects.toThrow('sets `FABRIKA_APPLICATION_OBJECT` to a value Fabrika did not write')
		expect(rec.provisions).toEqual([])
	})
})

describe("the SPA mounts' files on Workers Assets", () => {
	/** A checkout whose build wrote `notesArtifact`'s two mount directories with `extra` files beside their index. */
	const builtCheckout = async (extra: (root: string) => Promise<void> = async () => {}): Promise<string> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-spa-'))
		fixtures.push(root)
		await withApplicationCli(root)
		await withBuiltMounts(root)
		await extra(root)
		return root
	}

	test('a Worker that declares no assets gets the staged directory, each mount at its prefix, with no source map', async () => {
		const checkoutDir = await builtCheckout(async (root) => {
			await mkdir(join(root, 'dist', 'app', 'assets'))
			await writeFile(join(root, 'dist', 'app', 'assets', 'app.js'), 'export {}')
			await writeFile(join(root, 'dist', 'app', 'assets', 'app.js.map'), '{}')
			// The root mount's copy of a path under `/s` is never served: the proxy routes `/s/*` to the link mount.
			await mkdir(join(root, 'dist', 'app', 's'))
			await writeFile(join(root, 'dist', 'app', 's', 'index.html'), 'shadowed')
			// A stale tree of an earlier deploy is replaced, not merged.
			await mkdir(join(root, 'fabrika', 'assets'), { recursive: true })
			await writeFile(join(root, 'fabrika', 'assets', 'stale.txt'), 'old')
		})
		const result = await deploy(rec, config(), { checkoutDir })
		expect(result.status).toBe('succeeded')
		expect((await generatedConfig('stage-demo')).assets).toEqual({ directory: 'fabrika/assets', binding: 'ASSETS', run_worker_first: true })
		const staged = join(checkoutDir, 'fabrika', 'assets')
		expect(await readFile(join(staged, 'index.html'), 'utf8')).toBe('<!doctype html><title>dist/app</title>')
		expect(await readFile(join(staged, 'assets', 'app.js'), 'utf8')).toBe('export {}')
		expect(await readFile(join(staged, 's', 'index.html'), 'utf8')).toBe('<!doctype html><title>dist/share</title>')
		expect(existsSync(join(staged, 'assets', 'app.js.map'))).toBe(false)
		expect(existsSync(join(staged, 'stale.txt'))).toBe(false)
		expect(rec.logs).toContain('  staged 3 SPA files into fabrika/assets: /s from dist/share, / from dist/app')
	})

	test('a Worker that declares its own assets keeps them, and nothing is staged', async () => {
		const checkoutDir = await builtCheckout(async (root) => {
			await mkdir(join(root, 'public'))
			await writeFile(join(root, 'public', 'index.html'), 'authored')
		})
		const result = await deploy(rec, assetsApp(), { checkoutDir })
		expect(result.status).toBe('succeeded')
		expect((await generatedConfig('stage-demo')).assets).toEqual({ binding: 'ASSETS', directory: 'public' })
		expect(existsSync(join(checkoutDir, 'fabrika', 'assets'))).toBe(false)
	})

	test('a contract without a mount that serves files gets no assets', async () => {
		const mounts = Object.fromEntries(Object.entries(notesArtifact.mounts).filter(([, mount]) => mount.kind !== 'spa' && mount.kind !== 'link'))
		const endpoints = notesArtifact.endpoints.filter((row) => row.kind !== 'spa' && row.source.name !== 'shared')
		const result = await deploy(rec, config(), { contract: { ...notesArtifact, mounts, endpoints } })
		expect(result.status).toBe('succeeded')
		expect((await generatedConfig('stage-demo')).assets).toBeUndefined()
	})

	test('a mount directory the build did not write, or one holding a symbolic link, fails the deploy before wrangler runs', async () => {
		const unbuilt = await mkdtemp(join(tmpdir(), 'fabrika-spa-'))
		fixtures.push(unbuilt)
		await withApplicationCli(unbuilt)
		const missing = await deploy(rec, config(), { checkoutDir: unbuilt })
		expect(stepError(missing, 'deploy-worker')).toBe(
			'cloudflare: mount `shared` serves `dist/share`, which the build did not produce; build it in `pipeline.build`',
		)
		const linked = await builtCheckout(async (root) => await symlink('/etc/passwd', join(root, 'dist', 'app', 'leak.txt')))
		rec.commands.splice(0)
		const refused = await deploy(rec, config(), { checkoutDir: linked })
		expect(stepError(refused, 'deploy-worker')).toBe(
			'cloudflare: mount `spa` serves `dist/app`, which contains `leak.txt`, a symbolic link; the deploy would publish its target',
		)
		expect(rec.commands.some((command) => command.args[0] === 'deploy' && command.cwd === linked)).toBe(false)
	})

	test('a mount directory outside the application, or one over the staged directory, is refused', async () => {
		for (
			const [dir, detail] of [
				['../outside', 'which is no directory inside the application'],
				['.', 'which is no directory inside the application'],
				['fabrika', 'which overlaps `fabrika/assets`, where the deploy stages the SPA files'],
			] as const
		) {
			const mounts = { ...notesArtifact.mounts, spa: { kind: 'spa' as const, prefix: '/', dir } }
			const result = await deploy(rec, config(), { contract: { ...notesArtifact, mounts } })
			expect(stepError(result, 'deploy-worker')).toBe(`cloudflare: mount \`spa\` serves \`${dir}\`, ${detail}`)
		}
	})

	test('a symbolic link in the middle of a mount directory, or on the way to the staged directory, is refused', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'fabrika-outside-'))
		fixtures.push(outside)
		await mkdir(join(outside, 'web'))
		await writeFile(join(outside, 'web', 'index.html'), 'not the application')
		for (const [link, to, dir] of [['x', '/', 'x/etc'], ['x', outside, 'x/web'], ['dist', join(outside), 'dist/web']] as const) {
			const checkoutDir = await builtCheckout(async (root) => {
				await rm(join(root, link), { recursive: true, force: true })
				await symlink(to, join(root, link))
			})
			const mounts = { ...notesArtifact.mounts, spa: { kind: 'spa' as const, prefix: '/', dir } }
			const result = await deploy(rec, config(), { checkoutDir, contract: { ...notesArtifact, mounts } })
			expect(stepError(result, 'deploy-worker')).toBe(
				link === 'dist'
					? `cloudflare: mount \`shared\` serves \`dist/share\`, which passes \`dist\`, a symbolic link; the deploy would publish its target`
					: `cloudflare: mount \`spa\` serves \`${dir}\`, which passes \`x\`, a symbolic link; the deploy would publish its target`,
			)
			expect(existsSync(join(checkoutDir, 'fabrika', 'assets', 'passwd'))).toBe(false)
			expect(existsSync(join(checkoutDir, 'fabrika', 'assets', 'index.html'))).toBe(false)
		}
		const redirected = await builtCheckout(async (root) => {
			await mkdir(join(root, 'fabrika'), { recursive: true })
			await symlink(outside, join(root, 'fabrika', 'assets'))
		})
		const result = await deploy(rec, config(), { checkoutDir: redirected })
		expect(stepError(result, 'deploy-worker')).toBe(
			'cloudflare: `fabrika/assets` is a symbolic link, and the deploy stages the SPA files into `fabrika/assets`',
		)
		expect(existsSync(join(outside, 'web', 'index.html'))).toBe(true)
	})

	test("Workers Assets' own configuration files of the build are never staged at the root", async () => {
		const checkoutDir = await builtCheckout(async (root) => {
			for (const name of ['_headers', '_redirects', '.assetsignore']) await writeFile(join(root, 'dist', 'app', name), '/* /elsewhere 302')
		})
		const result = await deploy(rec, config(), { checkoutDir })
		expect(result.status).toBe('succeeded')
		for (const name of ['_headers', '_redirects', '.assetsignore']) expect(existsSync(join(checkoutDir, 'fabrika', 'assets', name))).toBe(false)
		expect(existsSync(join(checkoutDir, 'fabrika', 'assets', 'index.html'))).toBe(true)
	})

	test('a dry run names what it would stage and writes nothing', async () => {
		const checkoutDir = await builtCheckout()
		await deploy(rec, config(), { checkoutDir, dryRun: true })
		expect(rec.logs).toContain('  [dry-run] would stage the SPA files into fabrika/assets: /s from dist/share, / from dist/app')
		expect(existsSync(join(checkoutDir, 'fabrika', 'assets'))).toBe(false)
	})
})
