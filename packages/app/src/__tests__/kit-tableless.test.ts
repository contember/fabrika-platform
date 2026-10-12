// A kit without tables (`defineApp(vocabulary)`, an application on Cloudflare, which has no data layer): it is served
// with `database: null` and only so, its handlers have no `ctx.db`, and a site that declares `sql` does not boot.

import { defineApp, defineVocabulary, type Unavailable } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract as withTables } from './access-fixture/fabrika.contract'
import { tables } from './access-fixture/src/db/tables'

const vocabulary = defineVocabulary({
	app: 'plain',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: { reader: { grants: ['projects.read'] } },
})
const app = defineApp(vocabulary)
const Readable = z.strictObject({ values: z.array(z.string()), db: z.boolean() })

const projects = app.group({ callers: ['human'] }, (r) => ({
	readable: r.query({ output: Readable, access: { action: 'projects.read', over: 'project' } })
		.handle(({ ctx }) => {
			const db: Unavailable<'this application declares no tables: defineApp(vocabulary, tables) gives ctx.db'> = ctx.db
			return { values: ctx.within.values === 'all' ? [] : [...ctx.within.values], db: db !== undefined }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { projects }), health: c.health('/healthz') }))

describe('a kit without tables', () => {
	test('is served with database: null; its handler answers from the grants and has no ctx.db', async () => {
		const kit = testKit(serve(contract, { database: null }))
		const reader = kit.testCaller([{ action: 'projects.read', scope: { type: 'project', value: 'p1' } }])
		const response = await kit.browser(reader)('/api/projects.readable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(await response.json()).toEqual({ result: { values: ['p1'], db: false } })
	})

	test('takes no database, and a kit with tables takes one', () => {
		expect(() => serve(contract, { database: scoped(tables) })).toThrow('defineApp(vocabulary) declares no tables, so it takes database: null')
		expect(() => serve(withTables, { database: null })).toThrow('the kit declares tables, so it takes database: scoped(tables)')
	})

	test('a site that declares sql does not boot: ctx.sql runs on @fabrika/db', () => {
		const reports = app.group({ callers: ['human'] }, (r) => ({
			count: r.query({ output: Readable, access: { action: 'projects.read', over: 'project' }, sql: 'read' })
				.handle(() => ({ values: [], db: false })),
		}))
		const declaring = app.contract((c) => ({ api: c.rpc('/api', { reports }), health: c.health('/healthz') }))
		expect(() => testKit(serve(declaring, { database: null }))).toThrow("'api.reports.count' declares sql, which runs on @fabrika/db")
	})
})
