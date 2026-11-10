// Writes through a secondary path, through boot, behind the production proxy decision, on SQLite: a grant at the team
// a task's `team_id` names, or a relation there, gets a Ref of the task from `on`, and through the reveal matched
// through the path a Ref of its project. An insert that names a team needs its writer to hold, at that team, every
// action the column hands out. A grant at the team also reads the task's project through a member reveal, whose
// `assign` keeps a writer from naming a team where it holds such a grant. A webhook binding refuses a Ref held through
// the path. A caller with more path grants than one
// statement binds is asked in batches, on Postgres (FABRIKA_TEST_POSTGRES_URL).

import { createClient } from '@fabrika/app/client'
import { defineApp, WebhookSecret } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { MAX_WITHIN_VALUES, scoped } from '@fabrika/db'
import { testDatabase as postgresDatabase } from '@fabrika/db/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { tables } from './write-through-fixture/tables'
import { vocabulary } from './write-through-fixture/vocabulary'

const app = defineApp(vocabulary, tables)
const Done = z.strictObject({ done: z.literal(true) })

const api = app.group({ callers: ['human'] }, (r) => ({
	task: r.query({
		input: z.strictObject({ id: z.string().min(1) }),
		output: z.strictObject({ title: z.string() }),
		access: { action: 'tasks.read', on: 'task', from: 'id' },
	})
		.handle(async ({ ctx }) => ({ title: (await ctx.db.target.get()).title })),
	retitle: r.mutation({
		input: z.strictObject({ id: z.string().min(1), title: z.string().min(1) }),
		output: Done,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.update({ title: input.title }, { expectVersion: 1 })
			return { done: true }
		}),
	rename: r.mutation({
		input: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
		output: Done,
		access: { action: 'projects.rename', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.update({ name: input.name }, { expectVersion: 1 })
			return { done: true }
		}),
	projects: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ ids: z.array(z.string()) }),
		access: { action: 'projects.read', over: 'project' },
	})
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.projects.list()).items.map((row) => row.id).sort() })),
	add: r.mutation({
		input: z.strictObject({ project: z.string().min(1), team: z.string().min(1), title: z.string().min(1) }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'tasks.insert', in: 'project', from: 'project' },
	})
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.tasks.insert({ title: input.title, team_id: input.team })).id })),
}))

const signedBody = { header: 'X-Hook-Signature', algorithm: 'sha256', encoding: 'hex', signed: 'body' } as const
const Event = z.strictObject({ id: z.string() })
const taskHook = app.webhook('/hooks/tasks', { scheme: { hmac: signedBody }, boundTo: 'task', actions: ['tasks.write'], input: Event })
	.handle(() => {})

/** A binding outlives its request, so `on` or `in` handing it a Ref held through a path is refused. */
const hooks = app.group({ callers: ['human'] }, (r) => ({
	task: r.mutation({
		input: z.strictObject({ id: z.string().min(1) }),
		output: WebhookSecret,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
		binds: 'taskHook',
	})
		.handle(({ ctx }) => ctx.webhooks('taskHook').bind(ctx.target, 'account')),
	taskIn: r.mutation({
		input: z.strictObject({ id: z.string().min(1) }),
		output: WebhookSecret,
		access: { action: 'tasks.write', in: 'task', from: 'id' },
		binds: 'taskHook',
	})
		.handle(({ ctx }) => ctx.webhooks('taskHook').bind(ctx.target, 'account')),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { api, hooks }), health: c.health('/healthz'), taskHook }))

type Action = 'tasks.read' | 'tasks.write' | 'tasks.insert' | 'projects.rename' | 'projects.read'
type Grant =
	| { readonly role: 'member' }
	| { readonly action: Action; readonly scope: { readonly type: 'team' | 'project' | 'task'; readonly value: string } }

