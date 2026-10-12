// `ctx.sql` through `boot`'s pipeline on a REAL Postgres: it exists only on a site that declares `sql`, runs in the
// invocation's transaction, and is bound to its invocation like every `ctx.db` handle. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app/src/__tests__/sql-dispatch.test.ts
//
// The handlers read `ctx` untyped, as the kit's types are not what this file tests. The URL is a credential: it is never logged.

import { defineApp } from '@fabrika/app/contract'
import type { ContractApp, ContractImplementation, JobClock } from '@fabrika/app/implement'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { siteHandler } from '../implement/invocation'
import { bootApp, grant, resultOf, send, type Sent, token } from './fixtures/implement/harness'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { ById, Columns, contract as ormContract, Margin, Ok, Push, Rename, ReopenDeal, Saved } from './orm-fixture/fabrika.contract'
import { migration } from './orm-fixture/migration'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`sql-dispatch.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `sql-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const O1 = { type: 'org', value: 'o1' }
const opened: Database[] = []

interface Hooks {
	renameThrows: boolean
	whileKept: () => Promise<void>
	kept: SqlCall | undefined
	/** Whether each site's `ctx` (and a job's `tx`) had `sql`, by site name. */
	readonly hasSql: Record<string, boolean>
}

function field(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

type SqlCall = (text: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>

/** `ctx.sql(row)`, called as a handler whose types were defeated would call it. */
function sqlOf(ctx: unknown, row: z.core.$ZodType): SqlCall {
	const sql = field(ctx, 'sql')
	if (typeof sql !== 'function') {
		throw new TypeError('ctx.sql is absent')
	}
	const tag: unknown = Reflect.apply(sql, ctx, [row])
	if (typeof tag !== 'function') {
		throw new TypeError('ctx.sql(row) is no tag')
	}
	return async (text, ...values) => {
		const rows: unknown = await Reflect.apply(tag, undefined, [text, ...values])
		return Array.isArray(rows) ? rows : []
	}
}

/** The id `ctx.target` carries: the access form took `id` out of the input. */
function targetId(ctx: unknown): unknown {
	return field(field(ctx, 'target'), 'value')
}

const Title = z.object({ title: z.string() })
const SavedRow = z.object({ id: z.string(), version: z.number() })

/** A site of this shell: `sqlApp` serves its own tree in its place. */
const servedByTheTree = (): never => {
	throw new Error('sql-dispatch serves the handler tree sqlApp writes')
}

// The orm fixture's shell, with each site's `sql` declared where the digest covers it: `boot` reads it from there.
const kit = defineApp({ ...vocabulary, app: 'notes' }, tables)
const deals = kit.group({ callers: ['human'] }, (r) => ({
	columns: r.query({ input: ById, output: Columns, access: { action: 'crm.read', on: 'deal', from: 'id' }, sql: 'read' }).handle(servedByTheTree),
	margin: r.mutation({ input: ById, output: Margin, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	reopen: r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	rename: r.mutation({ input: Rename, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' }, sql: 'write' }).handle(
		servedByTheTree,
	),
	retitle: r.query({ input: Rename, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' }, sql: 'read' }).handle(servedByTheTree),
	keep: r.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' }, sql: 'read' }).handle(servedByTheTree),
	replay: r.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }).handle(servedByTheTree),
}))
const contract = kit.contract((c) => ({
	api: c.rpc('/api', { deals }),
	github: kit.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push }).handle(servedByTheTree),
	health: c.health('/healthz'),
	jobs: { close: kit.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app', sql: 'write' }).handle(servedByTheTree) },
}))

function sqlApp(hooks: Hooks): ContractImplementation<typeof contract> {
	const noted = (name: string, ctx: unknown) => {
		hooks.hasSql[name] = field(ctx, 'sql') !== undefined
	}
	const tree = {
		api: {
			deals: {
				columns: siteHandler(async ({ input, ctx }) => {
					const rows = await sqlOf(ctx, Title)`select d.title from deals d join companies c on c.id = d.company_id where d.id = ${targetId(ctx)}`
					return { columns: rows.map((row) => String(field(row, 'title'))) }
				}, { sql: 'read' }),
				margin: siteHandler(async ({ ctx }) => {
					noted('margin', ctx)
					return { margin: null, columns: [] }
				}, undefined),
				reopen: siteHandler(async () => ({ id: Bun.randomUUIDv7(), version: 1 }), undefined),
				rename: siteHandler(async ({ input, ctx }) => {
					const [saved] = await sqlOf(ctx, SavedRow)`update deals set title = ${field(input, 'title')}, version = version + 1
						where id = ${targetId(ctx)} and version = ${field(input, 'expectVersion')} returning id, version`
					if (hooks.renameThrows) {
						throw new Error('the handler failed after its write')
					}
					return saved
				}, { sql: 'write' }),
				retitle: siteHandler(async ({ input, ctx }) => {
					await sqlOf(ctx, z.object({}))`update deals set title = ${field(input, 'title')} where id = ${targetId(ctx)}`
					return { ok: true }
				}, { sql: 'read' }),
				keep: siteHandler(async ({ ctx }) => {
					hooks.kept = sqlOf(ctx, Title)
					await hooks.whileKept()
					return { ok: true }
				}, { sql: 'read' }),
				replay: siteHandler(async ({ ctx }) => {
					noted('replay', ctx)
					const kept = hooks.kept
					if (kept !== undefined) {
						await kept`select title from deals`
					}
					return { ok: true }
				}, undefined),
			},
		},
		github: siteHandler(async () => undefined, undefined),
		jobs: {
			close: siteHandler(async ({ ctx }) => {
				noted('job', ctx)
				await Reflect.apply(Reflect.get(Object(ctx), 'transaction'), ctx, [async (tx: unknown) => {
					noted('job transaction', tx)
					await sqlOf(tx, z.object({}))`update deals set stage = 'lost', version = version + 1 where stage = 'lead'`
				}])
			}, { sql: 'write' }),
		},
	}
	return { contract, database: scoped(tables), connect: {}, handlers: () => tree }
}

function hooksOf(): Hooks {
	return { renameThrows: false, whileKept: () => Promise.resolve(), kept: undefined, hasSql: {} }
}

function start(hooks: Hooks = hooksOf()): { app: ContractApp; hooks: Hooks } {
	const connection = Database.postgres({ url, schema, max: 4 })
	opened.push(connection)
	return { app: bootApp(sqlApp(hooks), { database: connection }), hooks }
}

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function seedDeal(stage: 'lead' | 'won' = 'won'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.deals (id, company_id, org_id, title, stage, created_by, version) values ($1, 'c1', 'o1', 'Deal', $2, 'user-9', 1)`,
			[id, stage],
		)
	)
	return id
}

async function deal(id: string): Promise<Record<string, unknown> | undefined> {
	const [row] = await admin((sql) => sql.unsafe(`select title, stage, version from ${schema}.deals where id = $1`, [id]))
	return row
}

const reader = () => token('user', [grant('crm.read', O1)])
const writer = () => token('user', [grant('crm.read', O1), grant('deals.write', O1)])

/** A 500 with its fixed envelope, and the server log lines it left. */
async function failed(work: () => Promise<Sent>): Promise<string> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const sent = await work()
		expect(sent.status).toBe(500)
		return log.mock.calls.map((line) => line.map(String).join(' ')).join('\n')
	} finally {
		log.mockRestore()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
		await sql.unsafe(`insert into ${schema}.orgs (id, name, created_by, version) values ('o1', 'One', 'u', 1)`)
		await sql.unsafe(`insert into ${schema}.companies (id, org_id, name, created_by, version) values ('c1', 'o1', 'Acme', 'u', 1)`)
	})
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	for (const connection of opened) {
		await connection.close()
	}
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('ctx.sql through the pipeline', () => {
	test('a site without sql has no ctx.sql', async () => {
		const { app, hooks } = start()
		const id = await seedDeal()
		expect(resultOf(await send(app, '/api/deals.margin', { token: await writer(), body: { id } }))).toEqual({ margin: null, columns: [] })
		expect(resultOf(await send(app, '/api/deals.replay', { token: await reader(), body: { id } }))).toEqual({ ok: true })
		expect(hooks.hasSql).toEqual({ margin: false, replay: false })
	})

	test('ctx.sql takes its mode from the approved contract: a handler that alone declares sql does not boot', () => {
		const connection = Database.postgres({ url, schema, max: 1 })
		opened.push(connection)
		const leafOnly = { ...sqlApp(hooksOf()), contract: ormContract }
		expect(() => bootApp(leafOnly, { database: connection })).toThrow(
			`procedure 'api.deals.columns': its handler declares {"sql":"read","unscoped":[],"connect":[],"issues":null}, but the approved contract declares {"sql":null,`,
		)
	})

	test("a declared 'read' query answers a join; a declared 'write' mutation writes in the invocation's transaction", async () => {
		const { app, hooks } = start()
		const id = await seedDeal()
		expect(resultOf(await send(app, '/api/deals.columns', { token: await reader(), body: { id } }))).toEqual({ columns: ['Deal'] })
		const rename = async (title: string, expectVersion: number) =>
			send(app, '/api/deals.rename', { token: await writer(), body: { id, title, expectVersion } })
		hooks.renameThrows = true
		await failed(() => rename('thrown', 1))
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
		hooks.renameThrows = false
		expect(resultOf(await rename('kept', 1))).toEqual({ id, version: 2 })
		expect(await deal(id)).toEqual({ title: 'kept', stage: 'won', version: 2 })
	})

	test("a 'read' site's write is refused, and nothing is written", async () => {
		const { app } = start()
		const id = await seedDeal()
		const title = 'a-bound-value-never-logged'
		const log = await failed(async () => send(app, '/api/deals.retitle', { token: await reader(), body: { id, title, expectVersion: 1 } }))
		// The reason tells the author why; the statement and its values stay out of the log.
		expect(log).toContain("api.deals.retitle: query_refused: sql_read_only: sql: 'read' runs queries only; declare sql: 'write'")
		expect(log).not.toContain(title)
		expect(log).not.toContain(id)
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
	})

	test('a captured ctx.sql is refused from another live request, from another boot, and after its invocation ended', async () => {
		const { app, hooks } = start()
		const other = start(hooks)
		const id = await seedDeal()
		const kept = Promise.withResolvers<void>()
		const done = Promise.withResolvers<void>()
		hooks.whileKept = async () => {
			kept.resolve()
			await done.promise
		}
		const keeping = send(app, '/api/deals.keep', { token: await reader(), body: { id } })
		await kept.promise
		expect(await failed(async () => send(app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain(
			'capability_refused: foreign_work',
		)
		expect(await failed(async () => send(other.app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain(
			'capability_refused: foreign_work',
		)
		done.resolve()
		expect(resultOf(await keeping)).toEqual({ ok: true })
		expect(await failed(async () => send(app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain('capability_refused: ended')
	})
})

describe.skipIf(!hasPostgres)('a job runs tx.sql in its fenced transaction', () => {
	const clock: JobClock = {
		wait: (ms, signal) => new Promise<void>((resolve) => (ms < 60_000 ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))),
		random: () => 0,
	}
	const reporter = { report: () => Promise.resolve() }

	test('ctx has no sql outside ctx.transaction; tx.sql writes and commits with the attempt', async () => {
		const { app, hooks } = start()
		const lead = await seedDeal('lead')
		expect(await app.jobs.run('close', { clock, reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		expect(hooks.hasSql).toEqual({ job: false, 'job transaction': true })
		expect((await deal(lead))?.['stage']).toBe('lost')
	})
})
