// A relation held inside a node, through boot behind the production proxy decision, on SQLite: a membership role held
// in an organization with `via` carries `~relin` entries, and `on` and `over` endpoints reach a project of that
// organization exactly while a member row names the caller there; a member row in another organization reaches nothing.
// On Postgres (FABRIKA_TEST_POSTGRES_URL), with organizations keyed by uuid, `on` holds the node exactly where `over` does.

import { createClient } from '@fabrika/app/client'
import { compileContract, ContractError, defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { relationInsideScope } from '@fabrika/auth-core'
import { MAX_WITHIN_VALUES, scoped } from '@fabrika/db'
import { defineTables, tablePolicies } from '@fabrika/db/tables'
import { testDatabase as postgresDatabase } from '@fabrika/db/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { columns, policies, tables } from './relations-inside-fixture/tables'
import { vocabulary } from './relations-inside-fixture/vocabulary'

const app = defineApp(vocabulary, tables)
const ById = z.strictObject({ id: z.string().min(1) })
const Done = z.strictObject({ done: z.literal(true) })

const projects = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: z.strictObject({ name: z.string() }), access: { action: 'projects.read', on: 'project', from: 'id' } })
		.handle(async ({ ctx }) => ({ name: (await ctx.db.target.get()).name })),
	all: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ ids: z.array(z.string()) }),
		access: { action: 'projects.read', over: 'project' },
	})
		// A Within of a contained dimension lists the tables inside it: the member rows of the projects it reaches.
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.project_members.list()).items.map((row) => row.project_id).sort() })),
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
		access: { action: 'members.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.project_members.insert({ principal_id: input.principal })).id })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { projects }), health: c.health('/healthz') }))

describe('a relation held inside an organization, through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./relations-inside-fixture/db/migrations/', import.meta.url), label: 'relations-inside.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	function world() {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		const lead = kit.testCaller([{ role: 'lead', scope: kit.scope('org', 'o1') }], { id: 'user:lead' })
		const owner = kit.testCaller([{ role: 'owner', scope: kit.scope('org', 'o1') }, { role: 'owner', scope: kit.scope('org', 'o2') }], {
			id: 'user:owner',
		})
		return {
			lead: createClient(contract, 'api', { fetch: kit.browser(lead) }).projects,
			owner: createClient(contract, 'api', { fetch: kit.browser(owner) }).projects,
		}
	}

	test('reaches a project of the organization only while a member row names the caller there', async () => {
		const { lead, owner } = world()
		await expect(lead.get({ id: 'p1' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await lead.all({})).toEqual({ ids: [] })
		await owner.assign({ id: 'p1', principal: 'user:lead' })
		expect(await lead.get({ id: 'p1' })).toEqual({ name: 'one' })
		await expect(lead.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await lead.all({})).toEqual({ ids: ['p1'] })
		expect(await lead.rename({ id: 'p1', name: 'renamed' })).toEqual({ done: true })
	})

	test('a member row in another organization reaches nothing', async () => {
		const { lead, owner } = world()
		await owner.assign({ id: 'p3', principal: 'user:lead' })
		await expect(lead.get({ id: 'p3' })).rejects.toMatchObject({ httpStatus: 404 })
		await expect(lead.rename({ id: 'p3', name: 'x' })).rejects.toMatchObject({ httpStatus: 404 })
		expect(await lead.all({})).toEqual({ ids: [] })
	})
})

const postgres = await postgresDatabase({
	migrations: new URL('./relations-inside-fixture/db/migrations-postgres/', import.meta.url),
	label: 'relations-inside.test.ts',
})
afterAll(() => postgres?.close())

