// `boot` reads the framework's variables and removes them, and refuses to start when anything declared cannot be
// served: a kind whose runtime is not built, a handler outside the contract, a missing handler.

import { defineContract } from '@fabrika/app/contract'
import { boot, BootError, captureEnvironment, type ContractImplementation, implement } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { notesApp } from './fixtures/implement/app'
import { echoAssets, environment, FRAMEWORK_ENV, keepingProcessEnvironment, keySource } from './fixtures/implement/harness'

function problemsOf(start: () => unknown): readonly string[] {
	try {
		start()
	} catch (error) {
		if (error instanceof BootError) {
			return error.problems
		}
		throw error
	}
	throw new Error('expected the application not to boot')
}

const Ok = z.strictObject({ ok: z.boolean() })
const ById = z.strictObject({ id: z.string() })

describe('the framework variables', () => {
	test('a missing app id and issuer stop the boot, both named', () => {
		const problems = problemsOf(() => boot(notesApp(new Map()), { environment: environment({}), iam: keySource, assets: echoAssets }))
		expect(problems.join('\n')).toContain('FABRIKA_IAM_APP_ID')
		expect(problems.join('\n')).toContain('FABRIKA_IAM_ISSUER')
	})

	test("FABRIKA_IAM_APP_ID must be <app>@<env> of the contract's application", () => {
		const start = (iamAppId: string) => () =>
			boot(notesApp(new Map()), { environment: environment({ ...FRAMEWORK_ENV, FABRIKA_IAM_APP_ID: iamAppId }), iam: keySource, assets: echoAssets })
		expect(problemsOf(start('notes'))).toEqual(["FABRIKA_IAM_APP_ID 'notes' is not an application environment id (allowed: <app>@<env>)"])
		expect(problemsOf(start('other@prod'))).toEqual(["FABRIKA_IAM_APP_ID names the application 'other', but the contract declares 'notes'"])
	})

	test('deps get the application variables only, never a FABRIKA_ name', () => {
		let seen: Readonly<Record<string, unknown>> = {}
		const base = notesApp(new Map())
		const app: ContractImplementation = {
			...base,
			handlers: (env, runtime) => {
				seen = env
				return base.handlers(env, runtime)
			},
		}
		const captured = environment({ ...FRAMEWORK_ENV, FABRIKA_TEST_SECRET: 'x', NOTES_API_URL: 'https://x.test' })
		boot(app, { environment: captured, iam: keySource, assets: echoAssets })
		expect(seen).toEqual({ NOTES_API_URL: 'https://x.test' })
	})
})

describe('captureEnvironment', () => {
	test('splits the variables and scrubs every FABRIKA_ name from process.env and Bun.env', async () => {
		await keepingProcessEnvironment(async () => {
			process.env['FABRIKA_TEST_SECRET'] = 'database-password'
			const captured = captureEnvironment({ FABRIKA_IAM_APP_ID: 'notes@prod', FABRIKA_TEST_SECRET: 'database-password', PORT: '3000' })
			expect(captured.framework).toEqual({ FABRIKA_IAM_APP_ID: 'notes@prod', FABRIKA_TEST_SECRET: 'database-password' })
			expect(captured.application).toEqual({ PORT: '3000' })
			expect(process.env['FABRIKA_TEST_SECRET']).toBeUndefined()
			expect(Bun.env['FABRIKA_TEST_SECRET']).toBeUndefined()
			expect(Object.isFrozen(captured.framework)).toBe(true)
		})
	})
})

describe('what this version does not serve yet stops the boot', () => {
	test('link mounts, creates, jobs and an SPA without assets', () => {
		const unserved = defineContract({
			app: 'notes',
			dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
			actions: { 'notes.read': 'Read', 'notes.share': 'Share', 'workspaces.create': 'Start' },
			roles: { owner: { grants: ['notes.read', 'notes.share'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				start: c.mutation({ output: Ok, access: { action: 'workspaces.create', creates: 'workspace' } }),
			}),
			shared: c.link('/s', {
				spa: 'dist/share',
				dimension: 'note',
				grants: ['notes.read'],
				issuedBy: 'notes.share',
				maxDays: 7,
				procedures: (l) => ({ note: l.query({ output: Ok, access: { action: 'notes.read' } }) }),
			}),
			spa: c.spa('/', { dir: 'dist/app', access: { member: true } }),
			jobs: { purge: c.cron('0 3 * * *', { actions: ['notes.read'], scope: 'app' }) },
		}))
		const app = implement(unserved, {
			database: null,
			deps: () => null,
			handlers: () => ({ api: { start: () => ({ ok: true }) }, shared: { note: () => ({ ok: true }) } }),
		})
		const problems = problemsOf(() => boot(app, { environment: environment(FRAMEWORK_ENV), iam: keySource }))
		expect(problems).toEqual([
			"mount 'shared' is a link mount, which this version of @fabrika/app does not serve yet",
			"mount 'spa' is an SPA, and the runtime adapter supplies no asset server",
			"jobs 'purge' is declared, and this version of @fabrika/app does not run jobs yet",
			"'api.start' creates a 'workspace', and this version cannot ask IAM for a new scope yet",
		])
	})
})

describe('an access form the framework cannot resolve stops the boot', () => {
	test('on, when no table owns the dimension', () => {
		const app: ContractImplementation = { ...notesApp(new Map()), database: null }
		expect(problemsOf(() => boot(app, { environment: environment(FRAMEWORK_ENV), iam: keySource, assets: echoAssets }))).toEqual([
			"'api.notes.get' acts on a 'note', but no table in src/db/tables.ts owns that dimension to locate it",
			"'api.notes.remove' acts on a 'note', but no table in src/db/tables.ts owns that dimension to locate it",
		])
	})
})

describe('the handler tree is checked again at boot', () => {
	const small = defineContract({
		app: 'notes',
		dimensions: { note: {} },
		actions: { 'notes.read': 'Read' },
		roles: { reader: { grants: ['notes.read'] } },
	}, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			get: c.query({ input: ById, output: Ok, access: { action: 'notes.read', in: 'note', from: 'id' } }),
		}),
	}))

	test('a handler outside the contract and a missing handler stop the boot', () => {
		const app: ContractImplementation = {
			contract: small,
			database: null,
			handlers: () => ({ api: { dump: () => ({ everything: true }) }, admin: { reset: () => null } }),
		}
		expect(problemsOf(() => boot(app, { environment: environment(FRAMEWORK_ENV), iam: keySource }))).toEqual([
			"procedure 'api.get' has no handler; add it to handlers",
			"handler 'api.dump' is not in the contract; declare the endpoint in fabrika.contract.ts first",
			"handler 'admin.reset' is not in the contract; declare the endpoint in fabrika.contract.ts first",
		])
	})

	test('a prototype member is never a handler', () => {
		const app: ContractImplementation = { contract: small, database: null, handlers: () => ({ api: {} }) }
		expect(problemsOf(() => boot(app, { environment: environment(FRAMEWORK_ENV), iam: keySource }))).toEqual([
			"procedure 'api.get' has no handler; add it to handlers",
		])
	})
})
