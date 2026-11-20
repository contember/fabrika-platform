// Every table policy is enforced as declared: seeded worlds of random policies, each table probed through the
// production pipeline by the isolation kit and compared with what its policy says. A failure names its seed, which
// rebuilds the world. SQLite always; Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { appPolicyIsolationKit, policyIsolationKit } from '@fabrika/app/testing/isolation'
import { readTables } from '@fabrika/db/tables'
import type { TestDatabase } from '@fabrika/db/testing'
import { testDatabase as postgresDatabase } from '@fabrika/db/testing'
import { testDatabase as sqliteDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ACTIONS = ['data.read', 'data.write', 'data.remove', 'data.audit', 'data.count'] as const
type Action = (typeof ACTIONS)[number]

const vocabulary = defineVocabulary({
	app: 'enforcement',
	dimensions: { org: {}, project: { in: 'org' } },
	actions: {
		'data.read': 'Read',
		'data.write': 'Write',
		'data.remove': 'Remove',
		'data.audit': 'Audit',
		'data.count': 'Count',
	},
	roles: { owner: { grants: [...ACTIONS] } },
})

const contract = defineApp(vocabulary).contract(() => ({}))

type TableName = 'orgs' | 'projects' | 'items' | 'settings'

interface TableShape {
	readonly read: Action
	readonly insert: Action | null
	readonly update: Action | null
	readonly delete: Action | null
	readonly version: boolean
	/** The read action of the `secret` column, or `null` when the table has none. */
	readonly secret: Action | null
	readonly appRead: readonly Action[]
	readonly appCount: readonly Action[]
}

interface World {
	readonly seed: number
	/** The tables of this world; `orgs` is always one of them. */
	readonly tables: ReadonlyMap<TableName, TableShape>
	/** The table `items` is a child of, when the world has one. */
	readonly parent: 'orgs' | 'projects' | null
}

/** mulberry32: a small PRNG whose sequence a seed fixes, so a failing world is rebuilt from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function generateWorld(seed: number): World {
	const next = random(seed)
	const chance = (probability: number): boolean => next() < probability
	const pick = <T>(items: readonly T[]): T => {
		const item = items[Math.floor(next() * items.length)]
		if (item === undefined) throw new Error('pick from an empty list')
		return item
	}
	const subset = (items: readonly Action[]): Action[] => items.filter(() => chance(0.4))
	const shape = (scoped: boolean): TableShape => {
		const read = pick(ACTIONS)
		const others = ACTIONS.filter((action) => action !== read)
		const appRead = scoped ? subset(others) : []
		const appCount = scoped ? subset(others.filter((action) => !appRead.includes(action))) : []
		return {
			read,
			insert: chance(0.75) ? pick(ACTIONS) : null,
			update: chance(0.6) ? pick(ACTIONS) : null,
			delete: chance(0.6) ? pick(ACTIONS) : null,
			version: chance(0.5),
			secret: chance(0.4) ? pick(others) : null,
			appRead,
			appCount,
		}
	}
	const tables = new Map<TableName, TableShape>([['orgs', shape(true)]])
	if (chance(0.6)) tables.set('projects', shape(true))
	const parent = chance(0.7) ? (tables.has('projects') && chance(0.5) ? 'projects' : 'orgs') : null
	if (parent !== null) tables.set('items', shape(true))
	if (chance(0.5)) tables.set('settings', shape(false))
	return { seed, tables, parent }
}

/** The columns of `table` besides its key and placing column, as both dialects create them. */
function ownColumns(shape: TableShape): { readonly name: string; readonly postgres: string; readonly sqlite: string }[] {
	return [
		{ name: 'title', postgres: 'text not null', sqlite: 'TEXT NOT NULL' },
		...(shape.version ? [{ name: 'version', postgres: 'integer not null default 1', sqlite: 'INTEGER NOT NULL DEFAULT 1' }] : []),
		...(shape.secret === null ? [] : [{ name: 'secret', postgres: 'text', sqlite: 'TEXT' }]),
	]
}

/**
 * The columns that place `table` and the key they reference: a contained table's container column, a child's parent
 * column, and under a contained parent the parent's own chain beside it, in one foreign key.
 */
function placing(world: World, table: TableName): { readonly columns: string[]; readonly references: TableName; readonly key: string[] } | null {
	if (table === 'projects') return { columns: ['org_id'], references: 'orgs', key: ['id'] }
	if (table !== 'items' || world.parent === null) return null
	return world.parent === 'orgs'
		? { columns: ['org_id'], references: 'orgs', key: ['id'] }
		: { columns: ['project_id', 'org_id'], references: 'projects', key: ['id', 'org_id'] }
}

function migration(world: World, dialect: 'postgres' | 'sqlite'): string {
	const uuid = dialect === 'postgres' ? 'uuid not null' : 'UUID NOT NULL'
	const statements: string[] = []
	for (const [table, shape] of world.tables) {
		const place = placing(world, table)
		const definitions = [
			dialect === 'postgres' ? 'id uuid primary key' : 'id UUID PRIMARY KEY',
			...(place === null ? [] : place.columns.map((column) => `${column} ${uuid}`)),
			...ownColumns(shape).map((column) => `${column.name} ${column[dialect]}`),
			...(place === null ? [] : [`foreign key (${place.columns.join(', ')}) references ${place.references} (${place.key.join(', ')})`]),
			// A child of a project references the project's key with its org, so the pair is a key of its own.
			...(table === 'projects' && world.parent === 'projects' ? ['unique (id, org_id)'] : []),
		]
		statements.push(`create table ${table} (${definitions.join(', ')});`)
	}
	return statements.join('\n')
}

function columnList(world: World): Record<string, unknown> {
	return Object.fromEntries(
		[...world.tables].map(([table, shape]) => {
			const place = placing(world, table)
			const own = ownColumns(shape)
			const placed = place === null ? [] : place.columns
			const columns = ['id', ...placed, ...own.map((column) => column.name)]
			const notNull = ['id', ...placed, 'title', ...(shape.version ? ['version'] : [])]
			const foreignKeys = place === null ? [] : [{ columns: place.columns, table: place.references, references: place.key }]
			return [table, { columns, foreignKeys, notNull }]
		}),
	)
}

function policyOf(world: World, table: TableName, shape: TableShape): Record<string, unknown> {
	const scope = table === 'orgs'
		? { dimension: 'org' }
		: table === 'projects'
		? { dimension: 'project' }
		: table === 'items'
		? { child: world.parent }
		: { app: 'settings the operator keeps' }
	return {
		scope,
		actions: {
			read: shape.read,
			...(shape.insert === null ? {} : { insert: shape.insert }),
			...(shape.update === null ? {} : { update: shape.update }),
			...(shape.delete === null ? {} : { delete: shape.delete }),
			...(shape.appRead.length === 0 ? {} : { appRead: shape.appRead }),
			...(shape.appCount.length === 0 ? {} : { appCount: shape.appCount }),
		},
		...(shape.insert === null ? {} : { insert: ['title'] }),
		...(shape.update === null ? {} : { update: ['title'] }),
		...(shape.version ? { version: 'version' } : {}),
		...(shape.secret === null ? {} : { columns: { secret: { read: shape.secret } } }),
	}
}

type Outcomes = Record<string, unknown>

/** What the policy of a dimension or child table says each probe answers. */
function expectedScoped(table: TableName, shape: TableShape): Outcomes {
	const child = table === 'items'
	const contained = child || table === 'projects'
	const expected: Outcomes = {
		'get own': 200,
		'get other': 404,
		list: { status: 200, rows: ['own'] },
		count: { status: 200, count: '1' },
	}
	if (child) {
		expected['get crossed'] = 404
		expected['list by own parent'] = { status: 200, rows: ['own'] }
		expected['list by other parent'] = 404
	}
	if (shape.insert !== null) {
		if (contained) expected['insert own'] = 200
		expected['insert other'] = 403
	}
	if (shape.update !== null) {
		expected['update own'] = 200
		expected['update other'] = 404
		if (child) expected['update crossed'] = 404
		if (shape.update !== shape.read) expected['update with read'] = { status: 200, refused: true }
	}
	if (shape.delete !== null) {
		expected['remove own'] = 200
		expected['remove other'] = 404
		if (child) expected['remove crossed'] = 404
		if (shape.delete !== shape.read) expected['remove with read'] = { status: 200, refused: true }
	}
	for (const action of shape.appRead) {
		expected[`app list ${action}`] = { status: 200, rows: ['own', 'other'] }
		expected[`app columns ${action}`] = { status: 200, leaked: [], missing: [] }
	}
	for (const action of shape.appCount) {
		expected[`app count ${action}`] = { status: 200, counted: 2 }
		expected[`app list with count ${action}`] = { status: 200, refused: true }
		expected[`app group with count ${action}`] = { status: 200, refused: true }
	}
	if (shape.secret !== null) expected['get returns secret'] = false
	return expected
}

async function probeScoped(table: TableName, shape: TableShape, tables: ReturnType<typeof readTables>, database: TestDatabase) {
	const kit = policyIsolationKit(contract, tables, table, database)
	const expected = expectedScoped(table, shape)
	const actual: Outcomes = {}
	const own = await kit.get('own')
	actual['get own'] = own.status
	actual['get other'] = (await kit.get('other')).status
	actual['list'] = await kit.list()
	actual['count'] = await kit.count()
	if ('get crossed' in expected) {
		actual['get crossed'] = (await kit.get('crossed')).status
		actual['list by own parent'] = await kit.listByParent('own')
		actual['list by other parent'] = (await kit.listByParent('other')).status
	}
	if ('insert own' in expected) actual['insert own'] = (await kit.insert('own')).status
	if ('insert other' in expected) actual['insert other'] = (await kit.insert('other')).status
	if ('update own' in expected) actual['update own'] = (await kit.update('own')).status
	if ('update other' in expected) actual['update other'] = (await kit.update('other')).status
	if ('update crossed' in expected) actual['update crossed'] = (await kit.update('crossed')).status
	if ('update with read' in expected) actual['update with read'] = await kit.updateWithRead()
	if ('remove own' in expected) actual['remove own'] = (await kit.remove('own')).status
	if ('remove other' in expected) actual['remove other'] = (await kit.remove('other')).status
	if ('remove crossed' in expected) actual['remove crossed'] = (await kit.remove('crossed')).status
	if ('remove with read' in expected) actual['remove with read'] = await kit.removeWithRead()
	for (const action of shape.appRead) {
		actual[`app list ${action}`] = await kit.appList(action)
		actual[`app columns ${action}`] = await kit.appColumns(action)
	}
	for (const action of shape.appCount) {
		actual[`app count ${action}`] = await kit.appCount(action)
		actual[`app list with count ${action}`] = await kit.appListWithCount(action)
		actual[`app group with count ${action}`] = await kit.appGroupWithCount(action)
	}
	if (shape.secret !== null) actual['get returns secret'] = own.columns.includes('secret')
	return { actual, expected }
}

/** What the policy of an application table says each probe answers: the grant is the boundary, never a scope. */
function expectedApp(shape: TableShape): Outcomes {
	const expected: Outcomes = {
		'get global': 200,
		'get scoped': 403,
		'list global': { status: 200, rows: ['own'] },
		'list scoped': 403,
		'scoped site list': { status: 200, rows: ['own'] },
	}
	if (shape.insert !== null) {
		expected['insert global'] = { status: 200 }
		expected['insert scoped'] = 403
	}
	if (shape.update !== null) {
		expected['update global'] = { status: 200 }
		expected['update scoped'] = 403
		if (shape.update !== shape.read) expected['update with read'] = { status: 200, refused: true }
	}
	if (shape.delete !== null) {
		expected['remove global'] = { status: 200 }
		expected['remove scoped'] = 403
		if (shape.delete !== shape.read) expected['remove with read'] = { status: 200, refused: true }
	}
	const other = [shape.insert, shape.update, shape.delete].find((action) => action !== null && action !== shape.read)
	if (other !== undefined) expected['scoped site list with other'] = { status: 200, refused: true }
	if (shape.secret !== null) expected['get returns secret'] = false
	return expected
}

async function probeApp(shape: TableShape, tables: ReturnType<typeof readTables>, database: TestDatabase) {
	const kit = appPolicyIsolationKit(contract, tables, 'settings', database)
	const expected = expectedApp(shape)
	const actual: Outcomes = {}
	const global = await kit.get('global')
	actual['get global'] = global.status
	actual['get scoped'] = (await kit.get('scoped')).status
	actual['list global'] = await kit.list('global')
	actual['list scoped'] = (await kit.list('scoped')).status
	actual['scoped site list'] = await kit.scopedList()
	if (shape.insert !== null) {
		actual['insert global'] = await kit.insert('global')
		actual['insert scoped'] = (await kit.insert('scoped')).status
	}
	if (shape.update !== null) {
		actual['update global'] = await kit.update('global')
		actual['update scoped'] = (await kit.update('scoped')).status
	}
	if ('update with read' in expected) actual['update with read'] = await kit.updateWithRead()
	if (shape.delete !== null) {
		actual['remove global'] = await kit.remove('global')
		actual['remove scoped'] = (await kit.remove('scoped')).status
	}
	if ('remove with read' in expected) actual['remove with read'] = await kit.removeWithRead()
	if ('scoped site list with other' in expected) actual['scoped site list with other'] = await kit.scopedListWithOther()
	if (shape.secret !== null) actual['get returns secret'] = global.columns.includes('secret')
	return { actual, expected }
}

/** The worlds every run checks; a seed that failed once stays in the list, so the regression stays covered. */
const SEEDS = Array.from({ length: 16 }, (_, index) => index + 1)
const worlds = SEEDS.map(generateWorld)

test('the seeds reach every form the generator writes', () => {
	const shapes = worlds.flatMap((world) => [...world.tables.values()])
	const reached = {
		'a child of a top-level dimension table': worlds.some((world) => world.parent === 'orgs'),
		'a child of a contained dimension table': worlds.some((world) => world.parent === 'projects'),
		'an application table': worlds.some((world) => world.tables.has('settings')),
		'an update by the read action': shapes.some((shape) => shape.update === shape.read),
		'an update by another action': shapes.some((shape) => shape.update !== null && shape.update !== shape.read),
		'a delete by another action': shapes.some((shape) => shape.delete !== null && shape.delete !== shape.read),
		'no insert': shapes.some((shape) => shape.insert === null),
		'a version': shapes.some((shape) => shape.version),
		'a column with its own read action': shapes.some((shape) => shape.secret !== null),
		'an appRead action': shapes.some((shape) => shape.appRead.length > 0),
		'an appCount action': shapes.some((shape) => shape.appCount.length > 0),
	}
	expect(Object.entries(reached).filter(([, seen]) => !seen).map(([form]) => form)).toEqual([])
})

const directory = mkdtempSync(join(tmpdir(), 'fabrika-policy-enforcement-'))
const toClose: TestDatabase[] = []
afterAll(async () => {
	for (const database of toClose) await database.close()
	rmSync(directory, { recursive: true, force: true })
})

async function open(world: World, dialect: 'postgres' | 'sqlite'): Promise<TestDatabase | null> {
	const migrations = join(directory, `${dialect}-${world.seed}`)
	mkdirSync(migrations)
	writeFileSync(join(migrations, '20261120120000_world.sql'), migration(world, dialect))
	const label = `policy-enforcement.property.test.ts seed ${world.seed}`
	const database = dialect === 'sqlite' ? await sqliteDatabase({ migrations, label }) : await postgresDatabase({ migrations, label })
	if (database !== null) toClose.push(database)
	return database
}

/** A database per world, or `null` when the dialect has none here (Postgres without FABRIKA_TEST_POSTGRES_URL). */
async function openAll(dialect: 'postgres' | 'sqlite'): Promise<ReadonlyMap<number, TestDatabase> | null> {
	const databases = new Map<number, TestDatabase>()
	for (const world of worlds) {
		const database = await open(world, dialect)
		if (database === null) return null
		databases.set(world.seed, database)
	}
	return databases
}

const databases = { sqlite: await openAll('sqlite'), postgres: await openAll('postgres') }

for (const dialect of ['sqlite', 'postgres'] as const) {
	const opened = databases[dialect]
	describe.skipIf(opened === null)(`every generated policy is enforced as declared, on ${dialect}`, () => {
		for (const world of worlds) {
			test(`seed ${world.seed}: ${[...world.tables.keys()].join(', ')}`, async () => {
				const database = opened?.get(world.seed)
				if (database === undefined) return
				const tables = readTables(
					columnList(world),
					Object.fromEntries([...world.tables].map(([table, shape]) => [table, policyOf(world, table, shape)])),
					vocabulary,
				)
				for (const [table, shape] of world.tables) {
					const { actual, expected } = table === 'settings'
						? await probeApp(shape, tables, database)
						: await probeScoped(table, shape, tables, database)
					expect({ table, ...actual }).toEqual({ table, ...expected })
				}
			})
		}
	})
}