describe.skipIf(postgres === null)('a relation held inside an organization keyed by uuid, on Postgres', () => {
	if (postgres === null) return
	const o1 = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01'

	test('a grant that spells the node in another case reaches what the database equates with it, on and over alike', async () => {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
		const lead = kit.testCaller([{ role: 'lead', scope: kit.scope('org', o1.toUpperCase()) }], { id: 'user:lead' })
		const owner = kit.testCaller([{ role: 'owner', scope: kit.scope('org', o1) }, {
			role: 'owner',
			scope: kit.scope('org', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02'),
		}], { id: 'user:owner' })
		const leads = createClient(contract, 'api', { fetch: kit.browser(lead) }).projects
		const owners = createClient(contract, 'api', { fetch: kit.browser(owner) }).projects
		await owners.assign({ id: 'p1', principal: 'user:lead' })
		await owners.assign({ id: 'p3', principal: 'user:lead' })
		expect(await leads.all({})).toEqual({ ids: ['p1'] })
		expect(await leads.get({ id: 'p1' })).toEqual({ name: 'one' })
		expect(await leads.rename({ id: 'p1', name: 'renamed' })).toEqual({ done: true })
		await expect(leads.get({ id: 'p2' })).rejects.toMatchObject({ httpStatus: 404 })
		await expect(leads.get({ id: 'p3' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test(`a node among more than ${MAX_WITHIN_VALUES} held inside still gets its Ref: the nodes are asked in batches`, async () => {
		// Past the kit's token size bound, so the token goes to boot directly, as the proxy forwards it.
		const served = serve(contract, { database: scoped(tables) })
		const audience = 'orgs@prod'
		const app = bootApp(served, { database: postgres.database, environment: environment({ ...frameworkEnvFor(served), FABRIKA_IAM_APP_ID: audience }) })
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
		const owner = kit.testCaller([{ role: 'owner', scope: kit.scope('org', o1) }], { id: 'user:owner' })
		await createClient(contract, 'api', { fetch: kit.browser(owner) }).projects.assign({ id: 'p2', principal: 'user-1' })
		const nodes = [...Array.from({ length: MAX_WITHIN_VALUES }, (_, index) => `0193a1b2-c3d4-7e5f-8a9b-${String(index).padStart(12, '0')}`), o1]
		const inside = nodes.map((node) => grant('projects.read', relationInsideScope({ relation: 'member', dimension: 'org', node })))
		const lead = await token('user', inside, audience)
		expect(resultOf(await send(app, '/api/projects.get', { token: lead, body: { id: 'p2' } }))).toEqual({ name: 'two' })
		expect((await send(app, '/api/projects.get', { token: lead, body: { id: 'p3' } })).status).toBe(404)
	})
})

describe('a membership role that holds actions via a relation', () => {
	const problemsOf = (compile: () => unknown): readonly string[] => {
		try {
			compile()
			return []
		} catch (error) {
			if (error instanceof ContractError) return error.problems
			throw error
		}
	}

	test('holds a relation whose dimension is its own or lies inside it', () => {
		expect(problemsOf(() => compileContract(contract, tablePolicies(tables)))).toEqual([])
		const coaching = defineVocabulary({
			...vocabulary,
			dimensions: { ...vocabulary.dimensions, team: {} },
			roles: { ...vocabulary.roles, coach: { grants: [], member: { scope: 'team', assignableBy: ['coach'] }, via: { member: ['projects.read'] } } },
		})
		const coached = defineTables(coaching, columns)(policies)
		const coach = defineApp(coaching, coached).contract((c) => ({ health: c.health('/healthz') }))
		expect(problemsOf(() => compileContract(coach, tablePolicies(coached)))).toEqual([
			"role 'coach': holds actions via 'member', whose dimension 'project' is not 'team' and does not lie inside it: a membership role holds a relation inside the value it is held in",
		])
	})

	test('is never an external role', () => {
		const guests = defineVocabulary({
			...vocabulary,
			roles: {
				...vocabulary.roles,
				guest: { grants: [], member: { scope: 'org', assignableBy: ['owner'] }, external: true, via: { member: ['projects.read'] } },
			},
		})
		const guested = defineTables(guests, columns)(policies)
		const guest = defineApp(guests, guested).contract((c) => ({ health: c.health('/healthz') }))
		expect(problemsOf(() => compileContract(guest, tablePolicies(guested)))).toEqual([
			"role 'guest': holds actions via a relation and is an external role: an external principal holds no relation",
		])
	})
})
