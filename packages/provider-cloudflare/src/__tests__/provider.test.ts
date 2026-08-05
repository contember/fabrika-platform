import { beforeEach, describe, expect, test } from 'bun:test'
import { D1Database, Worker } from 'oblaka-iac'
import type { CloudflareAppConfig, CloudflareAppConfigInput, CloudflareCollaborators, CommandResult, CommandSpec, ProvisionInput } from '..'
import { cloudflareArtifact, createCloudflareProvider, defineApp } from '..'

interface Recorded {
	readonly commands: CommandSpec[]
	readonly provisions: ProvisionInput[]
	readonly schemas: Array<{ url: string; app: string; adminKey?: string; returnOrigins?: readonly string[] }>
	readonly schemaSignals: AbortSignal[]
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
	reconcile: CloudflareCollaborators['reconcileSchema'] | undefined = undefined,
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
	reconcileSchema: async (input) => {
		rec.schemas.push({
			url: input.url,
			app: input.app,
			adminKey: input.adminKey,
			...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		})
		rec.schemaSignals.push(input.signal)
		await reconcile?.(input)
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
		readonly reconcileSchema?: CloudflareCollaborators['reconcileSchema']
		readonly appId?: string
		readonly managedEnvironment?: Readonly<Record<string, string | null>>
		readonly returnOrigins?: readonly string[]
	} = {},
) => {
	const provider = createCloudflareProvider(makeCollaborators(rec, appConfig, options.commandResult, options.reconcileSchema))
	return provider.runtime.open({
		appId: options.appId ?? 'demo',
		env: 'stage',
		domain: 'stage.example.com',
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
		},
		target: provider.encodeTarget({
			accountId: 'acc-1',
			apiToken: 'tok-1',
			propustkaUrl: 'https://iam.example.com',
			adminKey: 'px_admin',
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
	rec = { commands: [], provisions: [], schemas: [], schemaSignals: [], logs: [], provisionedVars: [], applicationVars: [] }
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
		expect(rec.schemas).toEqual([{ url: 'https://iam.example.com', app: 'demo', adminKey: 'px_admin' }])
		expect(rec.schemaSignals).toEqual([controller.signal])
	})

	test('carries the control plane return origins alongside the schema, never inside it', async () => {
		const schema = { scopes: [], actions: [], roles: {} }
		const session = await open(rec, config({ schema }), { returnOrigins: ['https://demo.example.com', 'https://stage.demo.example.com'] })
		await session.execute('reconcile-schema')

		expect(rec.schemas).toEqual([{
			url: 'https://iam.example.com',
			app: 'demo',
			adminKey: 'px_admin',
			returnOrigins: ['https://demo.example.com', 'https://stage.demo.example.com'],
		}])
	})

	test('a run with no return origins leaves the registry alone', async () => {
		const session = await open(rec, config({ schema: { scopes: [], actions: [], roles: {} } }))
		await session.execute('reconcile-schema')

		expect(rec.schemas).toHaveLength(1)
		expect(rec.schemas[0]?.returnOrigins).toBeUndefined()
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
		expect(rec.schemas).toHaveLength(0)
		expect(rec.logs.some((line) => line.includes('would run build'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('wrangler secret put API_KEY'))).toBe(true)
	})

	test('fails closed when the loaded config belongs to another app', async () => {
		expect(open(rec, config({ id: 'other' }))).rejects.toThrow('declares app "other", expected "demo"')
	})

	test('honours an already-aborted run before the first mutation', async () => {
		const session = await open(rec, config(), { signal: AbortSignal.abort() })
		expect(session.execute('provision-resources')).rejects.toThrow('deploy cancelled')
		expect(rec.provisions).toHaveLength(0)
	})

	test('propagates cancellation into an active schema reconciliation', async () => {
		const controller = new AbortController()
		const started = Promise.withResolvers<void>()
		const session = await open(rec, config({ schema: { scopes: [], actions: [], roles: {} } }), {
			signal: controller.signal,
			reconcileSchema: (input) =>
				new Promise<void>((_resolve, reject) => {
					const abort = (): void => {
						reject(input.signal.reason)
					}
					if (input.signal.aborted) {
						abort()
						return
					}
					input.signal.addEventListener('abort', abort, { once: true })
					started.resolve()
				}),
		})

		const reconciliation = session.execute('reconcile-schema')
		await started.promise
		controller.abort()

		const error = await reconciliation.catch((reason: unknown) => reason)
		expect(error).toBe(controller.signal.reason)
		expect(rec.schemaSignals).toEqual([controller.signal])
	})

	test('reports shell failures without leaking beyond the bounded command detail', async () => {
		const session = await open(rec, config(), {
			commandResult: (spec) =>
				spec.command === 'wrangler'
					? { exitCode: 1, stdout: '', stderr: 'deploy failed' }
					: { exitCode: 0, stdout: '', stderr: '' },
		})
		await session.execute('provision-resources')
		expect(session.execute('deploy-worker')).rejects.toThrow('wrangler deploy failed (exit 1): deploy failed')
	})
})
