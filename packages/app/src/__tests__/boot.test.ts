// `boot` reads the framework's variables and removes them, and refuses to start when anything declared cannot be
// served: a kind whose runtime is not built, a handler outside the contract, a missing handler.

import { defineContract } from '@fabrika/app/contract'
import { boot, BootError, type ContractImplementation, implement } from '@fabrika/app/implement'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { notesApp } from './fixtures/implement/app'
import { echoAssets, FRAMEWORK_ENV, keySource } from './fixtures/implement/harness'

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
	afterEach(() => {
		delete process.env['FABRIKA_TEST_SECRET']
	})

	test('a missing app id and issuer stop the boot, both named', () => {
		const problems = problemsOf(() => boot(notesApp(new Map()), { env: {}, iam: keySource, assets: echoAssets }))
		expect(problems.join('\n')).toContain('FABRIKA_APP_ID')
		expect(problems.join('\n')).toContain('FABRIKA_IAM_ISSUER')
	})

	test('deps get the application variables only, and process.env loses every FABRIKA_ name', () => {
		process.env['FABRIKA_TEST_SECRET'] = 'database-password'
		let seen: Readonly<Record<string, unknown>> = {}
		const base = notesApp(new Map())
		const app: ContractImplementation = {
			...base,
			handlers: (env, runtime) => {
				seen = env
				return base.handlers(env, runtime)
			},
		}
		boot(app, { env: { ...FRAMEWORK_ENV, FABRIKA_TEST_SECRET: 'x', NOTES_API_URL: 'https://x.test' }, iam: keySource, assets: echoAssets })
		expect(seen).toEqual({ NOTES_API_URL: 'https://x.test' })
		expect(process.env['FABRIKA_TEST_SECRET']).toBeUndefined()
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
		const problems = problemsOf(() => boot(app, { env: FRAMEWORK_ENV, iam: keySource }))
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
		expect(problemsOf(() => boot(app, { env: FRAMEWORK_ENV, iam: keySource, assets: echoAssets }))).toEqual([
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
		expect(problemsOf(() => boot(app, { env: FRAMEWORK_ENV, iam: keySource }))).toEqual([
			"procedure 'api.get' has no handler; add it to handlers",
			"handler 'api.dump' is not in the contract; declare the endpoint in fabrika.contract.ts first",
			"handler 'admin.reset' is not in the contract; declare the endpoint in fabrika.contract.ts first",
		])
	})

	test('a prototype member is never a handler', () => {
		const app: ContractImplementation = { contract: small, database: null, handlers: () => ({ api: {} }) }
		expect(problemsOf(() => boot(app, { env: FRAMEWORK_ENV, iam: keySource }))).toEqual(["procedure 'api.get' has no handler; add it to handlers"])
	})
})
