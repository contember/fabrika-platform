import type { RunnerOutcomeFile } from '@fabrika/runner-contract'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { D1Database, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import type {
	CloudflareAppConfig,
	CloudflareAppConfigInput,
	CloudflareCollaborators,
	CommandResult,
	CommandRunner,
	CommandSpec,
	ProvisionInput,
} from '..'
import { createCloudflareDeployer, defaultCloudflareCollaborators, defineApp } from '..'

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
		resources: () => new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		...overrides,
	})

const appWorker = (): Worker => new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' })

/** A checkout is plain JavaScript: its options object carries whatever raw wrangler keys it likes. */
const withRawOptions = (worker: Worker, raw: Record<string, unknown>): Worker => {
	Object.assign(worker.options, raw)
	return worker
}

const makeCollaborators = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	commandResult: (spec: CommandSpec) => CommandResult = () => ({ exitCode: 0, stdout: '', stderr: '' }),
	checkoutDir = '/repo/app',
	runCommand?: CommandRunner,
): CloudflareCollaborators => ({
	loadConfig: async (_cwd, configPath) => {
		expect(configPath).toBe('fabrika.config.ts')
		return { config: appConfig, cwd: checkoutDir }
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
		const nested = input.definition instanceof Worker && app instanceof Worker
		return {
			wranglerConfigs: nested
				? [
					{ path: '/repo/proxy/wrangler.jsonc', config: { name: `${input.env}-demo-proxy` }, content: '{}' },
					{ path: 'wrangler.jsonc', config: { name: `${input.env}-demo` }, content: '{}' },
				]
				: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-demo` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-demo` },
		}
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
	} = {},
) =>
	createCloudflareDeployer({
		accountId: 'acc-1',
		apiToken: 'tok-1',
		collaborators: makeCollaborators(rec, appConfig, options.commandResult, options.checkoutDir, options.runCommand),
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

	test('targets platform-managed values at the private application Worker', async () => {
		const app = new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' })
		const proxy = new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: app }, main: 'proxy-worker.ts' })
		const authored = config({ resources: () => proxy })
		const dsn = 'https://operations-public-key@errors.test/1'
		await deploy(rec, authored, { dryRun: true, managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })
		expect(rec.provisionedVars[0]).not.toHaveProperty('FABRIKA_OPERATIONS_DSN')
		expect(rec.applicationVars[0]).toMatchObject({ FABRIKA_OPERATIONS_DSN: dsn })
	})

	test('plans nested D1 migration and deploys every generated Worker config', async () => {
		const app = new Worker({
			dir: '.',
			name: 'demo',
			compatibility_flags: [],
			bindings: { DB: new D1Database({ name: 'main', migrationsDir: './migrations' }) },
			main: 'src/index.ts',
		})
		const proxy = new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: app }, main: 'proxy-worker.ts' })
		const authored = config({ resources: () => proxy, pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] } })
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
		expect(rec.commands[2]?.cwd).toBe('/repo/proxy')
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
			resources: () => new Worker({ dir: '.', name: 'vozka', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, platformWorker)).rejects.toThrow(
			'Worker `vozka` becomes `stage-vozka` on Cloudflare, which would take over the Fabrika platform resource `vozka`',
		)

		const platformBucket = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: [],
					bindings: { LOGS: new R2Bucket({ name: 'vozka-run-logs' }), QUEUE: new Queue({ name: 'vozka-deploy' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, platformBucket)).rejects.toThrow(
			'R2 bucket `vozka-run-logs` becomes `stage-vozka-run-logs` on Cloudflare, which would take over the Fabrika platform resource `vozka-run-logs`',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('lets fabrika deploy its own components under the explicit platform policy', async () => {
		const platformWorker = config({
			resources: () => new Worker({ dir: '.', name: 'vozka', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		const result = await deploy(rec, platformWorker, { platformResources: 'allow' })
		expect(result.steps[0]?.id).toBe('provision-resources')
		expect(result.status).toBe('succeeded')
	})

	test('refuses a route on a host this environment does not own', async () => {
		const foreign = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					routes: [{ pattern: 'other-app.example.com/*', zone_name: 'example.com' }],
				}),
		})
		await expect(deploy(rec, foreign)).rejects.toThrow("routes `other-app.example.com`, which is not this environment's domain")

		const own = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: [],
					bindings: {},
					main: 'src/index.ts',
					routes: [{ pattern: 'stage.example.com', custom_domain: true }],
				}),
		})
		await expect(deploy(rec, own)).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('refuses a service binding to a platform service, but not the IAM front door every app binds', async () => {
		const toRunner = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: [],
					bindings: { RUNNER_SVC: new ServiceReference('vozka-runner') },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, toRunner)).rejects.toThrow(
			'service binding to `vozka-runner` becomes `stage-vozka-runner` on Cloudflare, which would take over the Fabrika platform resource `vozka-runner`',
		)

		const toIam = config({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: [],
					bindings: { IAM: new ServiceReference('propustka-worker') },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, toIam)).resolves.toMatchObject({ status: 'succeeded' })
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
					name: 'demo',
					compatibility_flags: [],
					bindings: { SIDECAR: new Worker({ dir: '.', name: 'demo-sidecar', compatibility_flags: [], bindings: {}, main: 'src/other.ts' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, smuggled)).rejects.toThrow('declares Worker `demo-sidecar`; only the application Worker and its proxy are deployable')
	})

	test('refuses every raw wrangler key that would bind a resource or run a command', async () => {
		const smuggled: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			['services', { services: [{ binding: 'CTRL', service: 'stage-vozka' }] }],
			['durable_objects', { durable_objects: { bindings: [{ name: 'RC', class_name: 'RunnerContainer', script_name: 'stage-vozka-runner' }] } }],
			['r2_buckets', { r2_buckets: [{ binding: 'LOGS', bucket_name: 'stage-vozka-run-logs' }] }],
			['queues', { queues: { producers: [{ binding: 'Q', queue: 'stage-vozka-deploy' }] } }],
			['build', { build: { command: 'cat /proc/self/environ' } }],
			['site', { site: { bucket: '../..' } }],
		]
		for (const [key, raw] of smuggled) {
			const authored = config({ resources: () => withRawOptions(appWorker(), raw) })
			await expect(deploy(rec, authored)).rejects.toThrow(`Worker \`demo\` sets \`${key}\`, which an app may not configure`)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('bounds the raw keys of every Worker in the graph, the proxy included', async () => {
		const app = withRawOptions(appWorker(), { services: [{ binding: 'CTRL', service: 'stage-vozka' }] })
		const proxy = new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: app }, main: 'proxy-worker.ts' })
		await expect(deploy(rec, config({ resources: () => proxy }))).rejects.toThrow('Worker `demo` sets `services`, which an app may not configure')

		const rawProxy = withRawOptions(
			new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: appWorker() }, main: 'proxy-worker.ts' }),
			{ build: { command: 'cat /proc/self/environ' } },
		)
		await expect(deploy(rec, config({ resources: () => rawProxy }))).rejects.toThrow('Worker `demo-proxy` sets `build`, which an app may not configure')
	})

	test('keeps the Worker options an application config legitimately sets', async () => {
		const authored = config({
			resources: () =>
				new Worker({
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
					routes: [{ pattern: 'stage.example.com', custom_domain: true }],
					bindings: { DB: new D1Database({ name: 'notes' }) },
				}),
		})
		await expect(deploy(rec, authored)).resolves.toMatchObject({ status: 'succeeded' })
	})

	test('bounds the name oblaka adopts, so an env name cannot split the platform prefix', async () => {
		const worker = config({
			resources: () => new Worker({ dir: '.', name: 'worker', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(rec, worker, { env: 'prod-propustka' })).rejects.toThrow(
			'Worker `worker` becomes `prod-propustka-worker` on Cloudflare, which would take over the Fabrika platform resource `propustka-worker`',
		)

		const split: ReadonlyArray<readonly [string, string, Record<string, D1Database | KVNamespace | R2Bucket>, string]> = [
			['prod-propustka', 'D1 database `worker`', { DB: new D1Database({ name: 'worker' }) }, 'propustka-worker'],
			['prod-propustka', 'KV namespace `state`', { CACHE: new KVNamespace({ name: 'state' }) }, 'propustka-state'],
			['prod-vozka', 'R2 bucket `run-logs`', { FILES: new R2Bucket({ name: 'run-logs' }) }, 'vozka-run-logs'],
		]
		for (const [env, described, bindings, platform] of split) {
			const authored = config({ resources: () => new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings, main: 'src/index.ts' }) })
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
				`Worker \`demo\` sets \`assets.directory\` to \`${directory}\`; it must be a relative path strictly inside the worker directory`,
			)
		}
		await expect(deploy(rec, config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS' } }) }))).rejects.toThrow(
			'sets `assets.directory` to `(not a string)`',
		)
		for (const assets of ['public', ['public'], null]) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets }) })
			await expect(deploy(rec, authored)).rejects.toThrow('Worker `demo` sets `assets` to something that is not an object')
		}
		const unknownKey = config({ resources: () => withRawOptions(appWorker(), { assets: { directory: 'public', bucket: '../..' } }) })
		await expect(deploy(rec, unknownKey)).rejects.toThrow('Worker `demo` sets `assets.bucket`, which an app may not configure')
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
				`Worker \`demo\` assets directory \`public\` contains \`${path}\`, which is a symbolic link; wrangler follows it and would publish its target`,
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
			'Worker `demo` assets directory `public` is a symbolic link; wrangler follows it and would publish its target',
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
		expect(stepError(result, 'deploy-worker')).toContain('Worker `demo` assets directory `public` contains `x`, which is a symbolic link')
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
					name: 'notes',
					compatibility_flags: [],
					bindings: { DB: new D1Database({ name: 'notes' }), FILES: new R2Bucket({ name: 'notes-uploads' }) },
					main: 'src/index.ts',
				}),
		})
		await expect(deploy(rec, authored, { env: 'prod-eu', domain: 'notes.example.com' })).resolves.toMatchObject({ status: 'succeeded' })
	})
})
