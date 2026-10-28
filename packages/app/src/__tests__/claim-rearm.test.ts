// A queue claim re-arms its job (ADR-0065 §5): after a claim that leased rows, one `claim` wake at the earliest due its
// own conditions, scope and attempt limit will next find, never sooner than a second after it; a claim that took its full
// limit makes it due at once; a claim that found nothing writes none. Rows the claim cannot take (another `where`, past
// their attempts) never pull the wake forward, so the job does not loop on them. On a REAL Postgres (skips cleanly
// without FABRIKA_TEST_POSTGRES_URL) and over bun:sqlite under the Cloudflare object's alarm.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { FABRIKA_APPLICATION_OBJECT, FABRIKA_APPLICATION_OBJECTS, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { applicationSchema, type Database, scoped, type TypedColumnList } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { defineTables } from '@fabrika/db/tables'
import { SQL } from 'bun'
import { Database as BunDatabase } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType, Generated } from 'kysely'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { type ApplicationState, type ApplicationStorage, createContractWorker, FabrikaApplication } from '../cloudflare'
import { TICK_HEADER } from '../cloudflare/application'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { frameworkEnvFor, keepingProcessEnvironment, keySource, ORIGIN, PROXY_SECRET, workloadTokensFor } from './fixtures/implement/harness'

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

// Named as the harness's IAM application, which the Cloudflare half boots under.
const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: { 'crm.read': 'Read deals', 'reports.request': 'Request a report', 'reports.render': 'Render reports' },
	roles: { viewer: { grants: ['crm.read', 'reports.request'] } },
})

const MAX_ATTEMPTS = 3

const tables = defineTables(vocabulary, columns)({
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read' } },
	report_requests: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'reports.request', update: 'reports.render' },
		insert: ['kind'],
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: MAX_ATTEMPTS },
		version: 'version',
	},
})

const app = defineApp(vocabulary, tables)

/** The claim's limit for the next run, a second claim of another kind in the same run, and the rows each claim took. */
const claims: { limit: number; then: string | null; claimed: string[][] } = { limit: 5, then: null, claimed: [] }

// Daily, so a claimed row's backoff (the schedule's period) lies a day ahead of every row a test places.
const render = app.cron('0 3 * * *', { actions: ['reports.render'] }).handle(async ({ ctx }) => {
	const queue = ctx.db.over(ctx.within('reports.render', 'deal')).report_requests
	const rows = await queue.claim({ limit: claims.limit, where: [['kind', '=', 'summary']] })
	claims.claimed.push(rows.map((row) => row.id).sort())
	if (claims.then !== null) {
		const more = await queue.claim({ limit: 5, where: [['kind', '=', claims.then]] })
		claims.claimed.push(more.map((row) => row.id).sort())
	}
})

const contract = app.contract(() => ({ jobs: { render } }))

const SECOND = 1_000
const MINUTE = 60 * SECOND

/** One queue row: its kind, its due time (`null` when done) and how many claims it has had. */
interface Row {
	readonly id: string
	readonly kind: 'summary' | 'detail'
	readonly due: number | null
	readonly attempts?: number
}

/** The rows of the main case at `now`: one the claim takes, one it takes later, and three it never takes. */
function rowsAt(now: number): readonly Row[] {
	return [
		{ id: 'r1', kind: 'summary', due: now - MINUTE },
		// Due, earlier than every other, and of another kind: the claim's `where` never takes it.
		{ id: 'r2', kind: 'detail', due: now - 2 * MINUTE },
		{ id: 'r3', kind: 'summary', due: now + 2 * MINUTE },
		{ id: 'r4', kind: 'detail', due: now + 30 * SECOND },
		// Past its attempts: never due again.
		{ id: 'r5', kind: 'summary', due: now + MINUTE, attempts: MAX_ATTEMPTS },
		{ id: 'r6', kind: 'summary', due: null },
	]
}

interface ClaimWake {
	readonly reason: string
	readonly due_at: number
	readonly dedupe: string | null
}

beforeEach(() => {
	claims.limit = 5
	claims.then = null
	claims.claimed = []
})

