import { CONTROL_ACTIONS, CONTROL_APP_ID, CONTROL_SCOPES } from '@fabrika/control-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { type CloudflareAppConfig, D1Database, Queue, R2Bucket, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
import { beforeAll, describe, expect, test } from 'bun:test'
import type {
	buildControlWorker as BuildControlWorker,
	controlEmailSecrets as ControlEmailSecrets,
	controlEmailVars as ControlEmailVars,
	controlPipelineSecrets as ControlPipelineSecrets,
} from '../../fabrika.config'

// fabrika's OWN deploy surface (packages/control/fabrika.config.ts). These
// tests prove: defineApp accepts fabrika's config, the resource graph materializes with fabrika's full
// binding set, the Access carve-out is PUBLIC for ONLY the webhook route, and the authz schema's
// actions/scopes match `@fabrika/control-contract` exactly (no drift between declaration and enforcement).

// fabrika.config materializes its resource graph from FABRIKA_CONTROL_DOMAIN. Set a real
// unset — it must NOT throw, since the local-dev oblaka shim imports it without a domain). Set a real
// domain here so the destination assertions below are deterministic, then load the module.
let config: CloudflareAppConfig
let buildControlWorker: typeof BuildControlWorker
let controlEmailVars: typeof ControlEmailVars
let controlEmailSecrets: typeof ControlEmailSecrets
let controlPipelineSecrets: typeof ControlPipelineSecrets

beforeAll(async () => {
	process.env['FABRIKA_CONTROL_DOMAIN'] = 'vozka.test.example.com'
	const mod = await import('../../fabrika.config')
	config = mod.default
	buildControlWorker = mod.buildControlWorker
	controlEmailVars = mod.controlEmailVars
	controlEmailSecrets = mod.controlEmailSecrets
	controlPipelineSecrets = mod.controlPipelineSecrets
})

