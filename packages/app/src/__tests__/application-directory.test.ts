// An application's own people (`members` of the vocabulary): an `app: true` endpoint whose action is the vocabulary's
// `members.list` reads every principal holding one of the application's roles through `ctx.members.list()`, which the
// test kit answers from its own callers as IAM answers it. A staff overview names the author of a change from it and
// counts the people of each value in one call.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'partners',
	dimensions: { org: { members: { manage: 'org.manage', list: 'org.read' } } },
	actions: {
		'org.read': 'Read a partner organization',
		'org.manage': "Manage a partner organization's people",
		'people.list': "List the application's people",
		'people.manage': "Grant and revoke the application's roles",
	},
	roles: {
		partner: { grants: ['org.read'], member: { scope: 'org', assignableBy: ['staff'] }, external: true },
		staff: { grants: ['org.read', 'org.manage', 'people.list'] },
		administrator: { grants: ['org.read', 'org.manage', 'people.list', 'people.manage'] },
	},
	members: { manage: 'people.manage', list: 'people.list' },
	directory: 'labels',
})
const app = defineApp(vocabulary)
const Page = z.strictObject({ after: z.string().optional() })
const People = z.strictObject({
	items: z.array(z.strictObject({ principalId: z.string(), name: z.nullable(z.string()), email: z.nullable(z.string()) })),
	next: z.nullable(z.string()),
})
const Overview = z.strictObject({ items: z.array(z.strictObject({ org: z.string(), people: z.int(), signedIn: z.int() })) })

const staff = app.group({ callers: ['human'] }, (r) => ({
	people: r.query({ input: Page, output: People, access: { action: 'people.list', app: true } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.members.list({ after: input.after })
			return {
				items: page.members.map((person) => ({ principalId: person.principalId, name: person.label, email: person.email })),
				next: page.next,
			}
		}),
	overview: r.query({ output: Overview, access: { action: 'people.list', app: true } })
		.handle(async ({ ctx }) => {
			const counts = new Map<string, { people: number; signedIn: number }>()
			for (const person of (await ctx.members.list()).members) {
				for (const held of person.roles) {
					if (held.scope?.type !== 'org') continue
					const count = counts.get(held.scope.value) ?? { people: 0, signedIn: 0 }
					counts.set(held.scope.value, { people: count.people + 1, signedIn: count.signedIn + (person.lastSignInAt === null ? 0 : 1) })
				}
			}
			return { items: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([org, count]) => ({ org, ...count })) }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { staff }), health: c.health('/healthz') }))

async function call(fetch: (input: string, init: RequestInit) => Promise<Response>, path: string, input: object = {}) {
	const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
	const body: unknown = await response.json()
	return { status: response.status, body }
}

describe("the application's own directory", () => {
	test('names every person holding a role of the application, global or in a value, with the label it declares', async () => {
		const kit = testKit(serve(contract, { database: null }))
		const ana = kit.testCaller([{ role: 'staff' }], { id: 'ana', label: 'Ana Staff' })
		kit.testCaller([{ role: 'partner', scope: { type: 'org', value: 'acme' } }], { id: 'bo', label: 'Bo Partner', affiliation: 'external' })
		kit.testCaller([], { id: 'cy', label: 'Cy Nobody' })

		expect(await call(kit.browser(ana), '/api/staff.people')).toEqual({
			status: 200,
			body: {
				result: {
					items: [{ principalId: 'ana', name: 'Ana Staff', email: null }, { principalId: 'bo', name: 'Bo Partner', email: null }],
					next: null,
				},
			},
		})
	})

	test("addresses and sign-ins only to the application's members.manage; a staff overview counts each value in one call", async () => {
		const kit = testKit(serve(contract, { database: null }))
		const admin = kit.testCaller([{ role: 'administrator' }], { id: 'admin', email: 'admin@partners.test' })
		kit.testCaller([{ role: 'partner', scope: { type: 'org', value: 'acme' } }], { id: 'p1', affiliation: 'external', lastSignInAt: 1_800_000_000 })
		kit.testCaller([{ role: 'partner', scope: { type: 'org', value: 'acme' } }], { id: 'p2', affiliation: 'external' })
		kit.testCaller([{ role: 'partner', scope: { type: 'org', value: 'globex' } }], { id: 'p3', affiliation: 'external' })

		const listed = await call(kit.browser(admin), '/api/staff.people')
		expect(listed.status).toBe(200)
		const { result } = z.strictObject({ result: People }).parse(listed.body)
		expect(result.items.find((person) => person.principalId === 'admin')?.email).toBe('admin@partners.test')
		expect(await call(kit.browser(admin), '/api/staff.overview')).toEqual({
			status: 200,
			body: { result: { items: [{ org: 'acme', people: 2, signedIn: 1 }, { org: 'globex', people: 1, signedIn: 0 }] } },
		})
	})

	test('a caller without the list action held globally reads nothing', async () => {
		const kit = testKit(serve(contract, { database: null }))
		const partner = kit.testCaller([{ role: 'partner', scope: { type: 'org', value: 'acme' } }], { affiliation: 'external' })
		const scoped = kit.testCaller([{ action: 'people.list', scope: { type: 'org', value: 'acme' } }])
		for (const caller of [partner, scoped]) {
			const response = await kit.browser(caller)('/api/staff.people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
			expect(response.status).toBe(403)
		}
	})
})
