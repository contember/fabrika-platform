// The test kit answers a member directory (`ctx.members.list()`) from its own callers without a membership transport:
// the members of the scope with their roles, labels only where the dimension declares `directory: 'labels'`, and a
// refusal for a caller who may not list there, and a disabled caller as disabled. A contract that writes through IAM
// still needs `options.membership`.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'teams',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'org.read' } },
		team: { members: { manage: 'members.manage', list: 'org.read' }, directory: 'labels' },
	},
	actions: { 'org.read': 'Read the org', 'members.manage': 'Manage members' },
	roles: {
		member: { grants: ['org.read'], member: { scope: 'org', assignableBy: ['owner'] } },
		owner: { grants: ['org.read', 'members.manage'], member: { scope: 'org', assignableBy: ['owner'] } },
		teammate: { grants: ['org.read'], member: { scope: 'team', assignableBy: ['teammate'] } },
	},
})
const app = defineApp(vocabulary)
const InOrg = z.strictObject({ orgId: z.string() })
const InTeam = z.strictObject({ teamId: z.string() })
const Members = z.strictObject({
	items: z.array(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()), roles: z.array(z.string()) })),
})
const Roster = z.strictObject({ items: z.array(z.strictObject({ principalId: z.string(), disabled: z.boolean() })) })
const Lookup = z.strictObject({ orgId: z.string(), principalId: z.string() })
const Found = z.strictObject({ member: z.nullable(z.strictObject({ principalId: z.string(), disabled: z.boolean() })) })

const members = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: InOrg, output: Members, access: { action: 'org.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list()).map((member) => ({ principalId: member.principalId, label: member.label, roles: [...member.roles] })),
		})),
	roster: r.query({ input: InOrg, output: Roster, access: { action: 'org.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list()).map((member) => ({ principalId: member.principalId, disabled: member.disabled })),
		})),
	find: r.query({ input: Lookup, output: Found, access: { action: 'org.read', in: 'org', from: 'orgId' } })
		.handle(async ({ input, ctx }) => {
			const member = await ctx.members.get(input.principalId)
			return { member: member === null ? null : { principalId: member.principalId, disabled: member.disabled } }
		}),
	team: r.query({ input: InTeam, output: Members, access: { action: 'org.read', in: 'team', from: 'teamId' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list()).map((member) => ({ principalId: member.principalId, label: member.label, roles: [...member.roles] })),
		})),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { members }), health: c.health('/healthz') }))

async function call(fetch: (input: string, init: RequestInit) => Promise<Response>, path: string, input: object) {
	const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
	const body: unknown = await response.json()
	return { status: response.status, body }
}

describe("the test kit's member directory", () => {
	test("lists the scope's members and their roles, without labels unless the dimension declares them", async () => {
		const kit = testKit(serve(contract, { database: null }))
		const ana = kit.testCaller([{ role: 'owner', scope: { type: 'org', value: 'acme' } }], { id: 'ana' })
		kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'acme' } }], { id: 'bo' })
		kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'other' } }], { id: 'cy' })
		const reader = kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'acme' } }], { id: 'di' })

		const listed = await call(kit.browser(reader), '/api/members.list', { orgId: 'acme' })
		expect(listed).toEqual({
			status: 200,
			body: {
				result: {
					items: [
						{ principalId: 'ana', label: null, roles: ['owner'] },
						{ principalId: 'bo', label: null, roles: ['member'] },
						{ principalId: 'di', label: null, roles: ['member'] },
					],
				},
			},
		})
		const asOwner = z.strictObject({ result: Members }).parse((await call(kit.browser(ana), '/api/members.list', { orgId: 'acme' })).body)
		expect(asOwner.result.items[0]).toEqual({ principalId: 'ana', label: 'human-1@teams.test', roles: ['owner'] })
		expect((await call(kit.browser(reader), '/api/members.list', { orgId: 'other' })).status).toBe(403)
	})

	test("a dimension with directory: 'labels' shows labels to every lister", async () => {
		const kit = testKit(serve(contract, { database: null }))
		const mate = kit.testCaller([{ role: 'teammate', scope: { type: 'team', value: 't1' } }], { id: 'eve', label: 'eve@teams.test' })
		expect((await call(kit.browser(mate), '/api/members.team', { teamId: 't1' })).body).toEqual({
			result: { items: [{ principalId: 'eve', label: 'eve@teams.test', roles: ['teammate'] }] },
		})
	})

	test('a disabled caller is listed and found with disabled: true, and its own session signs no request in', async () => {
		const kit = testKit(serve(contract, { database: null }))
		const acme = kit.scope('org', 'acme')
		const reader = kit.testCaller([{ role: 'member', scope: acme }], { id: 'di' })
		const gone = kit.testCaller([{ role: 'member', scope: acme }], { id: 'gone', disabled: true })
		expect(gone.disabled).toBe(true)
		expect((await call(kit.browser(reader), '/api/members.roster', { orgId: 'acme' })).body).toEqual({
			result: { items: [{ principalId: 'di', disabled: false }, { principalId: 'gone', disabled: true }] },
		})
		expect((await call(kit.browser(reader), '/api/members.find', { orgId: 'acme', principalId: 'gone' })).body).toEqual({
			result: { member: { principalId: 'gone', disabled: true } },
		})
		expect((await call(kit.browser(gone), '/api/members.roster', { orgId: 'acme' })).status).toBe(401)
		expect(() => kit.testCaller([], { kind: 'link', disabled: true })).toThrow('a link holder is no principal')
	})
})
