import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { type CloudflareAppConfig, D1Database, Queue, R2Bucket, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
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

function application(worker: Worker): Worker {
	const value = binding(worker, 'APP')
	if (!(value instanceof Worker)) throw new Error('expected proxy APP Worker binding')
	return value
}

describe('defineApp(vozka config)', () => {
	test('exports a valid AppConfig with id `vozka` and a resources builder', () => {
		expect(config.id).toBe(VOZKA_APP_ID)
		expect(config.id).toBe('vozka')
		expect(typeof config.resources).toBe('function')
	})

	test('the resource graph puts a public proxy in front of the full vozka app Worker', () => {
		const worker: Worker = config.resources({ env: 'stage', domain: 'vozka.test.example.com' })
		expect(worker.options.name).toBe('vozka-proxy')
		expect(worker.options.main).toBe('./proxy-worker.ts')
		expect(worker.options.routes).toEqual([{ pattern: 'vozka.test.example.com', custom_domain: true }])
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		const app = application(worker)
		expect(app.options.name).toBe('vozka')
		expect(app.options.main).toBe('./src/index.ts')
		expect(app.options.routes).toEqual([])
		expect(app.options.workers_dev).toBe(false)

		// The deploy executor is a SEPARATE worker (vozka-runner): fabrika binds it as a SERVICE, not a
		// Container — so a deploy of fabrika never resets the container running it. No Container here anymore.
		expect(binding(app, 'RUNNER_SVC')).toBeInstanceOf(ServiceReference)
		expect(binding(app, 'RUNNER')).toBeUndefined()
		expect(binding(app, 'RUN_LOGS')).toBeInstanceOf(R2Bucket)
		expect(binding(app, 'DB')).toBeInstanceOf(D1Database)
		expect(binding(app, 'DEPLOY_QUEUE')).toBeInstanceOf(Queue)
		// Off-local stages bind the propustka IAM ServiceReference.
		expect(binding(app, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(binding(app, 'OPERATIONS')).toBeInstanceOf(ServiceReference)
	})

	test('DB declares migrations (drives a migrate step) and the assets SPA is the dashboard dist', () => {
		const worker = application(config.resources({ env: 'stage' }))
		const db = binding(worker, 'DB')
		expect(db).toBeInstanceOf(D1Database)
		if (db instanceof D1Database) {
			expect(db.options.migrationsDir).toBe('./migrations')
			expect(db.options.name).toBe('vozka')
		}
		expect(worker.options.assets?.binding).toBe('ASSETS')
		expect(worker.options.assets?.directory).toBe('../dashboard/dist')
	})

	test('IAM is bound locally too, with a resolvable issuer — the app has no local mode to fall back on', () => {
		const proxy = buildControlWorker({ env: 'local' })
		expect(binding(proxy, 'IAM')).toBeInstanceOf(ServiceReference)
		const worker = application(proxy)
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(worker.options.vars?.['FABRIKA_IAM_URL']).toBe('http://localhost:18191')
		// Operations and vozka-runner stay off-local (no container deploys in dev).
		expect(binding(worker, 'OPERATIONS')).toBeUndefined()
		expect(binding(worker, 'RUNNER_SVC')).toBeUndefined()
	})

	test('domain from ctx flows into the FABRIKA_CONTROL_DOMAIN var', () => {
		const worker = application(config.resources({ env: 'stage', domain: 'vozka.test.example.com' }))
		expect(worker.options.vars?.['FABRIKA_CONTROL_DOMAIN']).toBe('vozka.test.example.com')
		expect(worker.options.vars?.['VOZKA_DOMAIN']).toBeUndefined()
		expect(worker.options.vars?.['ENVIRONMENT']).toBe('stage')
	})

	test('canonical IAM and bootstrap values win over deprecated aliases', () => {
		process.env['FABRIKA_IAM_URL'] = 'https://iam.example.test'
		process.env['PROPUSTKA_URL'] = 'https://legacy-iam.example.test'
		process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'] = '["canonical@example.test"]'
		process.env['VOZKA_BOOTSTRAP_ADMINS'] = '["legacy@example.test"]'
		try {
			const worker = application(buildControlWorker({ env: 'stage' }))
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
		expect(application(buildControlWorker({ env: 'stage' })).options.vars?.['OPERATIONS_ARTIFACT_ORIGIN']).toBeUndefined()
		process.env['OPERATIONS_ARTIFACT_ORIGIN'] = 'https://errors.example.test'
		expect(application(buildControlWorker({ env: 'stage' })).options.vars?.['OPERATIONS_ARTIFACT_ORIGIN']).toBe('https://errors.example.test')
		delete process.env['OPERATIONS_ARTIFACT_ORIGIN']
	})
})

// The proxy owns the public route and evaluates path gates. The app keeps the IAM middleware as
// defence in depth for the shared Worker runtime.

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
