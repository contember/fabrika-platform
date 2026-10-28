// The Hyperdrive engine (`@fabrika/db/hyperdrive`) against a REAL Postgres, over postgres.js as a Cloudflare Worker
// runs it: connected as the application's runtime role with no startup parameter, so every name resolves through the
// role's own default search_path, which provisioning sets. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see
// postgres.test.ts); the URL must be able to create roles. It is a credential and is never printed.

import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import postgres from 'postgres'
import { applicationSchema, type Database, InvocationTransaction, runApplicationStatement, sessionOf, type SqlParameter } from '../database'
import { DatabaseError, LeaseLostError } from '../errors'
import { frameworkTablesOf, type JobLeases } from '../framework'
import { HYPERDRIVE_CLIENT_OPTIONS, type HyperdriveClient, openHyperdrive } from '../hyperdrive'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { connected, defineStores } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`hyperdrive.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const HOUR = 3_600_000
const appId = `hd-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const migrations = definePostgresApplicationMigrations({
	appId,
	directory: '/unused',
	framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS },
})
const FIXTURE = [{
	name: '20261028120000_fixture.sql',
	sql: `${migration}
		insert into organizations (id, name) values ('o1', 'Org');
		insert into workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'W1', 'u');`,
}]
const authority = new TestAuthority('job:purge')

type Client = ReturnType<typeof postgres>
const clients: Client[] = []

/** A client as the Worker opens one: the runtime role's URL, `HYPERDRIVE_CLIENT_OPTIONS`, no startup parameter. */
function runtimeClient(max = 4): Client {
	const client = postgres(applicationRuntimeUrl(url, appId), { ...HYPERDRIVE_CLIENT_OPTIONS, max, onnotice: () => undefined })
	clients.push(client)
	return client
}

let client: Client
let database: Database
let leases: JobLeases

async function superuser<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** `work`'s rejection, which must come. */
async function refusal(work: Promise<unknown>): Promise<unknown> {
	return await work.then(() => {
		throw new Error('it did not refuse')
	}, (error: unknown) => error)
}

beforeAll(async () => {
	if (!hasPostgres) return
	await migrations.migrate(url, FIXTURE)
	client = runtimeClient()
	database = openHyperdrive({ schema, client: () => client })
	leases = frameworkTablesOf(connected(tables, { database, capabilities: authority }).database).jobs
})

afterAll(async () => {
	if (!hasPostgres) return
	await database.close()
	for (const opened of clients) await opened.end({ timeout: 5 })
	await dropApplicationDatabase(url, appId)
})

