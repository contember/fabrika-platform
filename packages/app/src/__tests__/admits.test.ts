// A widening condition (`admits`, ADR-0074), through boot behind the production proxy decision, on SQLite: a membership
// role held in an organization with `via` (`~relin` at the tenant partition) lists every public task of that
// organization beside its member rows' tasks. A role held everywhere (`~rel`), one held in a project, an external
// principal and an entry of a relation the contract does not declare admit nothing; `on` reaches no task that only `admits` lists. On Postgres (FABRIKA_TEST_POSTGRES_URL), with
// organizations keyed by uuid, a grant that spells the node in another case admits what the database equates with it.

import { createClient } from '@fabrika/app/client'
import { compileContract, defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { type TestGrant, testKit } from '@fabrika/app/testing'
import { relationInsideScope } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import { testDatabase as postgresDatabase } from '@fabrika/db/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './admits-fixture/tables'
import { vocabulary } from './admits-fixture/vocabulary'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'

const app = defineApp(vocabulary, tables)
const ById = z.strictObject({ id: z.string().min(1) })

const tasks = app.group({ callers: ['human'] }, (r) => ({
	all: r.query({ input: z.strictObject({}), output: z.strictObject({ ids: z.array(z.string()) }), access: { action: 'tasks.read', over: 'project' } })
		.handle(async ({ ctx }) => ({ ids: (await ctx.db.within.tasks.list()).items.map((row) => row.id).sort() })),
	get: r.query({ input: ById, output: z.strictObject({ title: z.string() }), access: { action: 'tasks.read', on: 'task', from: 'id' } })
		.handle(async ({ ctx }) => ({ title: (await ctx.db.target.get()).title })),
	assign: r.mutation({
		input: z.strictObject({ id: z.string().min(1), principal: z.string().min(1) }),
		output: ById,
		access: { action: 'members.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.project_members.insert({ principal_id: input.principal })).id })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { tasks }), health: c.health('/healthz') }))

type Grant = TestGrant<typeof contract>

describe('admits, through boot', () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./admits-fixture/db/migrations/', import.meta.url), label: 'admits.test.ts' })
	})

	afterEach(async () => {
		await fresh.close()
	})

	function world() {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		const owner = kit.testCaller([{ role: 'owner', scope: kit.scope('org', 'o1') }, { role: 'owner', scope: kit.scope('org', 'o2') }], {
			id: 'user:owner',
		})
		const as = (grants: readonly Grant[]) => createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants, { id: 'user:holder' })) }).tasks
		return { kit, as, owner: createClient(contract, 'api', { fetch: kit.browser(owner) }).tasks }
	}

	test("compiles: the dimension's partition and the table's admits reach the artifact", () => {
		const artifact = compileContract(contract, tablePolicies(tables))
		expect(artifact.dimensions['org']?.partition).toBe(true)
		expect(artifact.dimensions['project']).not.toHaveProperty('partition')
		expect(tablePolicies(tables)['tasks']?.admits).toEqual({ 'tasks.read': { visibility: { eq: 'public' } } })
	})

	test("a role held in the organization lists its member rows' tasks and every public task there, never another's", async () => {
		const { kit, as, owner } = world()
		const colleague = as([{ role: 'colleague', scope: kit.scope('org', 'o1') }])
		expect(await colleague.all({})).toEqual({ ids: ['k2'] })
		await owner.assign({ id: 'p1', principal: 'user:holder' })
		expect(await colleague.all({})).toEqual({ ids: ['k1', 'k2'] })
		expect(await as([{ role: 'colleague', scope: kit.scope('org', 'o2') }]).all({})).toEqual({ ids: ['k4'] })
	})

	test('on reaches no task that only admits lists', async () => {
		const { kit, as, owner } = world()
		const colleague = as([{ role: 'colleague', scope: kit.scope('org', 'o1') }])
		await owner.assign({ id: 'p1', principal: 'user:holder' })
		expect(await colleague.get({ id: 'k1' })).toEqual({ title: 'one' })
		await expect(colleague.get({ id: 'k2' })).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('a relation held everywhere, one held inside the partition, and an external principal admit nothing', async () => {
		const { kit, as, owner } = world()
		await owner.assign({ id: 'p1', principal: 'user:holder' })
		expect(await as([{ role: 'lead' }]).all({})).toEqual({ ids: ['k1'] })
		expect(await as([{ role: 'lead', scope: kit.scope('project', 'p1') }]).all({})).toEqual({ ids: ['k1'] })
		const guest = createClient(contract, 'api', {
			fetch: kit.browser(kit.testCaller([{ role: 'guest', scope: kit.scope('project', 'p1') }], { id: 'user:guest', affiliation: 'external' })),
		}).tasks
		expect(await guest.all({})).toEqual({ ids: ['k1'] })
		expect(() => kit.testCaller([{ role: 'colleague', scope: kit.scope('org', 'o1') }], { id: 'user:other', affiliation: 'external' })).toThrow(
			'an external caller holds only roles the contract declares external',
		)
	})

	test('an entry at the partition for a relation the contract does not declare admits nothing', async () => {
		// A token signed before a revision dropped the relation: boot reads it as the proxy forwards it.
		const served = serve(contract, { database: scoped(tables) })
		const audience = 'boards@prod'
		const booted = bootApp(served, { database: fresh.database, environment: environment({ ...frameworkEnvFor(served), FABRIKA_IAM_APP_ID: audience }) })
		const atO1 = (relation: string) => grant('tasks.read', relationInsideScope({ relation, dimension: 'org', node: 'o1' }))
		const declared = await token('user', [atO1('member')], audience)
		expect(resultOf(await send(booted, '/api/tasks.all', { token: declared, body: {} }))).toEqual({ ids: ['k2'] })
		const dropped = await token('user', [atO1('mentor')], audience)
		expect((await send(booted, '/api/tasks.all', { token: dropped, body: {} })).status).toBe(403)
	})
})

const postgres = await postgresDatabase({ migrations: new URL('./admits-fixture/db/migrations-postgres/', import.meta.url), label: 'admits.test.ts' })
afterAll(() => postgres?.close())

describe.skipIf(postgres === null)('admits in organizations keyed by uuid, on Postgres', () => {
	if (postgres === null) return
	const o1 = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01'

	test('a grant that spells the partition node in another case admits what the database equates with it', async () => {
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
		const colleague = createClient(contract, 'api', {
			fetch: kit.browser(kit.testCaller([{ role: 'colleague', scope: kit.scope('org', o1.toUpperCase()) }], { id: 'user:holder' })),
		}).tasks
		expect(await colleague.all({})).toEqual({ ids: ['k2'] })
		await expect(colleague.get({ id: 'k2' })).rejects.toMatchObject({ httpStatus: 404 })
	})
})
