// The runtime of the staged kit: each builder returns the declaration its type describes, the contract derives its
// imports' `usedBy` from the endpoints' `connect`, and `serve` hands `boot` the handler beside each endpoint, with what
// the site declares, and the dependencies `defineDeps` builds at boot.

import { compileContract, ContractError, defineApp, type KitImport } from '@fabrika/app/contract'
import { type ContractApp, type ContractImplementation, defineDeps, serve } from '@fabrika/app/implement'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createCapabilityIssuer } from '../implement/capability'
import { isSiteHandler, siteHandler } from '../implement/invocation'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { isRecord } from './helpers'
import { contract as kitContract } from './kit-fixture/fabrika.contract'
import { app } from './kit-fixture/src/app-kit'
import { tables } from './kit-fixture/src/db/tables'
import { deals } from './kit-fixture/src/deals/endpoints'
import { close } from './kit-fixture/src/jobs'
import { ById } from './kit-fixture/src/schemas'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const DEAL = '0190a0a0-0000-7000-8000-0000000000d1'

/** The kit fixture's kit without its import, whose contracts need no endpoint that connects. */
const plainApp = defineApp(vocabulary, tables)

describe("the kit's builders", () => {
	test('a group holds its callers and its endpoints, each a procedure declaration with what it declares', () => {
		expect(deals['~kind']).toBe('group')
		expect(deals.callers).toEqual(['human'])
		const { get, pipeline } = deals.endpoints
		expect({ ...get, input: null, output: null }).toEqual({
			'~kind': 'procedure',
			type: 'query',
			input: null,
			output: null,
			access: { action: 'crm.read', on: 'deal', from: 'id' },
			declared: {},
			unknownOptions: [],
		})
		expect(pipeline.declared).toEqual({ sql: 'read' })
		expect(deals.endpoints.share.declared).toEqual({ issues: 'shared' })
		expect(deals.endpoints.product.declared).toEqual({ connect: ['catalog'] })
	})

	test('a job keeps its declaration, and its options outside the builder are recorded, not copied', () => {
		expect({ ...close, declared: close.declared }).toEqual({
			kind: 'cron',
			schedule: '0 3 * * *',
			actions: ['crm.read', 'deals.write'],
			scope: 'app',
			timeout: undefined,
			retries: undefined,
			declared: { sql: 'write' },
			unknownOptions: [],
		})
	})

	test('an endpoint before .handle carries handle on its prototype, so a copy of it is the declaration only', () => {
		const pending = app.group({ callers: ['human'] }, (r) => ({ get: r.query({ input: ById, output: ById, access: { member: true } }) }))
		const endpoint = pending.endpoints.get
		expect(typeof endpoint.handle).toBe('function')
		expect(Object.keys(endpoint)).toEqual(['~kind', 'type', 'input', 'output', 'access', 'declared', 'unknownOptions'])
		expect('handle' in { ...endpoint }).toBe(false)
	})

	test('the contract records each import of the kit with usedBy: the endpoints that declare connect of it', () => {
		expect(kitContract.surface.imports).toEqual({
			catalog: {
				app: 'catalog',
				export: 'products',
				version: 1,
				digest: 'sha256:b25f73d2e5b741cda43ac6f2369884f01ddf710bffb44ac67001c68c113946d9',
				procedures: ['get'],
				usedBy: ['api.deals.product'],
				timeoutMs: 400,
			},
		})
	})

	test('the artifact holds what each site declares, by endpoint id and job:<name>, and nothing for the rest', () => {
		expect(compileContract(kitContract, tables).declared).toEqual({
			'api.companies.audit': { sql: null, unscoped: { companies: 'read' }, connect: [], issues: null },
			'api.deals.pipeline': { sql: 'read', unscoped: {}, connect: [], issues: null },
			'api.deals.product': { sql: null, unscoped: {}, connect: ['catalog'], issues: null },
			'api.deals.share': { sql: null, unscoped: {}, connect: [], issues: 'shared' },
			'job:close': { sql: 'write', unscoped: {}, connect: [], issues: null },
		})
	})

	test('a kit given imports has an imports section, as its type says, even when they name none', () => {
		const none: Readonly<Record<string, KitImport>> = {}
		const contract = defineApp(vocabulary, tables, { imports: none }).contract((c) => ({ health: c.health('/healthz') }))
		expect(contract.surface.imports).toEqual({})
		expect('imports' in plainApp.contract((c) => ({ health: c.health('/healthz') })).surface).toBe(false)
	})

	test('a contract whose sites declare nothing has no declared section, so its digest is the one it had', () => {
		const plain = plainApp.contract((c) => ({ health: c.health('/healthz') }))
		expect('declared' in compileContract(plain, tables)).toBe(false)
	})
})