describe.skipIf(!hasPostgres)('the Hyperdrive engine on Postgres', () => {
	test("names resolve through the runtime role's default search_path, with no startup parameter and no SET", async () => {
		const session = sessionOf({ database })
		expect(await runApplicationStatement(session, "select current_setting('search_path') as path, current_user as role", [], 'read')).toEqual([
			{ path: schema, role: `run_${schema.slice(4)}` },
		])
		await defineStores({ database, capabilities: authority }).organizations.create(
			authority.ref('organization', 'organizations.create', 'o-resolved'),
			'Resolved',
		)
		const stored = await superuser((sql) => sql.unsafe(`select name from ${schema}.organizations where id = 'o-resolved'`))
		expect([...stored]).toEqual([{ name: 'Resolved' }])
	})

	test('a statement outside an event, where the runtime has no client, is refused with its own message', async () => {
		const outside = openHyperdrive({
			schema,
			client: () => {
				throw new Error('no event')
			},
		})
		const refused = await refusal(runApplicationStatement(sessionOf({ database: outside }), 'select 1 as one', [], 'read'))
		expect(refused).toBeInstanceOf(DatabaseError)
		expect(refused).toMatchObject({ sqlState: null, message: expect.stringContaining('a statement runs only inside the event') })
	})

	test('a runtime role whose search_path names another schema is refused, and stays refused after it is fixed', async () => {
		const runtime = `run_${schema.slice(4)}`
		await superuser((sql) => sql.unsafe(`alter role ${runtime} set search_path to public`))
		const wrong = runtimeClient(1)
		const engine = openHyperdrive({ schema, client: () => wrong })
		const select = () => runApplicationStatement(sessionOf({ database: engine }), 'select 1 as one', [], 'read')
		try {
			const refused = await refusal(select())
			expect(refused).toBeInstanceOf(DatabaseError)
			expect(refused).toMatchObject({
				sqlState: '3F000',
				message: `the runtime role's search_path resolves to public, not ${schema}; redeploy so provisioning sets the role's default search_path`,
			})
		} finally {
			await migrations.migrate(url, FIXTURE)
		}
		// The isolate's engine checked once; a fixed role needs a new isolate.
		expect(await refusal(select())).toMatchObject({ sqlState: '3F000' })
		const fresh = runtimeClient(1)
		const next = openHyperdrive({ schema, client: () => fresh })
		expect(await runApplicationStatement(sessionOf({ database: next }), 'select 1 as one', [], 'read')).toEqual([{ one: 1 }])
	})

	test('a connection lost before the check is checked again on the next one', async () => {
		const real = runtimeClient(1)
		let failures = 1
		const flaky: HyperdriveClient = {
			reserve: async () => {
				if (failures-- > 0) throw new Error('connection lost')
				return real.reserve()
			},
		}
		const engine = openHyperdrive({ schema, client: () => flaky })
		const select = () => runApplicationStatement(sessionOf({ database: engine }), 'select 1 as one', [], 'read')
		expect(await refusal(select())).toMatchObject({ sqlState: null })
		expect(await select()).toEqual([{ one: 1 }])
	})

	test("an event whose check never settles holds up no other event's statement", async () => {
		// The Worker selects each event's client as the runtime does; the first event's check hangs, as it would if its
		// request were cancelled mid-read, and is then abandoned.
		const events = new AsyncLocalStorage<HyperdriveClient>()
		let hung: () => void = () => undefined
		const reached = new Promise<void>((resolve) => {
			hung = resolve
		})
		let abandon: () => void = () => undefined
		const stalled: HyperdriveClient = {
			reserve: async () => {
				const connection = await runtimeClient(1).reserve()
				abandon = () => connection.release()
				return Object.assign(connection, {
					unsafe: () => {
						hung()
						return new Promise<never>(() => undefined)
					},
				})
			},
		}
		const healthy = runtimeClient(1)
		const engine = openHyperdrive({ schema, client: () => events.getStore() ?? healthy })
		const select = () => runApplicationStatement(sessionOf({ database: engine }), 'select 1 as one', [], 'read')
		void events.run(stalled, select)
		await reached
		const served = events.run(healthy, select)
		const timedOut = new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2_000))
		try {
			expect(await Promise.race([served, timedOut])).toEqual([{ one: 1 }])
		} finally {
			abandon()
		}
	})

	test("an invocation's transaction commits, rolls back, and refuses a write when read-only", async () => {
		const insert = (session: Awaited<ReturnType<InvocationTransaction['session']>>, id: string) =>
			runApplicationStatement(session, 'insert into organizations (id, name) values ($1, $2)', [id, id], 'write')
		const committed = new InvocationTransaction(database, false)
		await insert(await committed.session(), 'o-committed')
		await committed.commit()
		const rolledBack = new InvocationTransaction(database, false)
		await insert(await rolledBack.session(), 'o-rolled-back')
		await rolledBack.rollback()
		const readOnly = new InvocationTransaction(database, true)
		expect(await refusal(insert(await readOnly.session(), 'o-read-only'))).toMatchObject({ sqlState: '25006' })
		await readOnly.rollback()
		const stored = await superuser((sql) => sql.unsafe(`select id from ${schema}.organizations where id like 'o-%' order by id`))
		expect([...stored].map((row) => row.id)).toContain('o-committed')
		expect([...stored].map((row) => row.id)).not.toContain('o-rolled-back')
		expect([...stored].map((row) => row.id)).not.toContain('o-read-only')
	})

	test('every statement runs unprepared, the ones Kysely asks to prepare too', async () => {
		const real = runtimeClient(2)
		const asked: unknown[] = []
		const spied: HyperdriveClient = {
			reserve: async () => {
				const reserved = await real.reserve()
				const unsafe = reserved.unsafe
				return Object.assign(reserved, {
					unsafe: (query: string, parameters?: Parameters<typeof unsafe>[1], options?: Parameters<typeof unsafe>[2]) => {
						asked.push(options)
						return unsafe(query, parameters, options)
					},
				})
			},
		}
		const engine = openHyperdrive({ schema, client: () => spied })
		const stores = defineStores({ database: engine, capabilities: authority })
		await stores.organizations.list(authority.within('organization', 'notes.read', ['o1']))
		expect(asked.length).toBeGreaterThan(1)
		for (const options of asked) expect(options).toMatchObject({ prepare: false })
		expect(asked).toContainEqual({ prepare: false, simple: false })
	})

	test('a job lease fences a write inside its transaction, and cancelling the attempt reaches its backend', async () => {
		const fence = await leases.acquire('fenced', 'holder', HOUR, HOUR)
		if (fence === null) throw new Error('no lease')
		authority.lease = fence
		const stores = () => defineStores({ database, capabilities: authority })
		await stores().organizations.create(authority.ref('organization', 'organizations.create', 'o-fenced'), 'Fenced')
		await leases.renew(fence, 'next-attempt', HOUR, HOUR)
		expect(await refusal(stores().organizations.create(authority.ref('organization', 'organizations.create', 'o-stale'), 'Stale'))).toBeInstanceOf(
			LeaseLostError,
		)
		const blocked = await leases.acquire('blocked', 'holder', HOUR, HOUR)
		if (blocked === null) throw new Error('no lease')
		authority.lease = blocked
		await superuser(async (sql) => {
			await sql.unsafe('begin')
			await sql.unsafe(`select id from ${schema}.workspaces where id = 'w1' for update`)
			const rename = stores().workspaces.rename(authority.ref('workspace', 'workspaces.admin', 'w1', { organization: 'o1' }), 'Renamed')
			await Bun.sleep(150)
			await leases.cancelInFlight(blocked)
			expect(await refusal(rename)).toBeInstanceOf(LeaseLostError)
			await sql.unsafe('rollback')
		})
		authority.lease = null
		const names = await superuser((sql) => sql.unsafe(`select id, name from ${schema}.organizations where id in ('o-fenced', 'o-stale') order by id`))
		expect([...names]).toEqual([{ id: 'o-fenced', name: 'Fenced' }])
		const workspace = await superuser((sql) => sql.unsafe(`select name from ${schema}.workspaces where id = 'w1'`))
		expect([...workspace]).toEqual([{ name: 'W1' }])
	})
})

