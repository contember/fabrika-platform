import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { type CloudflareAppConfig, D1Database, Queue, R2Bucket, ServiceReference, type Worker } from '@fabrika/provider-cloudflare'
import { beforeAll, describe, expect, test } from 'bun:test'
import type { buildControlWorker as BuildControlWorker } from '../../fabrika.config'
import { ACTIONS, SCOPES, VOZKA_APP_ID } from '../actions'

// fabrika's OWN deploy surface (packages/control/fabrika.config.ts). These
// tests prove: defineApp accepts fabrika's config, the resource graph materializes with fabrika's full
// binding set, the Access carve-out is PUBLIC for ONLY the webhook route, and the authz schema's
// actions/scopes match src/actions.ts exactly (no drift between declaration and enforcement).

// fabrika.config materializes its resource graph from FABRIKA_CONTROL_DOMAIN. Set a real
// unset — it must NOT throw, since the local-dev oblaka shim imports it without a domain). Set a real
// domain here so the destination assertions below are deterministic, then load the module.
let config: CloudflareAppConfig
let buildControlWorker: typeof BuildControlWorker

beforeAll(async () => {
	process.env['FABRIKA_CONTROL_DOMAIN'] = 'vozka.test.example.com'
	const mod = await import('../../fabrika.config')
	config = mod.default
	buildControlWorker = mod.buildControlWorker
})

/** Resolve a Worker binding by name (oblaka exposes the materialized graph on `worker.options`). */
function binding(worker: Worker, name: string): unknown {
	return worker.options.bindings?.[name]
}

