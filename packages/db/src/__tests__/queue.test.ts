// Queue tables, claims and `insert(…, { onConflict })` on a REAL Postgres. Skips cleanly when FABRIKA_TEST_POSTGRES_URL
// is unset (see postgres.test.ts). The handles are untyped here: the framework builds them, `orm-types.ts` types them.

import { openTestPostgres } from '@fabrika/db/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { LeaseFence } from '../capability'
import { Database, type Session } from '../database'
import { CapabilityError, ConflictError, LeaseLostError, QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite, frameworkTablesOf, type JobLeases } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import type { DataKind } from '../orm-types'
import { readTables } from '../policy'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`queue.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `queue_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const HOUR = 3_600_000
const TICK = 60_000

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
create table outbox (
	id text primary key,
	recipient text not null,
	attempts integer not null default 0,
	next_attempt_at timestamptz default now(),
	sent_note text,
	version integer not null
);
create table payments (id text primary key, stripe_id text not null unique, state text not null, version integer not null);
create table unsubscribes (id text primary key, email text not null, campaign text not null, unique (email, campaign));
create table products (id text primary key, name text not null, cost integer);
`

const vocabulary = {
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: {
		'crm.read': 'Read',
		'deals.write': 'Write deals',
		'reports.request': 'Request a report',
		'reports.render': 'Render reports',
		'mail.queue': 'Queue mail',
		'mail.send': 'Send mail',
		'billing.record': 'Record payments',
		'billing.read': 'Read payments',
		'mailing.unsubscribe': 'Unsubscribe',
		'catalog.read': 'Read the catalog',
	},
}

const columns = {
	deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
	report_requests: {
		columns: ['id', 'deal_id', 'org_id', 'kind', 'result', 'attempts', 'next_attempt_at', 'version'],
		foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
		timestamps: ['next_attempt_at'],
	},
	outbox: { columns: ['id', 'recipient', 'attempts', 'next_attempt_at', 'sent_note', 'version'], foreignKeys: [], timestamps: ['next_attempt_at'] },
	payments: { columns: ['id', 'stripe_id', 'state', 'version'], foreignKeys: [] },
	unsubscribes: { columns: ['id', 'email', 'campaign'], foreignKeys: [] },
	products: { columns: ['id', 'name', 'cost'], foreignKeys: [] },
}

const policies = {
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['name'] },
	report_requests: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'reports.request', update: 'reports.render' },
		insert: ['kind'],
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
	outbox: {
		scope: { app: 'mail of every organization goes out through one job' },
		actions: { read: 'mail.send', insert: 'mail.queue', update: 'mail.send', delete: 'mail.send' },
		insert: ['recipient', 'next_attempt_at'],
		update: ['sent_note'],
		queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: 3 },
		version: 'version',
	},
	payments: {
		scope: { app: 'provider events' },
		actions: { read: 'billing.read', insert: 'billing.record', update: 'billing.record' },
		insert: ['stripe_id', 'state'],
		update: ['state'],
		version: 'version',
	},
	unsubscribes: {
		scope: { app: 'a recipient opts out of a campaign' },
		actions: { read: 'mail.send', insert: 'mailing.unsubscribe' },
		insert: ['email', 'campaign'],
	},
	products: {
		scope: { app: 'one catalog per application' },
		actions: { read: ['crm.read', 'catalog.read'] },
		columns: { cost: { read: 'crm.read' } },
	},
}

const job = new TestAuthority('job:drain')
let database: Database
let data: DataAccess
let leases: JobLeases

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration}`)
		await sql.unsafe(`insert into ${schema}.deals (id, org_id, name) values ('d1', 'o1', 'One'), ('d2', 'o2', 'Two')`)
	})
	database = openTestPostgres({ url: url ?? '', schema, max: 6 })
	const layer = scoped(readTables(columns, policies, vocabulary))
	const locator = bindScopedDatabase(layer, { database, capabilities: job })
	data = dataAccessOf(layer)
	leases = frameworkTablesOf(layer).jobs
	void locator
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

beforeEach(async () => {
	if (!hasPostgres) {
		return
	}
	job.lease = null
	await admin((sql) =>
		sql.unsafe(
			`delete from ${schema}.report_requests; delete from ${schema}.outbox; delete from ${schema}.payments; delete from ${schema}.unsubscribes`,
		)
	)
})

/** A job's handles outside its transaction: reads, and claims. */
function jobHandles(tickMs = TICK) {
	const site: DataSite = { kind: 'job', unscoped: {}, principal: 'job:drain', tickMs, check: () => undefined, session: async () => data.direct() }
	return data.handles(site)
}

