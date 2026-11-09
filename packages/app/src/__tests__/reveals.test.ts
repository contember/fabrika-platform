// A relation's reveal through boot, behind the production proxy decision, on SQLite: an assignee of an open task reads
// the task's project, `on` and `over`, for the actions the reveal lists and no other, until the assignment is removed.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './reveals-fixture/tables'
import { vocabulary } from './reveals-fixture/vocabulary'

const app = defineApp(vocabulary, tables)
const ById = z.strictObject({ id: z.string().min(1) })
const Done = z.strictObject({ done: z.literal(true) })

const api = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: z.strictObject({ name: z.string() }), access: { action: 'projects.read', on: 'project', from: 'id' } })
		.handle(async ({ ctx }) => ({ name: (await ctx.db.target.get()).name })),
	list: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ ids: z.array(z.string()) }),
		access: { action: 'projects.read', over: 'project' },
	})
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.projects.list()).items.map((row) => row.id).sort() })),
	rename: r.mutation({
		input: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
		output: Done,
		access: { action: 'projects.write', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.update({ name: input.name }, { expectVersion: 1 })
			return { done: true }
		}),
	assign: r.mutation({
		input: z.strictObject({ id: z.string().min(1), principal: z.string().min(1) }),
		output: ById,
		access: { action: 'tasks.assign', on: 'task', from: 'id' },
	})
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.task_assignees.insert({ principal_id: input.principal })).id })),
	unassign: r.mutation({
		input: z.strictObject({ id: z.string().min(1), assignment: z.string().min(1) }),
		output: Done,
		access: { action: 'tasks.assign', on: 'task', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.task_assignees.remove(input.assignment)
			return { done: true }
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { api }), health: c.health('/healthz') }))

describe('a reveal through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./reveals-fixture/db/migrations/', import.meta.url), label: 'reveals.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	function world() {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		return {
			worker: createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'worker' }], { id: 'user:worker' })) }).api,
			lead: createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'lead' }], { id: 'user:lead' })) }).api,
		}
	}

	test("an assignee of an open task reads the task's project and no other", async () => {
		const { worker, lead } = world()
		await expect(worker.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await worker.list({})).toEqual({ ids: [] })
		await lead.assign({ id: 't1', principal: 'user:worker' })
		expect(await worker.get({ id: 'p1' })).toEqual({ name: 'one' })
		expect(await worker.list({})).toEqual({ ids: ['p1'] })
		await expect(worker.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test("a closed task reveals nothing, and the role's other actions are not revealed", async () => {
		const { worker, lead } = world()
		await lead.assign({ id: 't2', principal: 'user:worker' })
		await expect(worker.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		await lead.assign({ id: 't1', principal: 'user:worker' })
		await expect(worker.rename({ id: 'p1', name: 'renamed' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('removing the assignment revokes at the next request', async () => {
		const { worker, lead } = world()
		const { id } = await lead.assign({ id: 't1', principal: 'user:worker' })
		expect(await worker.get({ id: 'p1' })).toEqual({ name: 'one' })
		await lead.unassign({ id: 't1', assignment: id })
		await expect(worker.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await worker.list({})).toEqual({ ids: [] })
	})
})
