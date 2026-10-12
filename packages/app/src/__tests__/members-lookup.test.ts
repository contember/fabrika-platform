// `ctx.members` below its dimension (WU22): a deal endpoint reads the directory of the org the deal lies in. The types
// give every endpoint on or in a dimension under a directory the lookup, and the list only for the directory's
// `members.list`; the test kit's directory answers both from its callers; the generated endpoint access tests fill a
// field `members` names with a real member, so an endpoint that validates a picked person passes them. The fixture is
// `members-fixture/` (org → company → deal); the same lookup against the real IAM is `local-stack/__tests__/member-lookup.test.ts`.

import type { App, Declared, EndpointContext, KitTypes, Unavailable } from '@fabrika/app/contract'
import { GENERATED_MEMBER } from '@fabrika/app/contract'
import { type Member, type MemberDirectory, type MemberLookup, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { checkApplication } from '@fabrika/check'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import type { app as accessApp } from './access-fixture/src/app-kit'
import { contract } from './members-fixture/fabrika.contract'
import type { app as membersApp } from './members-fixture/src/app-kit'
import { tables } from './members-fixture/src/db/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type KitOf<A> = A extends App<infer Kit extends KitTypes> ? Kit : never
type None = Declared<never, never, never, never>
type Members<A, Acc> = EndpointContext<KitOf<A>, 'human', 'mutation', Acc, None>['members']

/** The types: a deal endpoint reads the org's directory; a note endpoint of an application without members has none. */
export type NestedMembers = [
	Expect<Equal<Members<typeof membersApp, { readonly action: 'crm.read'; readonly on: 'deal'; readonly from: 'id' }>, MemberDirectory>>,
	Expect<
		Equal<
			Members<typeof membersApp, { readonly action: 'deals.assign'; readonly on: 'deal'; readonly from: 'id' }>,
			MemberLookup & { readonly list: Unavailable<"listing the members of org needs the action 'crm.read'; get(principalId) checks one"> }
		>
	>,
	Expect<
		Equal<
			Members<typeof membersApp, { readonly action: 'deals.write'; readonly in: 'company'; readonly from: 'companyId' }>['get'],
			(principalId: string) => Promise<Member | null>
		>
	>,
	Expect<
		Equal<
			Members<typeof accessApp, { readonly action: 'notes.read'; readonly on: 'note'; readonly from: 'id' }>,
			Unavailable<'neither note nor a dimension containing it declares members'>
		>
	>,
]

const fixtureRoot = join(import.meta.dir, 'members-fixture')
const postgres = await testDatabase({ migrations: new URL('./members-fixture/db/migrations/', import.meta.url), label: 'members-lookup.test.ts' })
afterAll(() => postgres?.close())

const UUID = '00000000-0000-4000-8000-000000000000'

/** The fixture with a handler that keeps the first member it found and answers it to every later caller, any org's. */
function caching() {
	let kept: { readonly principalId: string; readonly label: string | null } | null = null
	const keep = (member: { readonly principalId: string; readonly label: string | null } | null) => {
		kept ??= member === null ? null : { principalId: member.principalId, label: member.label }
		return { member: kept }
	}
	return implement(contract, {
		database: scoped(tables),
		deps: () => ({}),
		handlers: () => ({
			api: {
				deals: {
					owner: () => ({ owner: null, ownerLabel: null }),
					assign: () => ({ id: UUID, version: 1 }),
					candidate: async ({ input, ctx }) => keep(await ctx.members.get(input.principalId)),
					check: async ({ input, ctx }) => keep(await ctx.members.get(input.principalId)),
					team: () => ({ members: [] }),
				},
			},
		}),
	})
}

const Result = z.strictObject({ result: z.unknown() })
const Found = z.strictObject({ member: z.nullable(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })

describe('the generated endpoint access tests of an endpoint that validates a picked member', () => {
	test("the scaffold writes the members field as the kit's member, and the committed tests are current", async () => {
		expect(await checkApplication({ root: fixtureRoot })).toEqual([])
	})
})

describe.skipIf(postgres === null)("a deal endpoint's ctx.members in the test kit", () => {
	if (postgres === null) return
	// Each suite boots a layer of its own: the fixture's `src/app.ts` is booted by its generated tests.
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)

	const call = async (caller: ReturnType<typeof kit.testCaller>, procedure: string, input: object) => {
		const response = await kit.browser(caller)(`/api/deals.${procedure}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		})
		return { status: response.status, body: await response.json() }
	}

	test("the lookup answers a member of the deal's org with its label, null for a member of another org and an unknown id", async () => {
		const worlds = await postgres.seedWorlds(tables, 'deals')
		const orgOf = (world: 'own' | 'other'): { readonly type: 'org'; readonly value: string } => ({
			type: 'org',
			value: worlds[world].chain.find((link) => link.type === 'org')?.value ?? '',
		})
		const manager = kit.testCaller([{ role: 'manager', scope: orgOf('own') }])
		const viewer = kit.testCaller([{ role: 'viewer', scope: orgOf('own') }], { label: 'viewer@notes.test' })
		const elsewhere = kit.testCaller([{ role: 'viewer', scope: orgOf('other') }])
		const found = async (principalId: string) =>
			Found.parse(Result.parse((await call(manager, 'candidate', { id: worlds.own.key, principalId })).body).result).member
		expect(await found(viewer.id)).toEqual({ principalId: viewer.id, label: 'viewer@notes.test' })
		expect(await found(elsewhere.id)).toBeNull()
		expect(await found('nobody')).toBeNull()
		expect((await call(manager, 'assign', { id: worlds.own.key, expectVersion: 1, newOwner: elsewhere.id })).status).toBe(400)
		expect((await call(manager, 'assign', { id: worlds.own.key, expectVersion: 1, newOwner: viewer.id })).status).toBe(200)
	})

	test("listing from a deal needs the org's members.list on the org: a caller holding it on the company alone is refused", async () => {
		const worlds = await postgres.seedWorlds(tables, 'deals')
		const company = worlds.own.chain.find((link) => link.type === 'company')?.value ?? ''
		const reader = kit.testCaller([{ action: 'crm.read', scope: { type: 'company', value: company } }])
		expect((await call(reader, 'team', { id: worlds.own.key })).status).toBe(403)
	})

	test("the leak cases catch another org's member in an answer: on and in", async () => {
		const marked = [expect.stringMatching(/^member-/), expect.stringMatching(/^member-.+@example\.test$/)]
		expect(await access.leaked('api.deals.candidate', { id: UUID, principalId: GENERATED_MEMBER })).toEqual({ answered: true, leaked: [] })
		expect(await access.leaked('api.deals.check', { companyId: 'x', principalId: GENERATED_MEMBER })).toEqual({ answered: true, leaked: [] })
		const on = endpointAccessKit(caching(), tables, postgres)
		expect(await on.leaked('api.deals.candidate', { id: UUID, principalId: GENERATED_MEMBER })).toEqual({ answered: true, leaked: marked })
		const inCompany = endpointAccessKit(caching(), tables, postgres)
		expect(await inCompany.leaked('api.deals.check', { companyId: 'x', principalId: GENERATED_MEMBER })).toEqual({ answered: true, leaked: marked })
	})

	test("a generated case's member field is a real member: without it, the handler's refusal fails the case and names members", async () => {
		const input = { id: '00000000-0000-4000-8000-000000000000', expectVersion: 1 }
		expect(await access.own('api.deals.assign', { ...input, newOwner: GENERATED_MEMBER })).toEqual({ status: 200 })
		await expect(access.own('api.deals.assign', { ...input, newOwner: 'x' })).rejects.toThrow('name the member field in members')
	})
})
