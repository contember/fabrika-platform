// A staged-kit contract's reach is the approved artifact's, whatever the handler tree holds: served through
// `implement`, with plain functions for leaves, an endpoint that declares no `issues` issues no share link, and one
// that declares `issues: 'shared'` issues on that mount and no other compatible one.

import { defineApp } from '@fabrika/app/contract'
import { type ContractDatabase } from '@fabrika/app/implement'
import { tablePolicies } from '@fabrika/db/tables'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { RecordingMembership } from './fixtures/multi-tenant/iam'
import { tables } from './kit-fixture/src/db/tables'
import { ById } from './kit-fixture/src/schemas'
import { vocabulary } from './kit-fixture/src/vocabulary'

const DEAL = '0190a0a0-0000-7000-8000-0000000000d1'
const Url = z.strictObject({ url: z.string() })
const Ok = z.strictObject({ ok: z.boolean() })

/** `implement` binds this tree; the kit's own handlers are never served. */
const unserved = (): never => {
	throw new Error('this site is served by the tree implement binds')
}

const kit = defineApp(vocabulary, tables)
const deals = kit.group({ callers: ['human'] }, (r) => ({
	undeclared: r.mutation({ input: ById, output: Url, access: { action: 'deals.share', on: 'deal', from: 'id' } }).handle(unserved),
	declared: r.mutation({ input: ById, output: Url, access: { action: 'deals.share', on: 'deal', from: 'id' }, issues: 'shared' }).handle(unserved),
	elsewhere: r.mutation({ input: ById, output: Url, access: { action: 'deals.share', on: 'deal', from: 'id' }, issues: 'shared' }).handle(unserved),
}))
const linkMount = (prefix: '/s' | '/o') =>
	kit.link(prefix, {
		spa: 'dist/share',
		dimension: 'deal',
		grants: ['crm.read'],
		issuedBy: 'deals.share',
		maxDays: 30,
		procedures: (l) => ({ deal: l.query({ output: Ok, access: { action: 'crm.read' } }).handle(unserved) }),
	})
const contract = kit.contract((c) => ({ api: c.rpc('/api', { deals }), shared: linkMount('/s'), other: linkMount('/o') }))

const database: ContractDatabase = {
	tables: tablePolicies(tables),
	locate: (dimension, id) => Promise.resolve(dimension === 'deal' && id === DEAL ? new Map([['company', 'c1'], ['org', 'o1']]) : null),
}

const served = implement(contract, {
	database,
	deps: () => ({}),
	handlers: () => ({
		api: {
			deals: {
				undeclared: async ({ ctx }) => ({ url: (await ctx.links.issue(ctx.target, { mount: 'shared', days: 1 })).url }),
				declared: async ({ ctx }) => ({ url: (await ctx.links.issue(ctx.target, { mount: 'shared', days: 1 })).url }),
				elsewhere: async ({ ctx }) => ({ url: (await ctx.links.issue(ctx.target, { mount: 'other', days: 1 })).url }),
			},
		},
		shared: { deal: () => ({ ok: true }) },
		other: { deal: () => ({ ok: true }) },
	}),
})

describe("a staged-kit contract served through implement runs with the approved artifact's reach", () => {
	test('a plain handler of an endpoint without issues gets no ctx.links, and one with issues only its mount', async () => {
		const iam = new RecordingMembership()
		const app = bootApp(served, {
			environment: environment({ ...frameworkEnvFor(served), FABRIKA_IAM_APP_ID: 'crm@prod' }),
			membership: iam,
		})
		const sharer = await token('user', [grant('deals.share', { type: 'org', value: 'o1' })], 'crm@prod')
		const quiet = (): () => void => {
			const original = console.error
			console.error = () => {}
			return () => {
				console.error = original
			}
		}
		const restore = quiet()
		try {
			expect((await send(app, '/api/deals.undeclared', { token: sharer, body: { id: DEAL } })).status).toBe(500)
			expect((await send(app, '/api/deals.elsewhere', { token: sharer, body: { id: DEAL } })).status).toBe(500)
		} finally {
			restore()
		}
		expect(iam.calls).toEqual([])
		expect(resultOf(await send(app, '/api/deals.declared', { token: sharer, body: { id: DEAL } }))).toEqual({ url: expect.any(String) })
		expect(iam.calls.map((call) => (call.method === 'issueLink' ? call.input.mount : call.method))).toEqual(['shared'])
	})
})
