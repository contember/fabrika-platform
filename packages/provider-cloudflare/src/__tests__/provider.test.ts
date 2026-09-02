import type { RunnerOutcomeFile } from '@fabrika/runner-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import { D1Database, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
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

const makeCollaborators = (
	rec: Recorded,
	appConfig: CloudflareAppConfig,
	commandResult: (spec: CommandSpec) => CommandResult = () => ({ exitCode: 0, stdout: '', stderr: '' }),
): CloudflareCollaborators => ({
	loadConfig: async (_cwd, configPath) => {
		expect(configPath).toBe('fabrika.config.ts')
		return { config: appConfig, cwd: '/repo/app' }
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
	} = {},
) => {
	const provider = createCloudflareProvider(makeCollaborators(rec, appConfig, options.commandResult), {
		...(options.platformResources === undefined ? {} : { platformResources: options.platformResources }),
	})
	return provider.runtime.open({
		appId: options.appId ?? 'demo',
		env: 'stage',
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

let rec: Recorded
beforeEach(() => {
	rec = { commands: [], provisions: [], outcomes: [], logs: [], provisionedVars: [], applicationVars: [] }
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
		await expect(open(rec, platformWorker)).rejects.toThrow('Worker `vozka` is a Fabrika platform resource')

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
		await expect(open(rec, platformBucket)).rejects.toThrow('R2 bucket `vozka-run-logs` is a Fabrika platform resource')
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
		await expect(open(rec, toRunner)).rejects.toThrow('service binding to `vozka-runner` is a Fabrika platform service')

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
})