describe('defineApp(vozka config)', () => {
	test('exports a valid AppConfig with id `vozka` and a resources builder', () => {
		expect(config.id).toBe(VOZKA_APP_ID)
		expect(config.id).toBe('vozka')
		expect(typeof config.resources).toBe('function')
	})

	test('the resource graph builds vozka full binding set (RUNNER_SVC/R2/D1/Queue + IAM off-local)', () => {
		const worker: Worker = config.resources({ env: 'stage', domain: 'vozka.test.example.com' })
		expect(worker.options.name).toBe('vozka')
		expect(worker.options.main).toBe('./src/index.ts')

		// The deploy executor is a SEPARATE worker (vozka-runner): fabrika binds it as a SERVICE, not a
		// Container — so a deploy of fabrika never resets the container running it. No Container here anymore.
		expect(binding(worker, 'RUNNER_SVC')).toBeInstanceOf(ServiceReference)
		expect(binding(worker, 'RUNNER')).toBeUndefined()
		expect(binding(worker, 'RUN_LOGS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
		expect(binding(worker, 'DEPLOY_QUEUE')).toBeInstanceOf(Queue)
		// Off-local stages bind the propustka IAM ServiceReference.
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(binding(worker, 'OPERATIONS')).toBeInstanceOf(ServiceReference)
	})

	test('DB declares migrations (drives a migrate step) and the assets SPA is the dashboard dist', () => {
		const worker = config.resources({ env: 'stage' })
		const db = binding(worker, 'DB')
		expect(db).toBeInstanceOf(D1Database)
		if (db instanceof D1Database) {
			expect(db.options.migrationsDir).toBe('./migrations')
			expect(db.options.name).toBe('vozka')
		}
		expect(worker.options.assets?.binding).toBe('ASSETS')
		expect(worker.options.assets?.directory).toBe('../dashboard/dist')
	})

	test('local omits the off-local service bindings (IAM + Operations + vozka-runner) and runs the FakeIamClient (DEV=true)', () => {
		const worker = buildControlWorker({ env: 'local' })
		expect(binding(worker, 'IAM')).toBeUndefined()
		expect(binding(worker, 'OPERATIONS')).toBeUndefined()
		expect(worker.options.vars?.['DEV']).toBe('true')
		// vozka-runner is an off-local service binding too — absent locally (no container deploys in dev).
		expect(binding(worker, 'RUNNER_SVC')).toBeUndefined()
	})

	test('domain from ctx flows into the FABRIKA_CONTROL_DOMAIN var; off-local DEV is empty', () => {
		const worker = config.resources({ env: 'stage', domain: 'vozka.test.example.com' })
		expect(worker.options.vars?.['FABRIKA_CONTROL_DOMAIN']).toBe('vozka.test.example.com')
		expect(worker.options.vars?.['VOZKA_DOMAIN']).toBeUndefined()
		expect(worker.options.vars?.['DEV']).toBe('')
		expect(worker.options.vars?.['ENVIRONMENT']).toBe('stage')
	})

	test('canonical IAM and bootstrap values win over deprecated aliases', () => {
		process.env['FABRIKA_IAM_URL'] = 'https://iam.example.test'
		process.env['PROPUSTKA_URL'] = 'https://legacy-iam.example.test'
		process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'] = '["canonical@example.test"]'
		process.env['VOZKA_BOOTSTRAP_ADMINS'] = '["legacy@example.test"]'
		try {
			const worker = buildControlWorker({ env: 'stage' })
			expect(worker.options.vars?.['FABRIKA_IAM_URL']).toBe('https://iam.example.test')
			expect(worker.options.vars?.['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']).toBe('["canonical@example.test"]')
			expect(worker.options.vars?.['PROPUSTKA_URL']).toBeUndefined()
			expect(worker.options.vars?.['VOZKA_BOOTSTRAP_ADMINS']).toBeUndefined()
		} finally {
			delete process.env['FABRIKA_IAM_URL']
			delete process.env['PROPUSTKA_URL']
			delete process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']
			delete process.env['VOZKA_BOOTSTRAP_ADMINS']
		}
	})

	test('the public artifact origin is propagated only when configured', () => {
		delete process.env['OPERATIONS_ARTIFACT_ORIGIN']
		expect(buildControlWorker({ env: 'stage' }).options.vars?.['OPERATIONS_ARTIFACT_ORIGIN']).toBeUndefined()
		process.env['OPERATIONS_ARTIFACT_ORIGIN'] = 'https://errors.example.test'
		expect(buildControlWorker({ env: 'stage' }).options.vars?.['OPERATIONS_ARTIFACT_ORIGIN']).toBe('https://errors.example.test')
		delete process.env['OPERATIONS_ARTIFACT_ORIGIN']
	})
})

// IAM is native — fabrika has no Cloudflare Access edge to declare. Its `/api/*` is gated
// in-process by IAM middleware (src/iam.ts), not via `config.access`.

describe('Schema actions/scopes match src/actions.ts (no drift)', () => {
	test('the schema action catalog is exactly the ACTIONS constants', () => {
		const declared = (config.schema?.actions ?? []).map((a) => a.action).sort()
		const fromActions = [...Object.values(ACTIONS), ...Object.values(OPERATIONS_ACTIONS)].sort()
		expect(declared).toEqual(fromActions)
	})

	test('the scope dimensions are exactly the SCOPES constants', () => {
		const declared = (config.schema?.scopes ?? []).map((s) => s.type).sort()
		expect(declared).toEqual([SCOPES.APP, SCOPES.ENVIRONMENT].sort())
	})

	test('roles: operator → deploy.* + operations.*, admin → *', () => {
		expect(config.schema?.roles['operator']?.permissions).toEqual(['deploy.*', 'operations.*'])
		expect(config.schema?.roles['admin']?.permissions).toEqual(['*'])
	})

	test('every role permission is `*` or matches an action prefix in the catalog', () => {
		const actions = (config.schema?.actions ?? []).map((a) => a.action)
		for (const role of Object.values(config.schema?.roles ?? {})) {
			for (const permission of role.permissions) {
				if (permission === '*') {
					continue
				}
				if (permission.endsWith('.*')) {
					const prefix = permission.slice(0, -1) // keep the trailing dot, e.g. `deploy.`
					expect(actions.some((a) => a.startsWith(prefix))).toBe(true)
					continue
				}
				expect(actions).toContain(permission)
			}
		}
	})
})

describe('Pipeline', () => {
	test('workerDir is the worker package, build builds the dashboard, secrets are the runtime worker secrets', () => {
		expect(config.pipeline?.workerDir).toBe('.')
		expect(config.pipeline?.build).toContain('@fabrika/dashboard')
		expect(config.pipeline?.secrets).toEqual([
			'FABRIKA_CONTROL_VAULT_KEY',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
			'CLOUDFLARE_API_TOKEN',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'OPERATIONS_SYNC_KEY',
		])
	})
})
