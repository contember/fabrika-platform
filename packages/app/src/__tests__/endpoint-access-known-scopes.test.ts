// The endpoint access kit over a dimension whose values are a fixed set: the input names a region by an enum, and a
// migration writes the regions table. The cases ask from the enum's first two values, use a region row the migration
// wrote and remove every row they inserted, and still find another scope's rows, or a stored row's texts, in an answer.
// A dimension no table owns takes the enum's values too; a field of one value cannot hold two scopes. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// The enum holds a region the migration does not write, which the kit inserts for its case and removes after it. A
// region holds one profile at most, so a profile a case leaves behind fails the next one.
const migration = (rows: string) => `
create table regions (id text primary key, name text not null, active boolean not null default false);
${rows}
create table items (
	id uuid primary key,
	region_id text not null references regions (id),
	title text not null,
	created_by text not null,
	version integer not null
);
create table profiles (id uuid primary key, region_id text not null unique references regions (id), bio text not null);
`

const vocabulary = defineVocabulary({
	app: 'regions',
	dimensions: { region: {}, item: { in: 'region' }, profile: { in: 'region' }, zone: {} },
	actions: { 'items.read': 'Read items', 'items.write': 'Write items' },
	roles: {},
})

interface DB {
	regions: { id: string; name: string; active: boolean }
	items: { id: string; region_id: string; title: string; created_by: string; version: number }
	profiles: { id: string; region_id: string; bio: string }
}

const columns: TypedColumnList<DB> = {
	regions: { columns: ['id', 'name', 'active'], foreignKeys: [] },
	items: {
		columns: ['id', 'region_id', 'title', 'created_by', 'version'],
		foreignKeys: [{ columns: ['region_id'], table: 'regions', references: ['id'] }],
	},
	profiles: { columns: ['id', 'region_id', 'bio'], foreignKeys: [{ columns: ['region_id'], table: 'regions', references: ['id'] }] },
}

const tables = defineTables(vocabulary, columns)({
	regions: { scope: { dimension: 'region' }, actions: { read: 'items.read' } },
	items: {
		scope: { dimension: 'item' },
		actions: { read: 'items.read', insert: 'items.write' },
		insert: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	profiles: { scope: { dimension: 'profile' }, actions: { read: 'items.read' } },
})

const app = defineApp(vocabulary, tables)

const Region = z.enum(['eu', 'us', 'apac'])
const Zone = z.enum(['north', 'south'])
const InRegion = z.strictObject({ region: Region })
const Titles = z.strictObject({ titles: z.array(z.string()) })
const Title = z.strictObject({ title: z.string() })
const Name = z.strictObject({ name: z.string() })

const regions = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: InRegion, output: z.strictObject({ name: z.string() }), access: { action: 'items.read', on: 'region', from: 'region' } })
		.handle(async ({ ctx }) => ({ name: (await ctx.db.target.get()).name })),
	add: r.mutation({
		input: z.strictObject({ region: Region, title: z.string().min(1) }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'items.write', in: 'region', from: 'region' },
	}).handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.items.insert({ title: input.title })).id })),
	titles: r.query({ input: InRegion, output: Titles, access: { action: 'items.read', in: 'region', from: 'region' } })
		.handle(async ({ ctx }) => ({ titles: (await ctx.db.target.items.list()).items.map((item) => item.title) })),
	everyName: r.query({
		input: InRegion,
		output: z.strictObject({ names: z.array(z.string()) }),
		access: { action: 'items.read', on: 'region', from: 'region' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({ names: (await ctx.sql(Name)`select name from regions order by name`).map((row) => row.name) })),
	profile: r.query({
		input: z.strictObject({ region: Region, profile: z.string() }),
		output: z.strictObject({ bio: z.string() }),
		access: { action: 'items.read', on: 'region', from: 'region' },
	}).handle(async ({ input, ctx }) => {
		const profile = (await ctx.db.target.profiles.list({ where: [['id', '=', input.profile]] })).items[0]
		return { bio: profile?.bio ?? '' }
	}),
	everyTitle: r.query({ input: InRegion, output: Titles, access: { action: 'items.read', in: 'region', from: 'region' }, sql: 'read' })
		.handle(async ({ ctx }) => ({ titles: (await ctx.sql(Title)`select title from items order by title`).map((row) => row.title) })),
	zone: r.query({
		input: z.strictObject({ zone: Zone }),
		output: z.strictObject({ zone: z.string() }),
		access: { action: 'items.read', in: 'zone', from: 'zone' },
	})
		.handle(({ ctx }) => ({ zone: ctx.target.value })),
	// An answer whose text holds the other value as a part of a word, which is no leak.
	status: r.query({
		input: z.strictObject({ zone: z.enum(['north', 'us']) }),
		output: z.strictObject({ status: z.string() }),
		access: { action: 'items.read', in: 'zone', from: 'zone' },
	}).handle(() => ({ status: 'business as usual' })),
	north: r.query({
		input: z.strictObject({ zone: z.literal('north') }),
		output: z.strictObject({ zone: z.string() }),
		access: { action: 'items.read', in: 'zone', from: 'zone' },
	}).handle(({ ctx }) => ({ zone: ctx.target.value })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { regions }) }))

