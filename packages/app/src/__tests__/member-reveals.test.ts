// A member reveal through boot, behind the production proxy decision, on SQLite: a grant at an open step lists the
// step's project `over` project, and only a grant at the step itself counts. `on` mints a Ref of the revealed project
// that carries the grant, while the step reveals it, and the Ref writes what the reveal lists.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './member-reveals-fixture/tables'
import { vocabulary } from './member-reveals-fixture/vocabulary'

const app = defineApp(vocabulary, tables)

const api = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({
		input: z.strictObject({ id: z.string().min(1) }),
		output: z.strictObject({ name: z.string() }),
		access: { action: 'projects.read', on: 'project', from: 'id' },
	})
		.handle(async ({ ctx }) => ({ name: (await ctx.db.target.get()).name })),
	rename: r.mutation({
		input: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
		output: z.strictObject({}),
		access: { action: 'projects.rename', on: 'project', from: 'id' },
	})
		.handle(async ({ ctx, input }) => {
			await ctx.db.target.update({ name: input.name }, { expectVersion: 1 })
			return {}
		}),
	list: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ ids: z.array(z.string()) }),
		access: { action: 'projects.read', over: 'project' },
	})
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.projects.list()).items.map((row) => row.id).sort() })),
	tasks: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ ids: z.array(z.string()) }),
		access: { action: 'steps.read', over: 'project' },
	})
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.tasks.list()).items.map((row) => row.id).sort() })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { api }), health: c.health('/healthz') }))

describe('a member reveal through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./member-reveals-fixture/db/migrations/', import.meta.url), label: 'member-reveals.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	type Action = 'projects.read' | 'projects.rename' | 'steps.read'
	type Grant = { readonly action: Action; readonly scope: { readonly type: 'project' | 'task' | 'step'; readonly value: string } }

	function caller(action: Action, type: Grant['scope']['type'], value: string) {
		return callerOf([{ action, scope: { type, value } }])
	}

	function callerOf(grants: readonly Grant[]) {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		return createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants, { id: 'user:member' })) }).api
	}

	test("a grant at an open step lists the step's project and no other", async () => {
		expect(await caller('projects.read', 'step', 's1').list({})).toEqual({ ids: ['p1'] })
	})

	test('a closed step reveals nothing', async () => {
		expect(await caller('projects.read', 'step', 's2').list({})).toEqual({ ids: [] })
	})

	test('a grant at the task that holds the step is not one at the step', async () => {
		expect(await caller('projects.read', 'task', 't1').list({})).toEqual({ ids: [] })
	})

	test('a grant of an action the reveal does not list reveals nothing', async () => {
		expect(await caller('steps.read', 'step', 's1').tasks({})).toEqual({ ids: [] })
	})

	test('on mints a Ref of the project an open step reveals, and of no other', async () => {
		expect(await caller('projects.read', 'step', 's1').get({ id: 'p1' })).toEqual({ name: 'one' })
		await expect(caller('projects.read', 'step', 's1').get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		await expect(caller('projects.read', 'step', 's2').get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		await expect(caller('projects.read', 'task', 't1').get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('the Ref writes what the reveal lists, and only for the action its grant holds', async () => {
		await expect(caller('projects.read', 'step', 's1').rename({ id: 'p1', name: 'renamed' })).rejects.toMatchObject({ httpStatus: 403 })
		const member = callerOf([{ action: 'projects.rename', scope: { type: 'step', value: 's1' } }, {
			action: 'projects.read',
			scope: { type: 'step', value: 's1' },
		}])
		expect(await member.rename({ id: 'p1', name: 'renamed' })).toEqual({})
		expect(await member.get({ id: 'p1' })).toEqual({ name: 'renamed' })
	})
})