/** The handles of a site of `kind` whose statements run in `session`. */
function handlesIn(kind: DataKind, session: Session) {
	const site: DataSite = { kind, unscoped: {}, principal: 'job:drain', check: () => undefined, session: async () => session }
	return data.handles(site)
}

/** A job's `ctx.transaction`: fenced by the attempt's lease when the authority holds one. */
function inTransaction<T>(work: (tx: ReturnType<typeof handlesIn>) => Promise<T>): Promise<T> {
	return data.transaction((session) => work(handlesIn('mutation', session)))
}

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

const claimed = (rows: unknown): readonly Readonly<Record<string, unknown>>[] => {
	if (!Array.isArray(rows)) {
		throw new TypeError('a claim answers an array')
	}
	return rows
}

async function queueMail(recipients: readonly string[]): Promise<void> {
	const queue = job.app('mail.queue')
	await inTransaction(async (tx) => {
		for (const recipient of recipients) {
			await call(tx.app(queue), 'outbox.insert', { recipient })
		}
	})
}

async function outboxRows(): Promise<readonly { recipient: string; attempts: number; due: Date | null; version: number }[]> {
	return admin((sql) => sql.unsafe(`select recipient, attempts, next_attempt_at as due, version from ${schema}.outbox order by recipient`))
}

