// A job drains a queue table: `claim` through a capability the job minted, then one `ctx.transaction` per row that
// finishes it through `tx.db.on(row.ref)`. A claim inside the transaction is refused. The runs need
// FABRIKA_TEST_POSTGRES_URL, since a job's lease and its claim's lease live in @fabrika/db.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { applicationSchema, Database, scoped, type TypedColumnList } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { defineTables } from '@fabrika/db/tables'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType, Generated } from 'kysely'

interface DealsTable {
	id: string
	org_id: string
	name: string
}

interface ReportRequestsTable {
	id: string
	deal_id: string
	org_id: string
	kind: string
	result: string | null
	attempts: Generated<number>
	next_attempt_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
	version: number
}

interface DB {
	deals: DealsTable
	report_requests: ReportRequestsTable
}

const columns: TypedColumnList<DB> = {
	deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
	report_requests: {
		columns: ['id', 'deal_id', 'org_id', 'kind', 'result', 'attempts', 'next_attempt_at', 'version'],
		foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
		timestamps: ['next_attempt_at'],
	},
}

const migration = `
create table deals (id text primary key, org_id text not null, name text not null, unique (id, org_id));
create table report_requests (
	id text primary key,
	deal_id text not null,
	org_id text not null,
	kind text not null,
	result text,
	attempts integer not null default 0,
	next_attempt_at timestamptz default now(),
	version integer not null,
	foreign key (deal_id, org_id) references deals (id, org_id)
);
`

const vocabulary = defineVocabulary({
	app: 'reports',
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: { 'crm.read': 'Read deals', 'reports.request': 'Request a report', 'reports.render': 'Render reports' },
	roles: { viewer: { grants: ['crm.read', 'reports.request'] } },
})

const tables = defineTables(vocabulary, columns)({
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read' } },
	report_requests: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'reports.request', update: 'reports.render' },
		insert: ['kind'],
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
})

const app = defineApp(vocabulary, tables)

/** What the last run of `refusing` saw when it claimed inside its transaction. */
const seen: { refusal: string | null } = { refusal: null }

const render = app.cron('*/5 * * * *', { actions: ['reports.render'] }).handle(async ({ ctx }) => {
	const queue = ctx.db.over(ctx.within('reports.render', 'deal')).report_requests
	for (const request of await queue.claim({ limit: 5 })) {
		await ctx.transaction(async (tx) => {
			await tx.db.on(request.ref).update({ result: `rendered ${request.kind}` }, { expectVersion: request.version, done: true })
		})
	}
})

const refusing = app.cron('* * * * *', { actions: ['reports.render'] }).handle(async ({ ctx }) => {
	const within = ctx.within('reports.render', 'deal')
	await ctx.transaction(async (tx) => {
		// The types refuse the call; a handler whose types were defeated reaches the runtime's refusal.
		const claim: unknown = Reflect.get(tx.db.over(within).report_requests, 'claim')
		try {
			if (typeof claim === 'function') await claim({ limit: 1 })
		} catch (error) {
			seen.refusal = error instanceof Error ? error.message : String(error)
		}
	})
})

const contract = app.contract(() => ({ jobs: { render, refusing } }))

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`queue-job.test.ts skipped: set ${URL_VARIABLE} to run it (a job's lease lives in @fabrika/db)`)
}
const schema = applicationSchema(`queue-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

async function admin<T>(statement: string): Promise<T[]> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

function connection(): Database {
	const opened = Database.postgres({ url, schema, max: 3 })
	connections.push(opened)
	return opened
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
	await admin(`insert into ${schema}.deals (id, org_id, name) values ('d1', 'o1', 'One'), ('d2', 'o2', 'Two')`)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const opened of connections) await opened.close()
	await admin(`drop schema ${schema} cascade`)
})

beforeEach(async () => {
	if (!hasPostgres) return
	seen.refusal = null
	await admin(`delete from ${schema}.report_requests`)
})

const describeDb = hasPostgres ? describe : describe.skip

describeDb('a job drains a queue table', () => {
	test('claims the due rows, finishes each in its own transaction, and claims a done row never again', async () => {
		await admin(`insert into ${schema}.report_requests (id, deal_id, org_id, kind, version) values
			('r1', 'd1', 'o1', 'summary', 1), ('r2', 'd2', 'o2', 'detail', 1)`)
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: connection() })
		expect(await kit.runJob('render')).toMatchObject({ status: 'succeeded' })
		const rows = await admin<{ id: string; result: string; attempts: number; next_attempt_at: Date | null; version: number }>(
			`select id, result, attempts, next_attempt_at, version from ${schema}.report_requests order by id`,
		)
		expect(rows).toEqual([
			{ id: 'r1', result: 'rendered summary', attempts: 1, next_attempt_at: null, version: 3 },
			{ id: 'r2', result: 'rendered detail', attempts: 1, next_attempt_at: null, version: 3 },
		])
		expect(await kit.runJob('render')).toMatchObject({ status: 'succeeded' })
		expect(await admin(`select attempts, version from ${schema}.report_requests order by id`)).toEqual([
			{ attempts: 1, version: 3 },
			{ attempts: 1, version: 3 },
		])
	})

	test('a claim inside ctx.transaction is refused, and leases nothing', async () => {
		await admin(`insert into ${schema}.report_requests (id, deal_id, org_id, kind, version) values ('r1', 'd1', 'o1', 'summary', 1)`)
		const kit = testKit(serve(contract, { database: scoped(tables) }), { database: connection() })
		expect(await kit.runJob('refusing')).toMatchObject({ status: 'succeeded' })
		expect(seen.refusal).toContain('claim leases rows in a transaction of its own')
		expect(await admin(`select attempts from ${schema}.report_requests`)).toEqual([{ attempts: 0 }])
	})
})