describe('buildArtifact refuses a declaration the site may not carry', () => {
	const refusals = (build: () => unknown): readonly string[] => {
		try {
			build()
		} catch (error) {
			if (error instanceof ContractError) return error.problems
			throw error
		}
		return []
	}

	test('an unscoped table that is no table, and a framework table', () => {
		const contract = plainApp.contract((c) => ({
			api: c.rpc('/api', {
				audit: plainApp.group({ callers: ['human'] }, (r) => ({
					list: r.query({ output: ById, access: { member: true }, unscoped: { companies: 'read' } }).handle(() => ({ id: DEAL })),
				})),
			}),
		}))
		expect(refusals(() => compileContract(contract, {}))).toEqual([
			"procedure 'api.audit.list': unscoped 'companies' is not a table of src/db/tables.ts",
		])
	})

	test('issues on an endpoint whose capability does not issue that mount', () => {
		const contract = plainApp.contract((c) => ({
			api: c.rpc('/api', {
				deals: plainApp.group({ callers: ['human'] }, (r) => ({
					share: r.mutation({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' }, issues: 'shared' })
						.handle(({ ctx }) => ({ id: ctx.target.value })),
				})),
			}),
		}))
		expect(refusals(() => compileContract(contract, tables))).toEqual([
			"procedure 'api.deals.share': issues 'shared', which is not a link mount of the contract",
		])
	})
})

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`kit-runtime.test.ts: the boot cases skipped; set ${URL_VARIABLE} to run them (a staged-kit site runs on @fabrika/db)`)
}
const schema = applicationSchema(`kit-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
	await admin(`insert into ${schema}.orgs (id, name, created_by, version) values ('o1', 'One', 'u', 1)`)
	await admin(`insert into ${schema}.companies (id, org_id, name, created_by, version) values ('c1', 'o1', 'Acme', 'u', 1)`)
	await admin(
		`insert into ${schema}.deals (id, company_id, org_id, title, stage, created_by, version) values ('${DEAL}', 'c1', 'o1', 'Deal', 'won', 'u', 1)`,
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of connections) await connection.close()
	await admin(`drop schema ${schema} cascade`)
})

/**
 * Boots `implementation` on the test database, under the digest `approved`'s contract compiles to; the harness signs
 * for the notes application, and the kit fixture is the crm one.
 */
function bootOnPostgres(implementation: ContractImplementation, approved: ContractImplementation = implementation, variables = {}): ContractApp {
	const connection = Database.postgres({ url, schema, max: 2 })
	connections.push(connection)
	return bootApp(implementation, {
		environment: environment({ ...frameworkEnvFor(approved), FABRIKA_IAM_APP_ID: 'crm@prod', ...variables }),
		database: connection,
	})
}

describe('serve', () => {
	const greeting = defineDeps((env) => ({ greeting: typeof env['GREETING'] === 'string' ? env['GREETING'] : 'hello' }))
	const contract = plainApp.contract((c) => ({
		api: c.rpc('/api', {
			hello: plainApp.group({ callers: ['human'] }, (r) => ({
				me: r.query({ output: z.strictObject({ text: z.string() }), access: { member: true } })
					.handle(({ ctx }) => ({ text: `${greeting.get().greeting}, ${ctx.principal.label}` })),
				deal: r.query({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' }, sql: 'read' })
					.handle(({ ctx }) => ({ id: ctx.target.value })),
			})),
		}),
	}))
	/** `scoped(tables)` binds once, to one `boot`, so every boot here gets an implementation of its own. */
	const served = (deps = greeting) => serve(contract, { database: scoped(tables), deps })

	test.skipIf(!hasPostgres)('boot serves each endpoint by the handler beside it, and a handler reads the dependencies boot built', async () => {
		const app = bootOnPostgres(served())
		const reader = await token('user', [grant('crm.read', { type: 'org', value: 'o1' })], 'crm@prod')
		expect(resultOf(await send(app, '/api/hello.me', { token: reader, body: {} }))).toEqual({ text: 'hello, user@notes.test' })
		expect(resultOf(await send(app, '/api/hello.deal', { token: reader, body: { id: DEAL } }))).toEqual({ id: DEAL })
	})

	const helloTree = (tree: unknown): Readonly<Record<string, unknown>> =>
		isRecord(tree) && isRecord(tree['api']) && isRecord(tree['api']['hello']) ? tree['api']['hello'] : {}

	test('each leaf of the tree is the site with its handler and what it declares', () => {
		const deal = helloTree(served().handlers({}, { capabilities: createCapabilityIssuer().authority }))['deal']
		expect(isSiteHandler(deal) ? deal.declared : undefined).toEqual({ sql: 'read' })
	})

	test.skipIf(!hasPostgres)('a declaration only the handler tree carries does not boot under the approved digest', () => {
		const implementation = served()
		const widened: ContractImplementation = {
			...implementation,
			handlers: (env, runtime) => {
				const tree = implementation.handlers(env, runtime)
				const hello = helloTree(tree)
				const deal = hello['deal']
				return !isRecord(tree) || !isSiteHandler(deal) ? tree : {
					...tree,
					api: { hello: { ...hello, deal: siteHandler(deal.handler, { sql: 'read', unscoped: { deals: 'read' } }) } },
				}
			},
		}
		expect(() => bootOnPostgres(widened, implementation)).toThrow(
			`procedure 'api.hello.deal': its handler declares {"sql":"read","unscoped":[["deals","read"]],"connect":[],"issues":null}, but the approved contract declares {"sql":"read","unscoped":[],"connect":[],"issues":null}`,
		)
		expect(() => bootOnPostgres(served())).not.toThrow()
	})

	test.skipIf(!hasPostgres)('two runtimes that share one defineDeps each read their own dependencies, also with requests interleaved', async () => {
		let release = (): void => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const label = defineDeps((env) => ({ label: typeof env['LABEL'] === 'string' ? env['LABEL'] : 'none' }))
		const slow = plainApp.contract((c) => ({
			api: c.rpc('/api', {
				label: plainApp.group({ callers: ['human'] }, (r) => ({
					read: r.query({ output: z.strictObject({ text: z.string() }), access: { member: true } }).handle(async () => {
						const before = label.get().label
						await gate
						return { text: `${before}/${label.get().label}` }
					}),
				})),
			}),
		}))
		const bootWith = (value: string) => {
			const implementation = serve(slow, { database: scoped(tables), deps: label })
			return bootOnPostgres(implementation, implementation, { LABEL: value })
		}
		const [first, second] = [bootWith('first'), bootWith('second')]
		const user = await token('user', [grant('crm.read', { type: 'org', value: 'o1' })], 'crm@prod')
		const fromFirst = send(first, '/api/label.read', { token: user, body: {} })
		const fromSecond = send(second, '/api/label.read', { token: user, body: {} })
		release()
		expect(resultOf(await fromFirst)).toEqual({ text: 'first/first' })
		expect(resultOf(await fromSecond)).toEqual({ text: 'second/second' })
		expect(resultOf(await send(first, '/api/label.read', { token: user, body: {} }))).toEqual({ text: 'first/first' })
	})

	test('the dependencies are read while a handler runs, not at module load', () => {
		const unbuilt = defineDeps(() => ({ greeting: 'hi' }))
		expect(() => unbuilt.get()).toThrow('the dependencies are built at boot')
	})
})