describe('a write path through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./write-through-fixture/db/migrations/', import.meta.url), label: 'write-through.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	function callerOf(grants: readonly Grant[], id = 'user:member') {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		return createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants, { id })) }).api
	}

	function binderOf(grants: readonly Grant[]) {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		return createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants, { id: 'user:member' })) }).hooks
	}

	const atTeam = (action: Action, team: string): Grant => ({ action, scope: { type: 'team', value: team } })

	test('a grant at the team a task names gets a Ref of the task, and of no task of another team', async () => {
		const reader = callerOf([atTeam('tasks.read', 't1')])
		expect(await reader.task({ id: 'k1' })).toEqual({ title: 'one' })
		await expect(reader.task({ id: 'k2' })).rejects.toMatchObject({ httpStatus: 404 })
		const writer = callerOf([atTeam('tasks.write', 't1')])
		expect(await writer.retitle({ id: 'k1', title: 'renamed' })).toEqual({ done: true })
		await expect(writer.retitle({ id: 'k2', title: 'x' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await reader.task({ id: 'k1' })).toEqual({ title: 'renamed' })
	})

	test("a member of the task's team acts on the task, and through the reveal renames its project", async () => {
		const member = callerOf([{ role: 'member' }])
		expect(await member.task({ id: 'k1' })).toEqual({ title: 'one' })
		await expect(member.task({ id: 'k2' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await member.retitle({ id: 'k1', title: 'renamed' })).toEqual({ done: true })
		expect(await member.rename({ id: 'p1', name: 'renamed' })).toEqual({ done: true })
		await expect(member.rename({ id: 'p2', name: 'x' })).rejects.toMatchObject({ httpStatus: 404 })
		const outsider = callerOf([{ role: 'member' }], 'user:outsider')
		await expect(outsider.task({ id: 'k1' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('an insert names a team only where its writer holds every action the column hands out', async () => {
		const insert: Grant = { action: 'tasks.insert', scope: { type: 'project', value: 'p1' } }
		const bare = callerOf([insert])
		await expect(bare.add({ project: 'p1', team: 't1', title: 'bare' })).rejects.toMatchObject({ httpStatus: 409 })
		const partial = callerOf([insert, atTeam('tasks.read', 't1'), atTeam('tasks.write', 't1')])
		await expect(partial.add({ project: 'p1', team: 't1', title: 'partial' })).rejects.toMatchObject({ httpStatus: 409 })
		const lead = callerOf([insert, atTeam('tasks.read', 't1'), atTeam('tasks.write', 't1'), atTeam('projects.rename', 't1')])
		expect(await lead.add({ project: 'p1', team: 't1', title: 'held' })).toMatchObject({ id: expect.any(String) })
		await expect(lead.add({ project: 'p1', team: 't2', title: 'other team' })).rejects.toMatchObject({ httpStatus: 409 })
		// A member holds the actions at its team through the relation.
		const member = callerOf([insert, { role: 'member' }])
		expect(await member.add({ project: 'p1', team: 't1', title: 'by member' })).toMatchObject({ id: expect.any(String) })
		await expect(member.add({ project: 'p1', team: 't2', title: 'not a member' })).rejects.toMatchObject({ httpStatus: 409 })
	})

	test.each(['task', 'taskIn'] as const)('%s refuses to bind a webhook with a Ref it minted through a write path', async (procedure) => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			await expect(binderOf([atTeam('tasks.write', 't1')])[procedure]({ id: 'k1' })).rejects.toMatchObject({ httpStatus: 500 })
			const refusals = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('conditional_binding'))
			expect(refusals).toEqual([expect.stringContaining(`api.hooks.${procedure}`)])
		} finally {
			log.mockRestore()
		}
		// The same task binds with a Ref an IAM grant holds.
		const onTask: Grant = { action: 'tasks.write', scope: { type: 'task', value: 'k1' } }
		expect(await binderOf([onTask])[procedure]({ id: 'k1' })).toMatchObject({ url: expect.any(String) })
	})

	test('a grant at a team reads the projects of its tasks, and keeps its holder from naming that team in a new task', async () => {
		expect(await callerOf([atTeam('projects.read', 't1')]).projects({})).toEqual({ ids: ['p1'] })
		expect(await callerOf([atTeam('projects.read', 't2')]).projects({})).toEqual({ ids: ['p1', 'p2'] })
		const handedOut = [atTeam('tasks.read', 't1'), atTeam('tasks.write', 't1'), atTeam('projects.rename', 't1')]
		const insert: Grant = { action: 'tasks.insert', scope: { type: 'project', value: 'p2' } }
		const reader = callerOf([insert, ...handedOut, atTeam('projects.read', 't1')])
		await expect(reader.add({ project: 'p2', team: 't1', title: 'reveals to its writer' })).rejects.toMatchObject({ httpStatus: 409 })
		expect(await callerOf([insert, ...handedOut]).add({ project: 'p2', team: 't1', title: 'reveals to others' })).toMatchObject({
			id: expect.any(String),
		})
		expect(await callerOf([atTeam('projects.read', 't1')]).projects({})).toEqual({ ids: ['p1', 'p2'] })
	})
})

// A Durable Object's SQLite binds at most 100 parameters to a statement, so this case runs on Postgres only.
describe('a write path through boot, on Postgres', () => {
	test(`a grant among more than ${MAX_WITHIN_VALUES} team grants still gets its Ref: the candidates are asked in batches`, async () => {
		const fresh = await postgresDatabase({
			migrations: new URL('./write-through-fixture/db/postgres/', import.meta.url),
			label: 'write-through.test.ts',
		})
		if (fresh === null) return
		try {
			// Past the kit's token size bound, so the token goes to boot directly, as the proxy forwards it.
			const served = serve(contract, { database: scoped(tables) })
			const audience = 'teams@prod'
			const app = bootApp(served, { database: fresh.database, environment: environment({ ...frameworkEnvFor(served), FABRIKA_IAM_APP_ID: audience }) })
			const teams = [...Array.from({ length: MAX_WITHIN_VALUES }, (_, index) => `pad-${index}`), 't1']
			const held = await token('user', teams.map((team) => grant('tasks.read', { type: 'team', value: team })), audience)
			expect(resultOf(await send(app, '/api/api.task', { token: held, body: { id: 'k1' } }))).toEqual({ title: 'one' })
			expect((await send(app, '/api/api.task', { token: held, body: { id: 'k2' } })).status).toBe(404)
		} finally {
			await fresh.close()
		}
	})
})