// ── Postgres ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`claim-rearm.test.ts: the Postgres half skipped; set ${URL_VARIABLE} to run it (a job's lease lives in @fabrika/db)`)
}
const schema = applicationSchema(`rearm-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

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

async function admin<T>(statement: string): Promise<T[]> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

const pgTime = (time: number | null): string => (time === null ? 'null' : `'${new Date(time).toISOString()}'::timestamptz`)

async function placeRows(rows: readonly Row[]): Promise<void> {
	const values = rows.map((row) => `('${row.id}', 'd1', 'o1', '${row.kind}', ${row.attempts ?? 0}, ${pgTime(row.due)}, 1)`)
	await admin(`insert into ${schema}.report_requests (id, deal_id, org_id, kind, attempts, next_attempt_at, version) values ${values.join(', ')}`)
}

async function pgClaimWakes(): Promise<ClaimWake[]> {
	const rows = await admin<{ reason: string; due_at: string; dedupe: string | null }>(
		`select reason, due_at::text, dedupe from ${schema}.fabrika_wakes where job = 'render' and reason = 'claim' order by due_at`,
	)
	return rows.map((row) => ({ ...row, due_at: Number(row.due_at) }))
}

async function pgNow(): Promise<number> {
	const [row] = await admin<{ now: Date }>('select now() as now')
	return row?.now.getTime() ?? Number.NaN
}

function pgKit() {
	const connection = openPostgres({ url, schema, max: 3 })
	connections.push(connection)
	return testKit(serve(contract, { database: scoped(tables) }), { database: connection })
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
	await admin(`insert into ${schema}.deals (id, org_id, name) values ('d1', 'o1', 'One')`)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const opened of connections) await opened.close()
	await admin(`drop schema ${schema} cascade`)
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin(`delete from ${schema}.report_requests; delete from ${schema}.fabrika_wakes; delete from ${schema}.fabrika_job_leases`)
})

describe.skipIf(!hasPostgres)('a claim re-arms its job on Postgres', () => {
	test('at the earliest due its own claim would take; rows of another kind or past their attempts do not pull it forward', async () => {
		const now = Date.now()
		await placeRows(rowsAt(now))
		const kit = pgKit()
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(claims.claimed).toEqual([['r1']])
		expect(await pgClaimWakes()).toEqual([{ reason: 'claim', due_at: now + 2 * MINUTE, dedupe: 'claim:render' }])
	})

	test('a claim that took its full limit makes the wake due at once; the next run replaces it from its own claim', async () => {
		const now = Date.now()
		await placeRows([...rowsAt(now), { id: 'r7', kind: 'summary', due: now - MINUTE }])
		claims.limit = 1
		const kit = pgKit()
		const before = await pgNow()
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		const [full] = await pgClaimWakes()
		expect(full?.due_at).toBeGreaterThan(before)
		expect(full?.due_at).toBeLessThanOrEqual(await pgNow())
		claims.limit = 5
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(claims.claimed).toEqual([['r1'], ['r7']])
		expect(await pgClaimWakes()).toEqual([{ reason: 'claim', due_at: now + 2 * MINUTE, dedupe: 'claim:render' }])
	})

	test('a run that claimed nothing writes none, and the wake it ran for is consumed', async () => {
		const now = Date.now()
		await placeRows(rowsAt(now).filter((row) => row.id !== 'r1'))
		await admin(
			`insert into ${schema}.fabrika_wakes (id, job, due_at, reason, attempt, dedupe) values ('${Bun.randomUUIDv7()}', 'render', ${
				now - SECOND
			}, 'claim', 0, 'claim:render')`,
		)
		const kit = pgKit()
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(claims.claimed).toEqual([[]])
		expect(await pgClaimWakes()).toEqual([])
	})

	test("a run's later claim of another kind never postpones its full claim's re-arm", async () => {
		const now = Date.now()
		await placeRows([...rowsAt(now), { id: 'r7', kind: 'summary', due: now - MINUTE }])
		claims.limit = 1
		claims.then = 'detail'
		const kit = pgKit()
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		// The summaries filled the claim; the details' next row (r4) is 30 s away.
		expect(claims.claimed).toEqual([['r1'], ['r2']])
		const [wake, ...more] = await pgClaimWakes()
		expect(more).toEqual([])
		expect(wake?.due_at).toBeLessThanOrEqual(await pgNow())
	})

	test('a claim re-arms no sooner than a second after it, though a row comes due sooner', async () => {
		const now = Date.now()
		await placeRows([{ id: 'r1', kind: 'summary', due: now - MINUTE }, { id: 'r8', kind: 'summary', due: now + 100 }])
		const kit = pgKit()
		const before = await pgNow()
		expect(await kit.runJob('render')).toEqual({ status: 'succeeded', attempts: 1 })
		const [wake] = await pgClaimWakes()
		expect(wake?.due_at).toBeGreaterThanOrEqual(before + SECOND)
		expect(wake?.due_at).toBeLessThanOrEqual((await pgNow()) + SECOND)
	})
})

// ── bun:sqlite under the Cloudflare object's alarm ────────────────────────────────────────────────────────────────────

const SQLITE_MIGRATIONS = [{
	name: '20261025120000_reports.sql',
	sql: `
CREATE TABLE deals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (id, org_id)) STRICT;
CREATE TABLE report_requests (
	id TEXT PRIMARY KEY,
	deal_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	result TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT,
	version INTEGER NOT NULL,
	FOREIGN KEY (deal_id, org_id) REFERENCES deals (id, org_id)
) STRICT;
`,
}]

/** The object's alarm as workerd keeps it: set inside a storage transaction, it commits or rolls back with it. */
class Alarm {
	scheduled: number | null = null
	readonly #open: { value: number | null | undefined }[] = []

	set(value: number | null): Promise<void> {
		const open = this.#open.at(-1)
		if (open === undefined) {
			this.scheduled = value
		} else {
			open.value = value
		}
		return Promise.resolve()
	}

	async within<T>(run: (closure: () => Promise<T>) => Promise<T>, closure: () => Promise<T>): Promise<T> {
		const frame: { value: number | null | undefined } = { value: undefined }
		const result = await run(async () => {
			this.#open.push(frame)
			try {
				return await closure()
			} finally {
				this.#open.pop()
			}
		})
		if (frame.value !== undefined) {
			this.set(frame.value)
		}
		return result
	}
}

interface Sqlite {
	readonly database: BunDatabase
	readonly alarm: Alarm
	/** Fires the alarm as workerd does and waits for the runs it handed to `waitUntil`. */
	fire(): Promise<void>
}

async function sqlite(): Promise<Sqlite> {
	const implementation = serve(contract, { database: scoped(tables) })
	createContractWorker(() => Promise.resolve({ default: implementation }), { migrations: SQLITE_MIGRATIONS })
	const database = new BunDatabase(':memory:')
	const alarm = new Alarm()
	const pending: Promise<unknown>[] = []
	const tokens = workloadTokensFor(implementation)
	const unused = () => Promise.reject(new Error('not called'))
	const env = {
		...frameworkEnvFor(implementation),
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		[CLOUDFLARE_FILES_BINDING]: { head: unused, put: unused, delete: unused, get: () => Promise.resolve(null) },
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application',
		IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
	}
	const inner = bunSqliteStorage(database)
	const storage: ApplicationStorage = {
		sql: inner.sql,
		transactionSync: inner.transactionSync,
		transaction: (closure) => alarm.within((run) => inner.transaction(run), closure),
		getAlarm: () => Promise.resolve(alarm.scheduled),
		setAlarm: (time) => alarm.set(time),
		deleteAlarm: () => alarm.set(null),
	}
	const state: ApplicationState = { storage, blockConcurrencyWhile: (callback) => callback(), waitUntil: (promise) => void pending.push(promise) }
	const object = new FabrikaApplication(state, env)
	// The repair tick migrates the storage, writes the cron wake and arms the alarm.
	const tick = await object.fetch(
		new Request(`${ORIGIN}/`, { method: 'POST', headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, [TICK_HEADER]: String(Date.now()) } }),
	)
	expect(tick.status).toBe(204)
	database.query("insert into deals (id, org_id, name) values ('d1', 'o1', 'One')").run()
	return {
		database,
		alarm,
		async fire() {
			await object.alarm()
			while (pending.length > 0) await Promise.all(pending.splice(0))
		},
	}
}

function sqliteRows(database: BunDatabase, rows: readonly Row[]): void {
	for (const row of rows) {
		database.query("insert into report_requests (id, deal_id, org_id, kind, attempts, next_attempt_at, version) values (?, 'd1', 'o1', ?, ?, ?, 1)")
			.run(
				row.id,
				row.kind,
				row.attempts ?? 0,
				row.due === null ? null : new Date(row.due).toISOString(),
			)
	}
}

function sqliteWakes(database: BunDatabase, reason: string): ClaimWake[] {
	return database.query<ClaimWake, [string]>("select reason, due_at, dedupe from fabrika_wakes where job = 'render' and reason = ? order by due_at")
		.all(
			reason,
		)
}

/** A kick of `render` due a second ago, as a mutation's commit leaves it. */
function kickNow(database: BunDatabase): void {
	database.query("insert into fabrika_wakes (id, job, due_at, reason, attempt, dedupe) values (?, 'render', ?, 'kick', 0, null)").run(
		crypto.randomUUID(),
		Date.now() - SECOND,
	)
}

describe('a claim re-arms its job under the Cloudflare alarm', () => {
	test('the alarm is armed at its own next eligible due, not at the rows it cannot take, so the job does not loop', async () => {
		await keepingProcessEnvironment(async () => {
			const { database, alarm, fire } = await sqlite()
			const now = Date.now()
			sqliteRows(database, rowsAt(now))
			kickNow(database)
			await fire()
			expect(claims.claimed).toEqual([['r1']])
			expect(sqliteWakes(database, 'claim')).toEqual([{ reason: 'claim', due_at: now + 2 * MINUTE, dedupe: 'claim:render' }])
			expect(sqliteWakes(database, 'kick')).toEqual([])
			expect(alarm.scheduled).toBe(now + 2 * MINUTE)
			// Nothing is due: a spurious alarm runs nothing and keeps the wake.
			await fire()
			expect(claims.claimed).toEqual([['r1']])
			expect(alarm.scheduled).toBe(now + 2 * MINUTE)
		})
	})

	test("a run's later claim of another kind never postpones its full claim's re-arm, and the alarm runs the job again", async () => {
		await keepingProcessEnvironment(async () => {
			const { database, alarm, fire } = await sqlite()
			const now = Date.now()
			sqliteRows(database, [...rowsAt(now), { id: 'r7', kind: 'summary', due: now - MINUTE }])
			claims.limit = 1
			claims.then = 'detail'
			kickNow(database)
			await fire()
			expect(claims.claimed).toEqual([['r1'], ['r2']])
			const [wake, ...more] = sqliteWakes(database, 'claim')
			expect(more).toEqual([])
			expect(wake?.due_at).toBeLessThanOrEqual(Date.now())
			expect(alarm.scheduled).toBe(wake?.due_at ?? Number.NaN)
			claims.then = null
			claims.limit = 5
			await fire()
			expect(claims.claimed).toEqual([['r1'], ['r2'], ['r7']])
		})
	})

	test('a full claim re-arms at once and the alarm runs the job again, which then re-arms from its own claim', async () => {
		await keepingProcessEnvironment(async () => {
			const { database, alarm, fire } = await sqlite()
			const now = Date.now()
			sqliteRows(database, [...rowsAt(now), { id: 'r7', kind: 'summary', due: now - MINUTE }])
			claims.limit = 1
			kickNow(database)
			await fire()
			expect(claims.claimed).toEqual([['r1']])
			const [full] = sqliteWakes(database, 'claim')
			expect(full?.due_at).toBeLessThanOrEqual(Date.now())
			expect(alarm.scheduled).toBe(full?.due_at ?? Number.NaN)
			claims.limit = 5
			await fire()
			expect(claims.claimed).toEqual([['r1'], ['r7']])
			expect(sqliteWakes(database, 'claim')).toEqual([{ reason: 'claim', due_at: now + 2 * MINUTE, dedupe: 'claim:render' }])
			expect(alarm.scheduled).toBe(now + 2 * MINUTE)
		})
	})
})
