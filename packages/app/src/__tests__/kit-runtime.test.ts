// The runtime of the staged kit: each builder returns the declaration its type describes, the contract derives its
// imports' `usedBy` from the endpoints' `connect`, and `serve` hands `boot` the handler beside each endpoint, with what
// the site declares, and the dependencies `defineDeps` builds at boot.

import { compileContract, ContractError, defineApp } from '@fabrika/app/contract'
import { type ContractDatabase, defineDeps, serve } from '@fabrika/app/implement'
import { tablePolicies } from '@fabrika/db/tables'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createCapabilityIssuer } from '../implement/capability'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { isRecord } from './helpers'
import { contract as kitContract } from './kit-fixture/fabrika.contract'
import { app } from './kit-fixture/src/app-kit'
import { tables } from './kit-fixture/src/db/tables'
import { deals } from './kit-fixture/src/deals/endpoints'
import { close } from './kit-fixture/src/jobs'
import { ById } from './kit-fixture/src/schemas'
import { vocabulary } from './kit-fixture/src/vocabulary'

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
	const database: ContractDatabase = {
		tables: tablePolicies(tables),
		locate: (dimension, id) =>
			Promise.resolve(dimension === 'deal' && id === DEAL ? new Map([['deal', DEAL], ['company', 'c1'], ['org', 'o1']]) : null),
	}

	test('boot serves each endpoint by the handler beside it, and a handler reads the dependencies boot built', async () => {
		const implementation = serve(contract, { database, deps: greeting })
		// The harness signs for the notes application; the kit fixture is the crm one.
		const served = bootApp(implementation, { environment: environment({ ...frameworkEnvFor(implementation), FABRIKA_IAM_APP_ID: 'crm@prod' }) })
		const reader = await token('user', [grant('crm.read', { type: 'org', value: 'o1' })], 'crm@prod')
		expect(resultOf(await send(served, '/api/hello.me', { token: reader, body: {} }))).toEqual({ text: 'hello, user@notes.test' })
		expect(resultOf(await send(served, '/api/hello.deal', { token: reader, body: { id: DEAL } }))).toEqual({ id: DEAL })
	})

	test('each handler of the tree carries what its site declares', () => {
		const tree = serve(contract, { database, deps: greeting }).handlers({}, { capabilities: createCapabilityIssuer().authority })
		const hello = isRecord(tree) && isRecord(tree['api']) && isRecord(tree['api']['hello']) ? tree['api']['hello'] : {}
		const deal = hello['deal']
		expect(typeof deal).toBe('function')
		expect(typeof deal === 'function' && 'declared' in deal ? deal.declared : undefined).toEqual({ sql: 'read' })
	})

	test('the dependencies are read while a handler runs, not at module load', () => {
		const unbuilt = defineDeps(() => ({ greeting: 'hi' }))
		expect(() => unbuilt.get()).toThrow('the dependencies are built at boot')
	})
})
