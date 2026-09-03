import type { RunnerOutcomeFile } from '@fabrika/runner-contract'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { D1Database, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import type { CloudflareAppConfig, CloudflareAppConfigInput, CloudflareCollaborators, CommandResult, CommandSpec, ProvisionInput } from '..'
import { cloudflareArtifact, createCloudflareProvider, defaultCloudflareCollaborators, defineApp } from '..'

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
): CloudflareCollaborators => ({
	loadConfig: async (_cwd, configPath) => {
		expect(configPath).toBe('fabrika.config.ts')
		return { config: appConfig, cwd: checkoutDir }
	},
	runCommand: async (spec) => {
		rec.commands.push(spec)
		return commandResult(spec)
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

const open = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	options: {
		readonly dryRun?: boolean
		readonly secrets?: Readonly<Record<string, string>>
		readonly signal?: AbortSignal
		readonly commandResult?: (spec: CommandSpec) => CommandResult
		readonly appId?: string
		readonly managedEnvironment?: Readonly<Record<string, string | null>>
		readonly returnOrigins?: readonly string[]
		readonly domain?: string
		readonly platformResources?: 'refuse' | 'allow'
		readonly stateNamespace?: string
		readonly env?: string
		readonly checkoutDir?: string
	} = {},
) => {
	const provider = createCloudflareProvider(makeCollaborators(rec, appConfig, options.commandResult, options.checkoutDir), {
		...(options.platformResources === undefined ? {} : { platformResources: options.platformResources }),
	})
	return provider.runtime.open({
		appId: options.appId ?? 'demo',
		env: options.env ?? 'stage',
		domain: options.domain ?? 'stage.example.com',
		...(options.returnOrigins === undefined ? {} : { returnOrigins: options.returnOrigins }),
		cwd: '/repo',
		secrets: options.secrets ?? {},
		vars: {},
		managedEnvironment: options.managedEnvironment ?? {},
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		events: {
			log: (line) => {
				rec.logs.push(line)
			},
			externalId: async () => {},
			checkpoint: async () => {},
		},
		target: provider.encodeTarget({
			accountId: 'acc-1',
			apiToken: 'tok-1',
			...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		}),
		artifact: provider.encodeArtifact(cloudflareArtifact()),
	})
}

const executePlan = async (session: Awaited<ReturnType<typeof open>>): Promise<void> => {
	for (const step of session.plan.steps) {
		await session.execute(step.id)
	}
}

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
	test('encodes the target and checkout recipe as versioned provider envelopes', () => {
		const provider = createCloudflareProvider(makeCollaborators(rec, config()))
		expect(provider.encodeTarget({ accountId: 'acc', apiToken: 'tok', stateNamespace: 'legacy' })).toEqual({
			provider: 'cloudflare',
			version: 1,
			payload: { accountId: 'acc', apiToken: 'tok', stateNamespace: 'legacy' },
		})
		expect(provider.encodeArtifact(cloudflareArtifact('deploy/fabrika.config.ts'))).toEqual({
			provider: 'cloudflare',
			version: 1,
			payload: { configPath: 'deploy/fabrika.config.ts' },
		})
	})

	test('merges platform-managed values into the root Worker without exposing them in logs', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const session = await open(rec, config(), {
			dryRun: true,
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: dsn,
				FABRIKA_RELEASE: 'fabrika/demo/stage/default/commit',
				FABRIKA_SERVICE_KEY: null,
			},
		})
		await session.execute('provision-resources')
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
		await expect(open(rec, authored, { managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })).rejects.toThrow(
			'application variable `FABRIKA_OPERATIONS_DSN` is managed by Fabrika',
		)
		expect(rec.logs.join('\n')).not.toContain(dsn)
	})

	test('targets platform-managed values at the private application Worker', async () => {
		const app = new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' })
		const proxy = new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: app }, main: 'proxy-worker.ts' })
		const authored = config({ resources: () => proxy })
		const dsn = 'https://operations-public-key@errors.test/1'
		const session = await open(rec, authored, { dryRun: true, managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn } })
		await session.execute('provision-resources')
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
		const session = await open(rec, authored, { secrets: { API_KEY: 'secret-value' } })
		expect(session.plan.steps.map((step) => step.id)).toEqual(['build', 'provision-resources', 'migrate:APP.DB', 'deploy-worker', 'sync-secrets'])
		await executePlan(session)
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
		const session = await open(rec, app, { secrets: { API_KEY: 'secret' } })

		expect(session.plan.steps.map((step) => step.kind)).toEqual([
			'build',
			'provision-resources',
			'migrate',
			'deploy-worker',
			'reconcile-schema',
			'sync-secrets',
		])
		expect(session.plan.steps[1]?.dependsOn).toEqual(['build'])
		expect(session.plan.steps[3]?.dependsOn).toEqual(['migrate:DB'])
	})

	test('executes the plan through the provider collaborator bundle', async () => {
		const controller = new AbortController()
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] },
		})
		const session = await open(rec, app, { secrets: { API_KEY: 'secret-value' }, signal: controller.signal })
		await executePlan(session)

		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.cwd).toBe('/repo/app/worker')
		expect(rec.provisions[0]?.stateNamespace).toBe('demo-state')
		expect(rec.commands.map((command) => [command.command, ...command.args])).toEqual([
			['sh', '-c', 'bun run build'],
			['wrangler', 'deploy'],
			['wrangler', 'secret', 'put', 'API_KEY'],
		])
		expect(rec.commands[2]?.stdin).toBe('secret-value')
		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' } }])
	})

	test('reports the authz schema for the control plane instead of calling IAM from the container', async () => {
		const schema = { scopes: [{ type: 'team' }], actions: [{ action: 'notes.read' }], roles: {} }
		const session = await open(rec, config({ schema }), { returnOrigins: ['https://demo.example.com'] })
		await session.execute('reconcile-schema')

		expect(rec.outcomes).toEqual([{ iamReconcile: { app: 'demo', schemaJson: JSON.stringify(schema) } }])
		expect(rec.commands).toHaveLength(0)
	})

	test('refuses to report an outcome once the run is cancelled', async () => {
		const session = await open(rec, config({ schema: { scopes: [], actions: [], roles: {} } }), { signal: AbortSignal.abort() })
		await expect(session.execute('reconcile-schema')).rejects.toThrow('deploy cancelled')
		expect(rec.outcomes).toHaveLength(0)
	})

	test('dry-run keeps Oblaka in plan mode and skips every other mutation', async () => {
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
		})
		const session = await open(rec, app, { dryRun: true, secrets: { API_KEY: 'secret-value' } })
		await executePlan(session)

		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.dryRun).toBe(true)
		expect(rec.commands).toHaveLength(0)
		expect(rec.outcomes).toHaveLength(0)
		expect(rec.logs.some((line) => line.includes('would run build'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('wrangler secret put API_KEY'))).toBe(true)
	})

	test('fails closed when the loaded config belongs to another app', async () => {
		await expect(open(rec, config({ id: 'other' }))).rejects.toThrow('declares app "other", expected "demo"')
	})

	test('honours an already-aborted run before the first mutation', async () => {
		const session = await open(rec, config(), { signal: AbortSignal.abort() })
		await expect(session.execute('provision-resources')).rejects.toThrow('deploy cancelled')
		expect(rec.provisions).toHaveLength(0)
	})

	test('reports shell failures without leaking beyond the bounded command detail', async () => {
		const session = await open(rec, config(), {
			commandResult: (spec) =>
				spec.command === 'wrangler'
					? { exitCode: 1, stdout: '', stderr: 'deploy failed' }
					: { exitCode: 0, stdout: '', stderr: '' },
		})
		await session.execute('provision-resources')
		await expect(session.execute('deploy-worker')).rejects.toThrow('wrangler deploy failed (exit 1): deploy failed')
	})

	test('runs the checkout build with no platform credential in its environment', async () => {
		const session = await open(rec, config({ pipeline: { build: 'bun run build' } }))
		await session.execute('build')

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
		await expect(open(rec, platformWorker)).rejects.toThrow(
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
		await expect(open(rec, platformBucket)).rejects.toThrow(
			'R2 bucket `vozka-run-logs` becomes `stage-vozka-run-logs` on Cloudflare, which would take over the Fabrika platform resource `vozka-run-logs`',
		)
		expect(rec.provisions).toHaveLength(0)
	})

	test('lets fabrika deploy its own components under the explicit platform policy', async () => {
		const platformWorker = config({
			resources: () => new Worker({ dir: '.', name: 'vozka', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		const session = await open(rec, platformWorker, { platformResources: 'allow' })
		expect(session.plan.steps[0]?.id).toBe('provision-resources')
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
		await expect(open(rec, foreign)).rejects.toThrow("routes `other-app.example.com`, which is not this environment's domain")

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
		await expect(open(rec, own)).resolves.toBeDefined()
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
		await expect(open(rec, toRunner)).rejects.toThrow(
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
		await expect(open(rec, toIam)).resolves.toBeDefined()
	})

	test("refuses a deploy whose oblaka state namespace is the platform's own", async () => {
		await expect(open(rec, config(), { stateNamespace: 'propustka-state' })).rejects.toThrow(
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
		await expect(open(rec, platformOffHost, { platformResources: 'allow' })).rejects.toThrow(
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
		await expect(open(rec, smuggled)).rejects.toThrow('declares Worker `demo-sidecar`; only the application Worker and its proxy are deployable')
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
			await expect(open(rec, authored)).rejects.toThrow(`Worker \`demo\` sets \`${key}\`, which an app may not configure`)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('bounds the raw keys of every Worker in the graph, the proxy included', async () => {
		const app = withRawOptions(appWorker(), { services: [{ binding: 'CTRL', service: 'stage-vozka' }] })
		const proxy = new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: app }, main: 'proxy-worker.ts' })
		await expect(open(rec, config({ resources: () => proxy }))).rejects.toThrow('Worker `demo` sets `services`, which an app may not configure')

		const rawProxy = withRawOptions(
			new Worker({ dir: '/repo/proxy', name: 'demo-proxy', compatibility_flags: [], bindings: { APP: appWorker() }, main: 'proxy-worker.ts' }),
			{ build: { command: 'cat /proc/self/environ' } },
		)
		await expect(open(rec, config({ resources: () => rawProxy }))).rejects.toThrow('Worker `demo-proxy` sets `build`, which an app may not configure')
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
		await expect(open(rec, authored)).resolves.toBeDefined()
	})

	test('bounds the name oblaka adopts, so an env name cannot split the platform prefix', async () => {
		const worker = config({
			resources: () => new Worker({ dir: '.', name: 'worker', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(open(rec, worker, { env: 'prod-propustka' })).rejects.toThrow(
			'Worker `worker` becomes `prod-propustka-worker` on Cloudflare, which would take over the Fabrika platform resource `propustka-worker`',
		)

		const split: ReadonlyArray<readonly [string, string, Record<string, D1Database | KVNamespace | R2Bucket>, string]> = [
			['prod-propustka', 'D1 database `worker`', { DB: new D1Database({ name: 'worker' }) }, 'propustka-worker'],
			['prod-propustka', 'KV namespace `state`', { CACHE: new KVNamespace({ name: 'state' }) }, 'propustka-state'],
			['prod-vozka', 'R2 bucket `run-logs`', { FILES: new R2Bucket({ name: 'run-logs' }) }, 'vozka-run-logs'],
		]
		for (const [env, described, bindings, platform] of split) {
			const authored = config({ resources: () => new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings, main: 'src/index.ts' }) })
			await expect(open(rec, authored, { env })).rejects.toThrow(`${described} becomes \`${env}-`)
			await expect(open(rec, authored, { env })).rejects.toThrow(`would take over the Fabrika platform resource \`${platform}\``)
		}
		expect(rec.provisions).toHaveLength(0)
	})

	test('serves an assets directory the app keeps inside its own worker directory', async () => {
		for (const directory of ['public', 'dist/client', './public']) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory } }) })
			await expect(open(rec, authored)).resolves.toBeDefined()
		}
	})

	test('refuses an assets directory that reaches outside the worker directory or into `.git`', async () => {
		for (const directory of ['..', '../..', '/etc', '.', '', 'public/../..', '.git', 'dist/.git/x']) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS', directory } }) })
			await expect(open(rec, authored)).rejects.toThrow(
				`Worker \`demo\` sets \`assets.directory\` to \`${directory}\`; it must be a relative path strictly inside the worker directory`,
			)
		}
		await expect(open(rec, config({ resources: () => withRawOptions(appWorker(), { assets: { binding: 'ASSETS' } }) }))).rejects.toThrow(
			'sets `assets.directory` to `(not a string)`',
		)
		for (const assets of ['public', ['public'], null]) {
			const authored = config({ resources: () => withRawOptions(appWorker(), { assets }) })
			await expect(open(rec, authored)).rejects.toThrow('Worker `demo` sets `assets` to something that is not an object')
		}
		const unknownKey = config({ resources: () => withRawOptions(appWorker(), { assets: { directory: 'public', bucket: '../..' } }) })
		await expect(open(rec, unknownKey)).rejects.toThrow('Worker `demo` sets `assets.bucket`, which an app may not configure')
		expect(rec.provisions).toHaveLength(0)
	})

	test('deploys an assets directory that holds only regular files and directories', async () => {
		const checkoutDir = await assetsCheckout(async (assets) => {
			await mkdir(join(assets, 'nested'))
			await writeFile(join(assets, 'index.html'), '<!doctype html>')
			await writeFile(join(assets, 'nested', 'app.js'), 'export {}')
		})
		const session = await open(rec, assetsApp(), { checkoutDir })
		await executePlan(session)
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
			const session = await open(rec, assetsApp(), { checkoutDir })
			await session.execute('provision-resources')
			await expect(session.execute('deploy-worker')).rejects.toThrow(
				`Worker \`demo\` assets directory \`public\` contains \`${path}\`, which is a symbolic link; wrangler follows it and would publish its target`,
			)
		}
		expect(rec.commands).toHaveLength(0)
	})

	test('refuses the deploy when the assets directory is itself a symbolic link', async () => {
		const checkoutDir = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
		fixtures.push(checkoutDir)
		await symlink('/etc', join(checkoutDir, 'public'))
		const session = await open(rec, assetsApp(), { checkoutDir })
		await session.execute('provision-resources')
		await expect(session.execute('deploy-worker')).rejects.toThrow(
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
		const session = await open(rec, authored, {
			checkoutDir,
			commandResult: (spec) => {
				if (spec.command === 'sh') symlinkSync('/proc/self/environ', join(checkoutDir, 'public', 'x'))
				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})
		await session.execute('build')
		await session.execute('provision-resources')
		await expect(session.execute('deploy-worker')).rejects.toThrow(
			'Worker `demo` assets directory `public` contains `x`, which is a symbolic link',
		)
		expect(rec.commands.map((command) => command.command)).toEqual(['sh'])
	})

	test('walks no assets directory when fabrika is deploying its own components', async () => {
		const checkoutDir = await assetsCheckout(async (assets) => {
			await symlink('../secret.txt', join(assets, 'leak.txt'))
		})
		const session = await open(rec, assetsApp(), { checkoutDir, platformResources: 'allow' })
		await executePlan(session)
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
		await expect(open(rec, authored, { env: 'prod-eu', domain: 'notes.example.com' })).resolves.toBeDefined()
	})
})