const directories: string[] = []
const database = async (rows: string) => {
	const migrations = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-known-'))
	directories.push(migrations)
	writeFileSync(join(migrations, '20261103120000_regions.sql'), migration(rows))
	return testDatabase({ migrations, label: 'endpoint-access-known-scopes.test.ts' })
}
const postgres = await database(`insert into regions (id, name) values ('eu', 'Europe'), ('us', 'United States');`)
const unwritten = await database('')

afterAll(async () => {
	await postgres?.close()
	await unwritten?.close()
	for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(postgres === null)('the endpoint access kit over a dimension whose values are an enum', () => {
	const accessKit = (database = postgres) => {
		if (database === null) throw new Error('no test database')
		return endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database)
	}

	test('every case asks from two values of the enum, the stored region and one it inserts, case after case', async () => {
		const kit = accessKit()
		for (let round = 0; round < 2; round++) {
			expect(await kit.denied('api.regions.get', { region: 'eu' })).toEqual({ status: 404 })
			expect(await kit.own('api.regions.get', { region: 'eu' })).toEqual({ status: 200 })
			expect(await kit.leaked('api.regions.get', { region: 'eu' })).toEqual({ answered: true, leaked: [] })
			expect(await kit.denied('api.regions.add', { region: 'eu', title: 'x' })).toEqual({ status: 403 })
			expect(await kit.leaked('api.regions.add', { region: 'eu', title: 'x' })).toEqual({ answered: true, leaked: [] })
			expect(await kit.leaked('api.regions.titles', { region: 'eu' })).toEqual({ answered: true, leaked: [] })
		}
	})

	test("an answer that holds another region's rows is still caught", async () => {
		const leaky = await accessKit().leaked('api.regions.everyTitle', { region: 'eu' })
		expect(leaky.answered).toBe(true)
		expect(leaky.leaked.length).toBeGreaterThan(0)
	})

	test("an answer that holds the other region's stored name is caught", async () => {
		// The cases ask from the enum's first two values in canonical order: apac, inserted, and eu, the stored Europe.
		const leaky = await accessKit().leaked('api.regions.everyName', { region: 'eu' })
		expect(leaky).toEqual({ answered: true, leaked: ['"Europe"'] })
	})

	test('a row seeded in a stored region is removed after its case', async () => {
		const kit = accessKit()
		for (let round = 0; round < 2; round++) {
			expect(await kit.own('api.regions.profile', { region: 'eu', profile: 'fabrika:row:profiles' })).toEqual({ status: 200 })
			expect(await kit.leaked('api.regions.profile', { region: 'eu', profile: 'fabrika:row:profiles' })).toEqual({ answered: true, leaked: [] })
		}
	})

	test('a seed of the region applies when another table could have inserted the region first', async () => {
		const kit = accessKit(unwritten)
		expect(await kit.denied('api.regions.titles', { region: 'eu' }, { active: true })).toEqual({ status: 403 })
		expect(await kit.leaked('api.regions.titles', { region: 'eu' }, { active: true })).toEqual({ answered: true, leaked: [] })
	})

	test('a dimension no table owns takes the values of the enum', async () => {
		const kit = accessKit()
		expect(await kit.denied('api.regions.zone', { zone: 'north' })).toEqual({ status: 403 })
		expect(await kit.leaked('api.regions.zone', { zone: 'north' })).toEqual({ answered: true, leaked: [] })
	})

	test('a value of the enum counts only as a whole string, not as a part of a word', async () => {
		expect(await accessKit().leaked('api.regions.status', { zone: 'north' })).toEqual({ answered: true, leaked: [] })
	})

	test('a field of one value cannot hold two scopes, and says so', async () => {
		await expect(accessKit().denied('api.regions.north', { zone: 'north' })).rejects.toThrow(
			"the input field a zone is read from admits only 'north', so no case can ask from two scopes of it",
		)
	})
})