async function rewind(): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.outbox set next_attempt_at = now() - interval '1 second' where next_attempt_at is not null`))
}

const describeDb = hasPostgres ? describe : describe.skip

describeDb('claim', () => {
	test('leases due rows: attempts grow by one, due moves by one tick, and each row answers its new version and ref', async () => {
		await queueMail(['a@example.com', 'b@example.com'])
		const before = Date.now()
		const rows = claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10 }))
		expect(rows.map((row) => row['recipient'])).toEqual(['a@example.com', 'b@example.com'])
		expect(rows.map((row) => [row['attempts'], row['version']])).toEqual([[1, 2], [1, 2]])
		expect(rows.every((row) => typeof row['ref'] === 'object' && row['ref'] !== null)).toBe(true)
		const stored = await outboxRows()
		expect(stored.map((row) => [row.attempts, row.version])).toEqual([[1, 2], [1, 2]])
		for (const row of stored) {
			const delay = (row.due?.getTime() ?? 0) - before
			expect(delay).toBeGreaterThan(TICK - 5_000)
			expect(delay).toBeLessThan(TICK + 5_000)
		}
		expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10 }))).toEqual([])
	})

	test('the backoff doubles with each claim of a row', async () => {
		await queueMail(['a@example.com'])
		const delays: number[] = []
		for (let claim = 0; claim < 3; claim++) {
			await rewind()
			const before = Date.now()
			expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))).toHaveLength(1)
			const [row] = await outboxRows()
			delays.push(Math.round(((row?.due?.getTime() ?? 0) - before) / TICK))
		}
		expect(delays).toEqual([1, 2, 4])
	})

	test('two concurrent claims never return the same row', async () => {
		const recipients = Array.from({ length: 40 }, (_, index) => `r${String(index).padStart(2, '0')}@example.com`)
		await queueMail(recipients)
		const claims = await Promise.all(
			Array.from({ length: 4 }, () => call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 15 }).then(claimed)),
		)
		const ids = claims.flatMap((rows) => rows.map((row) => String(row['id'])))
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids.length).toBe(40)
		expect((await outboxRows()).every((row) => row.attempts === 1)).toBe(true)
	})

	test('a row with maxAttempts claims is no longer claimed, and stays in the table', async () => {
		await queueMail(['a@example.com'])
		for (let claim = 0; claim < 3; claim++) {
			await rewind()
			expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))).toHaveLength(1)
		}
		await rewind()
		expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))).toEqual([])
		expect((await outboxRows()).map((row) => row.attempts)).toEqual([3])
	})

	test('a row due later is not claimed; where narrows the claim to the columns its action reads', async () => {
		const queue = job.app('mail.queue')
		await inTransaction(async (tx) => {
			await call(tx.app(queue), 'outbox.insert', { recipient: 'later@example.com', next_attempt_at: new Date(Date.now() + HOUR) })
			await call(tx.app(queue), 'outbox.insert', { recipient: 'a@example.com' })
			await call(tx.app(queue), 'outbox.insert', { recipient: 'b@example.com' })
		})
		const rows = claimed(
			await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10, where: [['recipient', '=', 'b@example.com']] }),
		)
		expect(rows.map((row) => row['recipient'])).toEqual(['b@example.com'])
	})

	test('done rows are never claimed again, and an expectVersion mismatch writes nothing', async () => {
		await queueMail(['a@example.com', 'b@example.com'])
		const [first, second] = claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10 }))
		await inTransaction(async (tx) => {
			await call(tx.target(first?.['ref'], 'on'), 'update', { sent_note: 'sent' }, { expectVersion: first?.['version'], done: true })
		})
		const stale = inTransaction((tx) => call(tx.target(second?.['ref'], 'on'), 'update', {}, { expectVersion: 1, done: true }))
		await expect(stale).rejects.toBeInstanceOf(ConflictError)
		await rewind()
		const again = claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10 }))
		expect(again.map((row) => row['recipient'])).toEqual(['b@example.com'])
		const stored = await outboxRows()
		expect(stored.map((row) => [row.recipient, row.due === null, row.version])).toEqual([['a@example.com', true, 3], ['b@example.com', false, 3]])
	})

	test('remove deletes a claimed row with the delete action; requeue makes it due with no attempts', async () => {
		await queueMail(['a@example.com', 'b@example.com'])
		const [first, second] = claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 10 }))
		const at = new Date(Date.now() + HOUR)
		await inTransaction(async (tx) => {
			await call(tx.target(first?.['ref'], 'on'), 'remove', { expectVersion: first?.['version'] })
			await call(tx.target(second?.['ref'], 'on'), 'requeue', { at })
		})
		const stored = await outboxRows()
		expect(stored.map((row) => [row.recipient, row.attempts, row.due?.getTime()])).toEqual([['b@example.com', 0, at.getTime()]])
	})

	test('a failed transaction leaves the claimed row due after its backoff, not at once', async () => {
		await queueMail(['a@example.com'])
		const [row] = claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))
		const failed = inTransaction(async (tx) => {
			await call(tx.target(row?.['ref'], 'on'), 'update', {}, { expectVersion: row?.['version'], done: true })
			throw new Error('the send failed')
		})
		await expect(failed).rejects.toThrow('the send failed')
		expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))).toEqual([])
		expect((await outboxRows()).map((stored) => stored.due !== null)).toEqual([true])
	})

	test('a dimension-scoped queue is claimed through a Within of its update action, and finished through row.ref', async () => {
		await admin((sql) =>
			sql.unsafe(`insert into ${schema}.report_requests (id, deal_id, org_id, kind, version) values
				('r1', 'd1', 'o1', 'summary', 1), ('r2', 'd2', 'o2', 'summary', 1)`)
		)
		const inOrg = claimed(await call(jobHandles().within(job.within('org', 'reports.render', ['o1'])), 'report_requests.claim', { limit: 5 }))
		expect(inOrg.map((row) => row['id'])).toEqual(['r1'])
		const rest = claimed(await call(jobHandles().within(job.within('deal', 'reports.render', 'all')), 'report_requests.claim', { limit: 5 }))
		expect(rest.map((row) => row['id'])).toEqual(['r2'])
		await expect(call(jobHandles().within(job.within('deal', 'crm.read', 'all')), 'report_requests.claim', { limit: 5 })).rejects.toBeInstanceOf(
			CapabilityError,
		)
		const [first] = inOrg
		await inTransaction((tx) =>
			call(tx.target(first?.['ref'], 'on'), 'update', { result: 'rendered' }, { expectVersion: first?.['version'], done: true })
		)
		const [stored] = await admin((sql) => sql.unsafe(`select result, next_attempt_at from ${schema}.report_requests where id = '${first?.['id']}'`))
		expect(stored).toEqual({ result: 'rendered', next_attempt_at: null })
	})

	test('a row ref stops at a row that moved since its claim', async () => {
		await admin((sql) =>
			sql.unsafe(`insert into ${schema}.report_requests (id, deal_id, org_id, kind, version) values ('r1', 'd1', 'o1', 'summary', 1)`)
		)
		const [row] = claimed(await call(jobHandles().within(job.within('deal', 'reports.render', 'all')), 'report_requests.claim', { limit: 1 }))
		await admin((sql) => sql.unsafe(`update ${schema}.report_requests set deal_id = 'd2', org_id = 'o2' where id = 'r1'`))
		const moved = inTransaction((tx) => call(tx.target(row?.['ref'], 'on'), 'update', {}, { expectVersion: row?.['version'], done: true }))
		await expect(moved).rejects.toThrow('report_requests not found')
	})

	test('claim needs the update action, a queue table, and a job outside its transaction', async () => {
		await queueMail(['a@example.com'])
		await expect(call(jobHandles().app(job.app('mail.queue')), 'outbox.claim', { limit: 1 })).rejects.toThrow(CapabilityError)
		await expect(call(jobHandles().app(job.app('billing.record')), 'payments.claim', { limit: 1 })).rejects.toThrow(
			'payments is not a queue table: its policy declares no queue',
		)
		await expect(call(jobHandles().app(job.app('mail.send')), 'outbox.claim', {})).rejects.toThrow('claim takes { limit }')
		const inside = inTransaction((tx) => call(tx.app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))
		await inside.then(
			() => expect.unreachable('a claim inside ctx.transaction is refused'),
			(error: unknown) => expect(error instanceof QueryRefusedError && error.reason).toBe('claim_site'),
		)
		const query = data.invocation(true)
		const site: DataSite = { kind: 'query', unscoped: {}, principal: 'u', check: () => undefined, session: () => query.session() }
		await expect(call(data.handles(site).app(job.app('mail.send')), 'outbox.claim', { limit: 1 })).rejects.toThrow('claim leases rows')
		await query.rollback()
		expect((await outboxRows()).map((row) => row.attempts)).toEqual([0])
	})

	test("a claim is fenced by the job attempt's lease: one that lost it leases nothing", async () => {
		await queueMail(['a@example.com'])
		const fence = await leases.acquire('drain', 'holder-1', HOUR, HOUR)
		if (fence === null) throw new Error('no lease')
		const stale: LeaseFence = { ...fence, generation: fence.generation + 1 }
		job.lease = stale
		await expect(call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 })).rejects.toBeInstanceOf(LeaseLostError)
		job.lease = fence
		expect(claimed(await call(jobHandles().app(job.app('mail.send')), 'outbox.claim', { limit: 1 }))).toHaveLength(1)
		job.lease = null
		await leases.finish(fence, 'succeeded')
	})
})

describeDb('insert with onConflict', () => {
	const unsubscribe = (email: string) =>
		inTransaction((tx) =>
			call(tx.app(job.app('mailing.unsubscribe')), 'unsubscribes.insert', { email, campaign: 'spring' }, {
				onConflict: { columns: ['email', 'campaign'], do: 'nothing' },
			})
		)

	test("'nothing' inserts once and answers whether it inserted", async () => {
		const first = await unsubscribe('a@example.com')
		expect(first).toMatchObject({ inserted: true })
		expect(await unsubscribe('a@example.com')).toEqual({ inserted: false })
		expect(await admin((sql) => sql.unsafe(`select email from ${schema}.unsubscribes`))).toEqual([{ email: 'a@example.com' }])
	})

	test("'update' writes the update columns of the conflicting row in the same transaction", async () => {
		const record = (state: string) =>
			inTransaction((tx) =>
				call(tx.app(job.app('billing.record')), 'payments.insert', { stripe_id: 'pi_1', state }, {
					onConflict: { columns: ['stripe_id'], do: 'update' },
				})
			)
		const inserted = await record('created')
		expect(inserted).toMatchObject({ inserted: true, version: 1 })
		const updated = await record('succeeded')
		expect(updated).toMatchObject({ inserted: false, version: 2 })
		expect(await admin((sql) => sql.unsafe(`select stripe_id, state, version from ${schema}.payments`))).toEqual([
			{ stripe_id: 'pi_1', state: 'succeeded', version: 2 },
		])
	})

	test("'update' needs the table's update action; a column outside the table or an empty one is refused", async () => {
		const insert = (options: unknown) =>
			inTransaction((tx) => call(tx.app(job.app('mailing.unsubscribe')), 'unsubscribes.insert', { email: 'x@example.com', campaign: 'c' }, options))
		await expect(insert({ onConflict: { columns: ['email', 'campaign'], do: 'update' } })).rejects.toBeInstanceOf(CapabilityError)
		await expect(insert({ onConflict: { columns: ['nope'], do: 'nothing' } })).rejects.toThrow('onConflict names nope, which is not a column')
		await expect(insert({ onConflict: { columns: [], do: 'nothing' } })).rejects.toThrow('onConflict.columns takes a plain array')
		await expect(insert({ onConflict: { columns: ['email'], do: 'replace' } })).rejects.toThrow("onConflict.do takes 'nothing' or 'update'")
		await expect(insert({ conflict: {} })).rejects.toThrow('conflict is not an option of insert')
	})
})

describeDb('a list of read actions', () => {
	test('each read action reads the table, and a column of one action is hidden from the other', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.products (id, name, cost) values ('p1', 'Pen', 3)`))
		const staff = await inTransaction((tx) => call(tx.app(job.app('crm.read')), 'products.list'))
		const visitor = await inTransaction((tx) => call(tx.app(job.app('catalog.read')), 'products.list'))
		expect(staff).toEqual({ items: [{ id: 'p1', name: 'Pen', cost: 3 }], next: null })
		expect(visitor).toEqual({ items: [{ id: 'p1', name: 'Pen' }], next: null })
		await expect(inTransaction((tx) => call(tx.app(job.app('mail.send')), 'products.list'))).rejects.toBeInstanceOf(CapabilityError)
	})
})