/** Run `body` with `values` in process.env, then put back what was there before, set or not. */
function withEnvironment(values: Readonly<Record<string, string>>, body: () => void): void {
	const before = Object.keys(values).map((name): [string, string | undefined] => [name, process.env[name]])
	Object.assign(process.env, values)
	try {
		body()
	} finally {
		for (const [name, value] of before) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

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
		expect(config.id).toBe(CONTROL_APP_ID)
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
		expect(worker.options.vars?.['FABRIKA_IAM_ISSUER']).toBe('http://localhost:18191')
		// Operations and vozka-runner stay off-local (no container deploys in dev).
		expect(binding(worker, 'OPERATIONS')).toBeUndefined()
		expect(binding(worker, 'RUNNER_SVC')).toBeUndefined()
	})

	test('domain from ctx flows into the FABRIKA_CONTROL_DOMAIN var', () => {
		const worker = application(config.resources({ env: 'stage', domain: 'vozka.test.example.com' }))
		expect(worker.options.vars?.['FABRIKA_CONTROL_DOMAIN']).toBe('vozka.test.example.com')
		expect(worker.options.vars?.['ENVIRONMENT']).toBe('stage')
	})

	test('the IAM issuer and the bootstrap-admin list ride as canonical vars', () => {
		process.env['FABRIKA_IAM_ISSUER'] = 'https://iam.example.test'
		process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'] = '["canonical@example.test"]'
		try {
			const worker = application(buildControlWorker({ env: 'stage' }))
			expect(worker.options.vars?.['FABRIKA_IAM_ISSUER']).toBe('https://iam.example.test')
			expect(worker.options.vars?.['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']).toBe('["canonical@example.test"]')
		} finally {
			delete process.env['FABRIKA_IAM_ISSUER']
			delete process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']
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

describe("the installation's mail transport", () => {
	const resend = {
		FABRIKA_EMAIL_PROVIDER: 'resend',
		FABRIKA_EMAIL_FROM: 'Fabrika <mail@example.test>',
		FABRIKA_EMAIL_RESEND_API_KEY: 're_private-key',
	}
	const ahasend = {
		FABRIKA_EMAIL_PROVIDER: 'ahasend',
		FABRIKA_EMAIL_FROM: 'mail@example.test',
		FABRIKA_EMAIL_FROM_NAME: 'Fabrika',
		FABRIKA_EMAIL_AHASEND_API_KEY: 'aha_private-key',
		FABRIKA_EMAIL_AHASEND_ACCOUNT_ID: 'account-1',
		// Another provider's leftover: never read, never written.
		FABRIKA_EMAIL_RESEND_API_KEY: 're_stale-key',
	}

	test('the sender and the non-secret variables ride as vars; the credentials are Worker secrets only', () => {
		expect(controlEmailVars(false, resend)).toEqual({ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'Fabrika <mail@example.test>' })
		expect(controlEmailSecrets(resend)).toEqual(['FABRIKA_EMAIL_RESEND_API_KEY'])
		expect(controlEmailVars(false, ahasend)).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'ahasend',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_FROM_NAME: 'Fabrika',
			FABRIKA_EMAIL_AHASEND_ACCOUNT_ID: 'account-1',
		})
		expect(controlEmailSecrets(ahasend)).toEqual(['FABRIKA_EMAIL_AHASEND_API_KEY'])
	})

	test('no provider, or one passed empty by the workflow, is an explicit none with no secret', () => {
		for (const source of [{}, { FABRIKA_EMAIL_PROVIDER: 'none' }, { FABRIKA_EMAIL_PROVIDER: '', FABRIKA_EMAIL_RESEND_API_KEY: '' }]) {
			expect(controlEmailVars(false, source)).toEqual({ FABRIKA_EMAIL_PROVIDER: 'none' })
			expect(controlEmailSecrets(source)).toEqual([])
		}
	})

	test('a local Worker gets no transport, whatever the shell holds', () => {
		expect(controlEmailVars(true, resend)).toEqual({})
		// The local stack's capture provider is no built-in one; locally it is never checked.
		expect(controlEmailVars(true, { FABRIKA_EMAIL_PROVIDER: 'directory' })).toEqual({})
	})

	test('the pipeline secrets are read at import and never throw: an invalid set names no secret', () => {
		expect(controlEmailSecrets({ FABRIKA_EMAIL_PROVIDER: 'directory' })).toEqual([])
		expect(controlEmailSecrets({ FABRIKA_EMAIL_PROVIDER: 'resend' })).toEqual([])
		expect(controlEmailSecrets({ ...resend, FABRIKA_EMAIL_PROVIDER: 'smtp' })).toEqual([])
	})

	test("the deploy writes a valid provider's credential as a Worker secret, and no other", () => {
		const base = ['FABRIKA_CONTROL_VAULT_KEY', 'CLOUDFLARE_API_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY', 'FABRIKA_RUNNER_KEY', 'OPERATIONS_SYNC_KEY']
		expect(controlPipelineSecrets(resend)).toEqual([...base, 'FABRIKA_EMAIL_RESEND_API_KEY'])
		expect(controlPipelineSecrets(ahasend)).toEqual([...base, 'FABRIKA_EMAIL_AHASEND_API_KEY'])
		expect(controlPipelineSecrets({ FABRIKA_EMAIL_PROVIDER: 'none' })).toEqual(base)
		expect(controlPipelineSecrets({})).toEqual(base)
		// The exported config declares the list its import-time environment gives.
		expect(config.pipeline?.secrets).toEqual(controlPipelineSecrets(process.env))
	})

	test('an invalid set refuses the deploy when the resource graph is built, naming variables and never a value', () => {
		const { FABRIKA_EMAIL_RESEND_API_KEY: _key, ...noKey } = resend
		expect(() => controlEmailVars(false, noKey)).toThrow('FABRIKA_EMAIL_RESEND_API_KEY is missing')
		expect(() => controlEmailVars(false, { ...resend, FABRIKA_EMAIL_PROVIDER: 'smtp' })).toThrow('FABRIKA_EMAIL_PROVIDER must be none or one of')
		expect(() => controlEmailVars(false, { ...resend, FABRIKA_EMAIL_FROM: 'not an address' })).toThrow(/FABRIKA_EMAIL_FROM is invalid/)
		try {
			controlEmailVars(false, { ...resend, FABRIKA_EMAIL_FROM: 'not an address' })
		} catch (error) {
			expect(String(error)).not.toContain('re_private-key')
		}
	})

	test("the Worker's vars carry the transport the deploy environment holds", () => {
		withEnvironment(resend, () => {
			const vars = application(buildControlWorker({ env: 'stage' })).options.vars ?? {}
			expect(vars['FABRIKA_EMAIL_PROVIDER']).toBe('resend')
			expect(vars['FABRIKA_EMAIL_FROM']).toBe('Fabrika <mail@example.test>')
			expect(vars['FABRIKA_EMAIL_RESEND_API_KEY']).toBeUndefined()
			expect(application(buildControlWorker({ env: 'local' })).options.vars?.['FABRIKA_EMAIL_PROVIDER']).toBeUndefined()
		})
		withEnvironment({ FABRIKA_EMAIL_PROVIDER: 'none' }, () => {
			expect(application(buildControlWorker({ env: 'stage' })).options.vars?.['FABRIKA_EMAIL_PROVIDER']).toBe('none')
		})
	})
})

// The proxy owns the public route and decides the endpoint table. The app keeps the IAM middleware as
// defence in depth for the shared Worker runtime.

describe('Schema actions/scopes match the contract (no drift)', () => {
	test('the schema action catalog is exactly the action constants', () => {
		const declared = (config.schema?.actions ?? []).map((a) => a.action).sort()
		const fromActions = [...Object.values(CONTROL_ACTIONS), ...Object.values(OPERATIONS_ACTIONS)].sort()
		expect(declared).toEqual(fromActions)
	})

	test('the scope dimensions are exactly the CONTROL_SCOPES constants', () => {
		const declared = (config.schema?.scopes ?? []).map((s) => s.type).sort()
		expect(declared).toEqual([CONTROL_SCOPES.APP, CONTROL_SCOPES.ENVIRONMENT].sort())
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
		expect(config.pipeline?.secrets?.slice(0, 5)).toEqual([
			'FABRIKA_CONTROL_VAULT_KEY',
			'CLOUDFLARE_API_TOKEN',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_RUNNER_KEY',
			'OPERATIONS_SYNC_KEY',
		])
	})
})
