import type { AppConfig, AppSchema } from '@fabrika/config'
import { D1Database, Worker } from '@fabrika/config'
import { beforeEach, describe, expect, test } from 'bun:test'
import { deploy, type DeployOptions } from '../deploy'
import { createCloudflareDriver } from '../drivers/cloudflare'
import type { CloudflareCollaborators, CommandResult, CommandSpec, ProvisionInput } from '../drivers/cloudflare/collaborators'
import type { CloudflareTarget, DeployContext } from '../types'

// The Cloudflare driver routes EVERY side effect through its OWN collaborator bundle, and the engine
// routes progress through the run's neutral `log`. The tests construct the driver over a recording
// fake so we can assert which collaborator each step called, with what args, in what order — no
// process spawned, no oblaka, no propustka, no network.

interface Recorded {
	commands: CommandSpec[]
	provisions: ProvisionInput[]
	schemas: Array<{ url: string; app: string; schema: AppSchema; adminKey?: string }>
	logs: string[]
}

interface Overrides {
	commandResult?: (spec: CommandSpec) => CommandResult
	failProvision?: boolean
	/** Called before each recorded command resolves — lets a test cancel mid-step. */
	onCommand?: (spec: CommandSpec) => void
	signal?: AbortSignal
}

/** Recording collaborators whose commands succeed by default; per-test overrides flip one to fail. */
const makeCollaborators = (rec: Recorded, overrides: Overrides = {}): CloudflareCollaborators => ({
	runCommand: async (spec) => {
		rec.commands.push(spec)
		overrides.onCommand?.(spec)
		return overrides.commandResult?.(spec) ?? { exitCode: 0, stdout: '', stderr: '' }
	},
	provision: async (input) => {
		rec.provisions.push(input)
		if (overrides.failProvision) {
			throw new Error('oblaka boom')
		}
		return {
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-app` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-app` },
		}
	},
	reconcileSchema: async (input) => {
		rec.schemas.push(input)
	},
})

/** `deploy()`'s options for a test: the recording log sink + a Cloudflare driver over recording fakes. */
const makeOptions = (rec: Recorded, overrides: Overrides = {}): DeployOptions => ({
	log: (line) => {
		rec.logs.push(line)
	},
	drivers: { cloudflare: createCloudflareDriver(makeCollaborators(rec, overrides)) },
	...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
})

const fresh = (): Recorded => ({ commands: [], provisions: [], schemas: [], logs: [] })

const SCHEMA: AppSchema = { scopes: [], actions: [], roles: {} }

/** Build a config; by default the simplest possible app (just resources). */
const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
	id: 'demo',
	resources: () => new Worker({ dir: '.', name: 'demo', compatibility_flags: ['nodejs_compat'], bindings: {}, main: 'src/index.ts' }),
	...overrides,
})

/** Build a Cloudflare target; creds always present, state namespace per test. */
const makeTarget = (overrides: Partial<CloudflareTarget> = {}): CloudflareTarget => ({
	platform: 'cloudflare',
	accountId: 'acc-1',
	apiToken: 'tok-1',
	...overrides,
})

/** Build a context; the target is Cloudflare with creds, propustka/dryRun per test. */
const makeCtx = (overrides: Partial<DeployContext<CloudflareTarget>> = {}): DeployContext<CloudflareTarget> => ({
	env: 'stage',
	target: makeTarget(),
	secrets: {},
	cwd: '/work',
	...overrides,
})

let rec: Recorded
beforeEach(() => {
	rec = fresh()
})

