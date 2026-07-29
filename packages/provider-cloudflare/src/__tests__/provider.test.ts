import { beforeEach, describe, expect, test } from 'bun:test'
import { D1Database, Worker } from 'oblaka-iac'
import type { CloudflareAppConfig, CloudflareCollaborators, CommandResult, CommandSpec, ProvisionInput } from '..'
import { cloudflareArtifact, createCloudflareProvider } from '..'

interface Recorded {
	readonly commands: CommandSpec[]
	readonly provisions: ProvisionInput[]
	readonly schemas: Array<{ url: string; app: string; adminKey?: string }>
	readonly logs: string[]
}

const config = (overrides: Partial<CloudflareAppConfig> = {}): CloudflareAppConfig => ({
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
		return {
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-demo` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-demo` },
		}
	},
	reconcileSchema: async (input) => {
		rec.schemas.push({ url: input.url, app: input.app, adminKey: input.adminKey })
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
	} = {},
) => {
	const provider = createCloudflareProvider(makeCollaborators(rec, appConfig, options.commandResult))
	return provider.runtime.open({
		appId: options.appId ?? 'demo',
		env: 'stage',
		domain: 'stage.example.com',
		cwd: '/repo',
		secrets: options.secrets ?? {},
		vars: {},
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
	rec = { commands: [], provisions: [], schemas: [], logs: [] }
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
		const app = config({
			schema: { scopes: [], actions: [], roles: {} },
			pipeline: { workerDir: 'worker', build: 'bun run build', secrets: ['API_KEY'] },
		})
		const session = await open(rec, app, { secrets: { API_KEY: 'secret-value' } })
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