/** One statement for both engines; each row's every value must come back alike. */
interface Probe {
	readonly label: string
	readonly text: string
	readonly parameters?: readonly SqlParameter[]
}

const ARRAY_LITERALS: Readonly<Record<string, string>> = {
	int2: '1',
	int4: '1',
	int8: '9007199254740993',
	oid: '1',
	float4: '1.5',
	float8: '1.5',
	numeric: '1.50',
	bool: 'true',
	text: 'a "b",\\c {d} NULL',
	varchar: 'NULL',
	bpchar: 'a',
	name: 'a',
	uuid: '00000000-0000-0000-0000-000000000001',
	json: '{"a":[1,null]}',
	jsonb: '{"a":1}',
	date: '2026-01-01',
	timestamp: '2026-01-01 01:02:03.123456',
	timestamptz: '2026-01-01 01:02:03.123456+02',
	time: '01:02',
	timetz: '01:02+00',
	interval: '1 day',
	bytea: '\\x01ff',
	money: '1',
	inet: '1.2.3.4',
	cidr: '1.2.3.0/24',
	macaddr: '08:00:2b:01:02:03',
	xml: '<a/>',
	bit: '1',
	varbit: '101',
	point: '(1,2)',
	box: '(1,2),(3,4)',
	tsvector: 'a b',
	int4range: '[1,2)',
	regclass: 'pg_class',
}

const PROBES: readonly Probe[] = [
	{
		label: 'scalars',
		text: `select 1::int2 a, 1::int4 b, 9007199254740993::int8 c, 1.50::numeric d, 1.5::float4 e, 1.5::float8 f, true g, '2026-01-02'::date h,
			'2026-01-02 03:04:05.123456'::timestamp i, '2026-01-02 03:04:05.123456+00'::timestamptz j, '{"a":1}'::json k, '{"a":1}'::jsonb l,
			'\\x0102'::bytea m, 'x'::text n, '00000000-0000-0000-0000-000000000001'::uuid o, '12:00'::time p, '1 day'::interval q,
			null::text r, 'abc'::char(3) s, 1::oid t`,
	},
	...Object.entries(ARRAY_LITERALS).map(([type, literal]): Probe => ({
		label: `${type}[]`,
		text: `select array[$1::${type}, null] v, array[array[$1::${type}], array[$1::${type}]] nested, '{}'::${type}[] empty`,
		parameters: [literal],
	})),
	{
		label: 'text parameters, as the server parses them by the type it infers',
		text:
			`select $1::timestamptz a, $2::timestamp b, $3::date c, $4::bool d, $5::bool e, $6::jsonb f, $7::json g, $8::bytea h, $9::int8 i, $10::numeric j,
			$11::text k, $12::int4 l`,
		parameters: [
			'2026-01-02 03:04:05.123456+02',
			'2026-01-02 03:04:05.123456',
			'2026-01-02',
			'true',
			false,
			'{"a":1}',
			'"s"',
			'\\x0102',
			9007199254740993n,
			'1.50',
			'x',
			'7',
		],
	},
	{
		label: 'a text parameter compared with a timestamp keeps its microseconds',
		text: `select ('2026-01-02 03:04:05.123456+00'::timestamptz = $1) as same, $1::timestamptz::text as printed`,
		parameters: ['2026-01-02 03:04:05.123456+00'],
	},
]

describe.skipIf(!hasPostgres)('postgres.js through the engine reads and binds as Bun.SQL does', () => {
	for (const probe of PROBES) {
		test(probe.label, async () => {
			const bun = new SQL({ url: applicationRuntimeUrl(url, appId), adapter: 'postgres', max: 1, prepare: false })
			try {
				const expected = [...await bun.unsafe(probe.text, [...(probe.parameters ?? [])])]
				const actual = await runApplicationStatement(sessionOf({ database }), probe.text, probe.parameters ?? [], 'read')
				expect(Bun.deepEquals(actual, expected, true)).toBe(true)
				expect(actual).toEqual(expected)
			} finally {
				await bun.close()
			}
		})
	}
})
