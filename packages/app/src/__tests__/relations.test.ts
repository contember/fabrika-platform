// Relation grants through boot, behind the production proxy decision, on SQLite: a global grant of a role with `via`
// carries `~rel` entries, a scoped one `~relin` entries that hold only inside its node, and `on` and `over` endpoints reach a project exactly while a member row names the caller
// there. Assigning a member is a delegation the table's `assign` bounds; removing the row revokes at the next request.
// A staff row confers through the person it references, whose directory row holds the principal.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './relations-fixture/tables'
import { vocabulary } from './relations-fixture/vocabulary'

const app = defineApp(vocabulary, tables)
const ById = z.strictObject({ id: z.string().min(1) })
const DAY = 86_400_000
const Done = z.strictObject({ done: z.literal(true) })

const projects = app.group({ callers: ['human'] }, (r) => ({
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
		input: z.strictObject({ id: z.string().min(1), principal: z.string().min(1), days: z.number().int() }),
		output: ById,
		access: { action: 'members.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const saved = await ctx.db.target.project_members.insert({
				principal_id: input.principal,
				expires_at: new Date(Date.now() + input.days * DAY),
			})
			return { id: saved.id }
		}),
	staff: r.mutation({
		input: z.strictObject({ id: z.string().min(1), person: z.string().min(1) }),
		output: ById,
		access: { action: 'staff.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.project_staff.insert({ person_id: input.person })).id })),
	unassign: r.mutation({
		input: z.strictObject({ id: z.string().min(1), member: z.string().min(1) }),
		output: Done,
		access: { action: 'members.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.project_members.remove(input.member)
			return { done: true }
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { projects }), health: c.health('/healthz') }))

describe('a relation grant through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./relations-fixture/db/migrations/', import.meta.url), label: 'relations.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	function world() {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		const assistant = kit.testCaller([{ role: 'assistant' }], { id: 'user:assistant' })
		const lead = kit.testCaller([{ role: 'lead', scope: kit.scope('project', 'p1') }, { role: 'lead', scope: kit.scope('project', 'p3') }], {
			id: 'user:lead',
		})
		return {
			kit,
			staffer: createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'staffer' }], { id: 'user:staffer' })) }).projects,
			assistant: createClient(contract, 'api', { fetch: kit.browser(assistant) }).projects,
			lead: createClient(contract, 'api', { fetch: kit.browser(lead) }).projects,
			scopedAssistant: createClient(contract, 'api', {
				fetch: kit.browser(kit.testCaller([{ role: 'assistant', scope: kit.scope('project', 'p3') }], { id: 'user:scoped' })),
			}).projects,
		}
	}

	test('the role reaches nothing until a member row names the principal, then exactly that node', async () => {
		const { assistant, lead } = world()
		await expect(assistant.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await assistant.list({})).toEqual({ ids: [] })
		await lead.assign({ id: 'p1', principal: 'user:assistant', days: 7 })
		expect(await assistant.get({ id: 'p1' })).toEqual({ name: 'one' })
		await expect(assistant.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await assistant.list({})).toEqual({ ids: ['p1'] })
		expect(await assistant.rename({ id: 'p1', name: 'renamed' })).toEqual({ done: true })
	})

	test('removing the member row revokes at the next request', async () => {
		const { assistant, lead } = world()
		const { id } = await lead.assign({ id: 'p1', principal: 'user:assistant', days: 7 })
		expect(await assistant.get({ id: 'p1' })).toEqual({ name: 'one' })
		await lead.unassign({ id: 'p1', member: id })
		await expect(assistant.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await assistant.list({})).toEqual({ ids: [] })
	})

	test("the action's condition holds a relation grant too: an archived project is read, never renamed", async () => {
		const { assistant, lead } = world()
		await lead.assign({ id: 'p3', principal: 'user:assistant', days: 7 })
		expect(await assistant.get({ id: 'p3' })).toEqual({ name: 'archived' })
		await expect(assistant.rename({ id: 'p3', name: 'x' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('a scoped grant of the role holds the relation inside its node only', async () => {
		const { scopedAssistant, lead } = world()
		expect(await scopedAssistant.list({})).toEqual({ ids: [] })
		await lead.assign({ id: 'p1', principal: 'user:scoped', days: 7 })
		await expect(scopedAssistant.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await scopedAssistant.list({})).toEqual({ ids: [] })
		await lead.assign({ id: 'p3', principal: 'user:scoped', days: 7 })
		expect(await scopedAssistant.get({ id: 'p3' })).toEqual({ name: 'archived' })
		expect(await scopedAssistant.list({})).toEqual({ ids: ['p3'] })
		await expect(scopedAssistant.rename({ id: 'p1', name: 'x' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('a delegation longer than the bound, or to the delegator itself, is a 409 and writes nothing', async () => {
		const { assistant, lead } = world()
		await expect(lead.assign({ id: 'p1', principal: 'user:assistant', days: 31 })).rejects.toMatchObject({ httpStatus: 409 })
		await expect(lead.assign({ id: 'p1', principal: 'user:lead', days: 1 })).rejects.toMatchObject({ httpStatus: 409 })
		await expect(assistant.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('a relation whose principal the row a staff row references holds reaches the project, and names no delegator', async () => {
		const { staffer, lead } = world()
		await expect(staffer.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		await lead.staff({ id: 'p1', person: 'pe-staffer' })
		expect(await staffer.get({ id: 'p1' })).toEqual({ name: 'one' })
		await expect(staffer.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await staffer.list({})).toEqual({ ids: ['p1'] })
		await expect(lead.staff({ id: 'p1', person: 'pe-lead' })).rejects.toMatchObject({ httpStatus: 409 })
	})
})