describe('plan derivation', () => {
	test('minimal config: provision-resources then deploy-worker', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker'])
	})

	test('build step only when pipeline.build is set', async () => {
		const result = await deploy(makeConfig({ pipeline: { build: 'bun run build' } }), makeCtx(), makeOptions(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual(['build', 'provision-resources', 'deploy-worker'])
	})

	test('migrate step per D1 database that declares migrations', async () => {
		const config = makeConfig({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: {
						DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }),
						CACHE: new D1Database({ name: 'cache' }), // no migrationsDir → no migrate step
					},
				}),
		})
		const result = await deploy(config, makeCtx(), makeOptions(rec))
		expect(result.plan.steps.map((s) => s.id)).toEqual(['provision-resources', 'migrate:DB', 'deploy-worker'])
	})

	test('reconcile-schema only with both the schema declaration AND propustkaUrl', async () => {
		const config = makeConfig({ schema: SCHEMA })

		const withoutUrl = await deploy(config, makeCtx(), makeOptions(fresh()))
		expect(withoutUrl.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker'])

		const withUrl = await deploy(config, makeCtx({ propustkaUrl: 'https://iam.example.com' }), makeOptions(rec))
		expect(withUrl.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker', 'reconcile-schema'])
	})

	test('sync-secrets only when pipeline.secrets is non-empty', async () => {
		const empty = await deploy(makeConfig({ pipeline: { secrets: [] } }), makeCtx(), makeOptions(fresh()))
		expect(empty.plan.steps.map((s) => s.kind)).not.toContain('sync-secrets')

		const some = await deploy(makeConfig({ pipeline: { secrets: ['API_KEY'] } }), makeCtx({ secrets: { API_KEY: 'x' } }), makeOptions(rec))
		expect(some.plan.steps.map((s) => s.kind)).toContain('sync-secrets')
	})

	test('full config keeps the canonical order', async () => {
		const config = makeConfig({
			schema: SCHEMA,
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com', secrets: { API_KEY: 'x' } })
		const result = await deploy(config, ctx, makeOptions(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual([
			'build',
			'provision-resources',
			'migrate',
			'deploy-worker',
			'reconcile-schema',
			'sync-secrets',
		])
		// dependsOn chains each step to the previous one.
		expect(result.plan.steps[0]?.dependsOn).toBeUndefined()
		expect(result.plan.steps[1]?.dependsOn).toEqual(['build'])
		expect(result.plan.steps[3]?.dependsOn).toEqual(['migrate:DB'])
	})
})

describe('driver selection by the target discriminant', () => {
	test('a target whose platform has no registered driver fails loudly', async () => {
		const ctx: DeployContext = {
			env: 'stage',
			target: { platform: 'zerops', projectId: 'p1', serviceId: 's1', accessToken: 'zt-1' },
			secrets: {},
			cwd: '/work',
		}
		await expect(deploy(makeConfig(), ctx, makeOptions(rec))).rejects.toThrow('no driver registered for target platform `zerops`')
	})

	test('the registry entry for the target platform is what runs — the engine never inspects the target', async () => {
		const opened: string[] = []
		const options: DeployOptions = {
			log: () => {},
			drivers: {
				cloudflare: {
					id: 'cloudflare',
					open: (run) => {
						// The driver receives ITS OWN variant, already narrowed: `accountId` exists here.
						opened.push(run.ctx.target.accountId)
						return Promise.resolve({ plan: { appId: 'demo', env: 'stage', steps: [] }, execute: () => Promise.resolve() })
					},
				},
			},
		}
		const result = await deploy(makeConfig(), makeCtx(), options)
		expect(opened).toEqual(['acc-1'])
		expect(result.status).toBe('succeeded')
	})
})

describe('step execution — collaborators + args', () => {
	test('build runs pipeline.build in the worker dir', async () => {
		await deploy(makeConfig({ pipeline: { build: 'bun run build', workerDir: 'worker' } }), makeCtx(), makeOptions(rec))
		const build = rec.commands.find((c) => c.args.includes('bun run build'))
		expect(build).toBeDefined()
		expect(build?.command).toBe('sh')
		expect(build?.cwd).toBe('/work/worker')
	})

	test('provision calls oblaka with creds, env, remote (not dry-run) and worker dir', async () => {
		await deploy(makeConfig({ pipeline: { workerDir: 'worker' } }), makeCtx(), makeOptions(rec))
		expect(rec.provisions).toHaveLength(1)
		const p = rec.provisions[0]
		expect(p?.accountId).toBe('acc-1')
		expect(p?.apiToken).toBe('tok-1')
		expect(p?.env).toBe('stage')
		expect(p?.dryRun).toBe(false)
		expect(p?.cwd).toBe('/work/worker')
	})

	test('provision uses a per-app state namespace (`<id>-state`) so apps in one account never collide', async () => {
		await deploy(makeConfig({ id: 'poplach' }), makeCtx(), makeOptions(rec))
		expect(rec.provisions[0]?.stateNamespace).toBe('poplach-state')
	})

	test('target.stateNamespace overrides the derived default (for an app whose existing namespace differs)', async () => {
		await deploy(makeConfig({ id: 'poplach' }), makeCtx({ target: makeTarget({ stateNamespace: 'legacy-ns' }) }), makeOptions(rec))
		expect(rec.provisions[0]?.stateNamespace).toBe('legacy-ns')
	})

	test('migrate applies by the D1 BINDING (not the resource name) — `wrangler d1 migrations apply DB --remote`', async () => {
		const config = makeConfig({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		await deploy(config, makeCtx(), makeOptions(rec))
		const migrate = rec.commands.find((c) => c.args[0] === 'd1')
		expect(migrate?.command).toBe('wrangler')
		// Binding is `DB`, resource name is `maindb`; wrangler must get the BINDING — oblaka env-prefixes the
		// real database_name, so the resource name isn't in wrangler.jsonc, only the (env-stable) binding is.
		expect(migrate?.args).toEqual(['d1', 'migrations', 'apply', 'DB', '--remote'])
		expect(migrate?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
	})

	test('deploy-worker runs `wrangler deploy` with cred env in the worker dir', async () => {
		await deploy(makeConfig({ pipeline: { workerDir: 'worker' } }), makeCtx(), makeOptions(rec))
		const dep = rec.commands.find((c) => c.command === 'wrangler' && c.args[0] === 'deploy')
		expect(dep).toBeDefined()
		expect(dep?.cwd).toBe('/work/worker')
		expect(dep?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
	})

	test('reconcile passes propustka url, app id, schema and the admin key', async () => {
		const config = makeConfig({ schema: SCHEMA })
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com', adminKey: 'px_admin' })
		await deploy(config, ctx, makeOptions(rec))
		expect(rec.schemas).toEqual([{ url: 'https://iam.example.com', app: 'demo', schema: SCHEMA, adminKey: 'px_admin' }])
	})

	test('sync-secrets pipes each ctx.secrets value into `wrangler secret put <name>`', async () => {
		const config = makeConfig({ pipeline: { secrets: ['API_KEY', 'DB_URL'] } })
		const ctx = makeCtx({ secrets: { API_KEY: 'k1', DB_URL: 'u1' } })
		await deploy(config, ctx, makeOptions(rec))
		const puts = rec.commands.filter((c) => c.args[0] === 'secret')
		expect(puts).toHaveLength(2)
		expect(puts[0]?.args).toEqual(['secret', 'put', 'API_KEY'])
		expect(puts[0]?.stdin).toBe('k1')
		expect(puts[1]?.stdin).toBe('u1')
	})

	test('sync-secrets fails the step when a declared secret has no value', async () => {
		const config = makeConfig({ pipeline: { secrets: ['MISSING'] } })
		const result = await deploy(config, makeCtx({ secrets: {} }), makeOptions(rec))
		expect(result.status).toBe('failed')
		const step = result.steps.find((s) => s.spec.kind === 'sync-secrets')
		expect(step?.status).toBe('failed')
		expect(step?.error).toContain('MISSING')
	})
})

describe('status transitions + fail-stop', () => {
	test('all steps succeed → status succeeded, every step succeeded with timing', async () => {
		const result = await deploy(makeConfig({ pipeline: { build: 'bun run build' } }), makeCtx(), makeOptions(rec))
		expect(result.status).toBe('succeeded')
		for (const step of result.steps) {
			expect(step.status).toBe('succeeded')
			expect(typeof step.startedAt).toBe('number')
			expect(typeof step.finishedAt).toBe('number')
		}
	})

	test('a failing command fails its step, marks the rest skipped, and overall failed', async () => {
		const config = makeConfig({ schema: SCHEMA, pipeline: { build: 'bun run build' } })
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com' })
		// Make the build command fail.
		const options = makeOptions(rec, {
			commandResult: (
				spec,
			) => (spec.args.includes('bun run build') ? { exitCode: 1, stdout: '', stderr: 'build error' } : { exitCode: 0, stdout: '', stderr: '' }),
		})
		const result = await deploy(config, ctx, options)

		expect(result.status).toBe('failed')
		const byKind = Object.fromEntries(result.steps.map((s) => [s.spec.kind, s.status]))
		expect(byKind['build']).toBe('failed')
		expect(byKind['provision-resources']).toBe('skipped')
		expect(byKind['deploy-worker']).toBe('skipped')
		expect(byKind['reconcile-schema']).toBe('skipped')
		// No collaborator past the failure ran.
		expect(rec.provisions).toHaveLength(0)
		expect(rec.schemas).toHaveLength(0)
		const buildStep = result.steps.find((s) => s.spec.kind === 'build')
		expect(buildStep?.error).toContain('build error')
	})

	test('a throwing collaborator (oblaka) fails the step and stops the run', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec, { failProvision: true }))
		expect(result.status).toBe('failed')
		const provision = result.steps.find((s) => s.spec.kind === 'provision-resources')
		expect(provision?.status).toBe('failed')
		expect(provision?.error).toContain('oblaka boom')
		expect(result.steps.find((s) => s.spec.kind === 'deploy-worker')?.status).toBe('skipped')
	})
})

describe('cancellation', () => {
	/** A config whose plan is build → provision → deploy-worker, so there is a step before and after. */
	const cancellable = (): AppConfig => makeConfig({ pipeline: { build: 'bun run build' } })

	test('a run cancelled MID-STEP abandons that step and skips the rest', async () => {
		const controller = new AbortController()
		const options = makeOptions(rec, {
			signal: controller.signal,
			// Cancel while the build command is in flight.
			onCommand: (spec) => {
				if (spec.args.includes('bun run build')) {
					controller.abort()
				}
			},
		})
		const result = await deploy(cancellable(), makeCtx(), options)

		expect(result.status).toBe('failed')
		const byKind = Object.fromEntries(result.steps.map((s) => [s.spec.kind, s.status]))
		expect(byKind['build']).toBe('failed')
		expect(byKind['provision-resources']).toBe('skipped')
		expect(byKind['deploy-worker']).toBe('skipped')
		expect(result.steps.find((s) => s.spec.kind === 'build')?.error).toBe('deploy cancelled')
		// Nothing past the cancellation ran.
		expect(rec.provisions).toHaveLength(0)
	})

	test('steps that already finished keep their outcome; only the in-flight one is abandoned', async () => {
		const controller = new AbortController()
		const options = makeOptions(rec, {
			signal: controller.signal,
			// Cancel once the run reaches the LAST step, after build + provision have succeeded.
			onCommand: (spec) => {
				if (spec.args[0] === 'deploy') {
					controller.abort()
				}
			},
		})
		const result = await deploy(
			makeConfig({ pipeline: { build: 'bun run build', secrets: ['API_KEY'] } }),
			makeCtx({ secrets: { API_KEY: 'k' } }),
			options,
		)

		expect(result.status).toBe('failed')
		const byKind = Object.fromEntries(result.steps.map((s) => [s.spec.kind, s.status]))
		expect(byKind['build']).toBe('succeeded')
		expect(byKind['provision-resources']).toBe('succeeded')
		expect(byKind['deploy-worker']).toBe('failed')
		expect(byKind['sync-secrets']).toBe('skipped')
		// The step after the cancellation never reached its collaborator.
		expect(rec.commands.some((c) => c.args[0] === 'secret')).toBe(false)
	})

	test('an already-cancelled signal runs nothing at all', async () => {
		const result = await deploy(cancellable(), makeCtx(), makeOptions(rec, { signal: AbortSignal.abort() }))
		expect(result.status).toBe('failed')
		expect(result.steps.every((s) => s.status === 'skipped')).toBe(true)
		expect(rec.commands).toHaveLength(0)
		expect(rec.provisions).toHaveLength(0)
	})

	test('a signal that never fires leaves the run untouched', async () => {
		const controller = new AbortController()
		const result = await deploy(cancellable(), makeCtx(), makeOptions(rec, { signal: controller.signal }))
		expect(result.status).toBe('succeeded')
	})

	test('the Cloudflare driver hands the run signal to every child it spawns, so the process is killed', async () => {
		const controller = new AbortController()
		await deploy(cancellable(), makeCtx(), makeOptions(rec, { signal: controller.signal }))
		expect(rec.commands.length).toBeGreaterThan(0)
		for (const command of rec.commands) {
			expect(command.signal).toBe(controller.signal)
		}
	})
})

describe('pipeline.vars — non-secret deploy vars injected into process.env', () => {
	test('each declared var is injected into process.env before resources() materializes', async () => {
		const config = makeConfig({
			pipeline: { vars: ['MY_DEPLOY_VAR'] },
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: {},
					// The config reads the injected var the same way a migrated oblaka.ts does.
					vars: { FROM_ENV: process.env['MY_DEPLOY_VAR'] ?? '(unset)' },
				}),
		})
		const result = await deploy(config, makeCtx({ vars: { MY_DEPLOY_VAR: 'injected-value' } }), makeOptions(rec))
		expect(result.status).toBe('succeeded')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspecting the recorded oblaka Worker
		expect((rec.provisions[0]?.definition as unknown as { options: { vars: Record<string, string> } }).options.vars.FROM_ENV).toBe('injected-value')
		delete process.env['MY_DEPLOY_VAR']
	})

	test('a declared var with no resolved value is a hard error before any provision', async () => {
		const config = makeConfig({ pipeline: { vars: ['MISSING_VAR'] } })
		await expect(deploy(config, makeCtx({ vars: {} }), makeOptions(rec))).rejects.toThrow('MISSING_VAR')
		expect(rec.provisions).toHaveLength(0)
	})
})

describe('dry-run', () => {
	test('runs oblaka in plan-only mode and skips every real mutation', async () => {
		const config = makeConfig({
			schema: SCHEMA,
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		const ctx = makeCtx({ dryRun: true, propustkaUrl: 'https://iam.example.com', secrets: { API_KEY: 'x' } })
		const result = await deploy(config, ctx, makeOptions(rec))

		expect(result.status).toBe('succeeded')
		// oblaka still runs — in dry-run mode.
		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.dryRun).toBe(true)
		// No build / wrangler / secret commands and no real reconcile.
		expect(rec.commands).toHaveLength(0)
		expect(rec.schemas).toHaveLength(0)
		// Each skipped mutation logged a `[dry-run]` line.
		const dryLines = rec.logs.filter((l) => l.includes('[dry-run]'))
		expect(dryLines.length).toBeGreaterThanOrEqual(4)
	})
})
