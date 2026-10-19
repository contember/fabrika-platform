// Several capabilities (`access: { capabilities }`, backlog 157): an operation that reads one object and writes in
// another scope holds a capability for each, every one checked by the proxy and minted by the runtime as its single
// access form would be. The artifact, the refusals of `buildArtifact`, the handler's types, and the requests through
// the production proxy decision and a REAL Postgres, over the members fixture; the database half skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient, RpcError } from '@fabrika/app/client'
import {
	type AccessDeclaration,
	type App,
	buildArtifact,
	compileContract,
	ContractError,
	type Declared,
	describeContract,
	type EndpointContext,
	type KitTypes,
	type ProcedureDeclaration,
	type Unavailable,
} from '@fabrika/app/contract'
import { type Ref, serve, type Within } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import type { SchemaShape } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { app } from './members-fixture/src/app-kit'
import { tables } from './members-fixture/src/db/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Copy = EndpointContext<
	Kit,
	'human',
	'mutation',
	{
		readonly capabilities: {
			readonly source: { readonly action: 'crm.read'; readonly on: 'deal'; readonly from: 'sourceId' }
			readonly into: { readonly action: 'deals.write'; readonly in: 'company'; readonly from: 'companyId' }
			readonly listed: { readonly action: 'crm.read'; readonly over: 'org' }
		}
	},
	Declared<never, never, never, never>
>

/** Each capability by its name, bound through `ctx.db.on`, `.in` and `.over`; no single target. */
export type CapabilitiesContext = [
	Expect<Equal<Copy['capabilities']['source'], Ref<'deal', 'crm.read'>>>,
	Expect<Equal<Copy['capabilities']['into'], Ref<'company', 'deals.write'>>>,
	Expect<Equal<Copy['capabilities']['listed'], Within<'org', 'crm.read'>>>,
	Expect<Copy['target'] extends Unavailable<string> ? true : false>,
	Expect<Copy['db']['target'] extends Unavailable<string> ? true : false>,
	Expect<Copy['members'] extends Unavailable<string> ? true : false>,
]

const CopyDeal = z.strictObject({ sourceId: z.uuid(), companyId: z.string() })
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

const copies = app.group({ callers: ['human'] }, (r) => ({
	copy: r.mutation({
		input: CopyDeal,
		output: Saved,
		access: {
			capabilities: {
				source: { action: 'crm.read', on: 'deal', from: 'sourceId' },
				into: { action: 'deals.write', in: 'company', from: 'companyId' },
			},
		},
	}).handle(async ({ ctx }) => {
		const source = await ctx.db.on(ctx.capabilities.source).get()
		return ctx.db.in(ctx.capabilities.into).deals.insert({ title: `Copy of ${source.title}` })
	}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { copies }) }))

describe('several capabilities in the artifact', () => {
	test('the endpoint requires every capability, by name, each with its own access form', () => {
		const row = compileContract(contract, tables).endpoints.find((candidate) => candidate.id === 'api.copies.copy')
		expect(row?.requirement).toEqual({
			kind: 'capabilities',
			capabilities: {
				source: { action: 'crm.read', access: { form: 'on', dimension: 'deal', from: 'sourceId' } },
				into: { action: 'deals.write', access: { form: 'in', dimension: 'company', from: 'companyId' } },
			},
		})
	})

	const base = describeContract(contract)
	const api = base.mounts['api']
	if (api?.kind !== 'rpc') throw new Error('the contract changed')
	const output: SchemaShape = { type: 'null' }
	const input: SchemaShape = {
		type: 'object',
		fields: {
			sourceId: { type: 'string', format: 'uuid', minLength: null, maxLength: null, pattern: null, startsWith: null, endsWith: null, includes: null },
		},
	}
	const problemsOf = (access: AccessDeclaration): readonly string[] => {
		const copy: ProcedureDeclaration<SchemaShape> = { '~kind': 'procedure', type: 'mutation', input, output, access }
		try {
			buildArtifact({ ...base, mounts: { ...base.mounts, api: { ...api, procedures: { copies: { copy } } } } }, tablePolicies(tables))
			return []
		} catch (error) {
			if (error instanceof ContractError) return error.problems
			throw error
		}
	}
	const source = { action: 'crm.read', on: 'deal', from: 'sourceId' } as const

	test.each<[string, AccessDeclaration, string]>([
		['one capability', { capabilities: { source } }, "procedure 'api.copies.copy': access"],
		['a capability of two forms', { capabilities: { source, into: { action: 'deals.write', over: 'org', from: 'sourceId' } } }, "capability 'into'"],
		['an unknown action', { capabilities: { source, into: { action: 'deals.copy', over: 'org' } } }, "'deals.copy' is not an action of the contract"],
		[
			'a field that is no input field',
			{ capabilities: { source, into: { action: 'deals.write', in: 'company', from: 'companyId' } } },
			"access.from 'companyId'",
		],
	])('refuses %s', (_name, access, problem) => {
		expect(problemsOf(access).join('\n')).toContain(problem)
	})
})

const postgres = await testDatabase({ migrations: new URL('./members-fixture/db/migrations/', import.meta.url), label: 'capabilities.test.ts' })
afterAll(() => postgres?.close())

describe.skipIf(postgres === null)('several capabilities through the proxy decision', () => {
	if (postgres === null) return
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
	const statusOf = async (call: Promise<unknown>): Promise<number> => {
		try {
			await call
			return 200
		} catch (error) {
			if (error instanceof RpcError && error.httpStatus !== undefined) return error.httpStatus
			throw error
		}
	}

	test('a caller holding each action reads one deal and writes into another company, in one call', async () => {
		const worlds = await postgres.seedWorlds(tables, 'deals')
		const org = worlds.own.chain.find((link) => link.type === 'org')?.value ?? ''
		const company = worlds.own.chain.find((link) => link.type === 'company')?.value ?? ''
		const caller = kit.testCaller([{ action: 'crm.read', scope: { type: 'org', value: org } }, {
			action: 'deals.write',
			scope: { type: 'org', value: org },
		}])
		const client = createClient(contract, 'api', { fetch: kit.browser(caller) })
		const saved = await client.copies.copy({ sourceId: worlds.own.key, companyId: company })
		expect(saved.version).toBe(1)
		const reader = kit.testCaller([{ action: 'crm.read', scope: { type: 'org', value: org } }])
		expect(await statusOf(createClient(contract, 'api', { fetch: kit.browser(reader) }).copies.copy({ sourceId: worlds.own.key, companyId: company })))
			.toBe(403)
	})

	test('each capability is refused on its own while the other passes: a deal of another org 404, a company of another org 403', async () => {
		const input = { sourceId: crypto.randomUUID(), companyId: 'unused' }
		expect(await access.capability('api.copies.copy', 'source', input)).toEqual({ status: 404 })
		expect(await access.capability('api.copies.copy', 'into', input)).toEqual({ status: 403 })
	})
})
