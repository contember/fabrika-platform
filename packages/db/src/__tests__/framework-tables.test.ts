// The framework's own writes against a REAL Postgres: a form's inbox append and the webhook tables of
// `@fabrika/db/migrations`. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { dataAccessOf, type DeliveryClaim, frameworkTablesOf } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`framework-tables.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `fw_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let database: Database
let framework: ReturnType<typeof frameworkTablesOf>
let layer: unknown

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
	})
	database = Database.postgres({ url: url ?? '', schema, max: 4 })
	layer = connected(tables, { database, capabilities: new TestAuthority('user:alice') }).database
	framework = frameworkTablesOf(layer)
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

const W1 = { type: 'workspace', value: 'w1' }
/** A bucket no test fills: these appends are about the row, not the form's admission. */
const QUOTA = { bucket: 'accepted', limit: 1000 }

describe('the inbox check, before anything is bound', () => {
	test('names a form without an inbox and a field that is not a column', () => {
		const unbound = frameworkTablesOf(
			connected(tables, { database: Database.fromDialect(new RecordingDialect()), capabilities: new TestAuthority('x') }).database,
		)
		expect(unbound.inboxProblems('contact', ['id', 'email', 'body'])).toEqual([])
		expect(unbound.inboxProblems('contact', ['email', 'phone'])).toEqual([
			"the input field 'phone' of 'contact' is not a column of its inbox contact_messages",
		])
		expect(unbound.inboxProblems('feedback', [])).toEqual([
			"no table in src/db/tables.ts is the inbox of 'feedback' (scope: { inbox: 'feedback', read })",
		])
	})

	test('refuses a value that is not one of scoped(tables)', () => {
		expect(() => frameworkTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
	})
})

describe.skipIf(!hasPostgres)('the framework tables on Postgres', () => {
	test('an inbox append writes one row of the declared columns and answers nothing', async () => {
		expect(await framework.appendToInbox('contact', { id: 'm1', email: 'a@example.com', body: 'hello' }, QUOTA)).toBe(true)
		const rows = await admin((sql) => sql.unsafe(`select id, email, body from ${schema}.contact_messages`))
		expect([...rows]).toEqual([{ id: 'm1', email: 'a@example.com', body: 'hello' }])
	})

	test("a row that fails to insert gives its place in the form's bucket back, and a full bucket appends nothing", async () => {
		const quota = { bucket: `accepted-${Bun.randomUUIDv7()}`, limit: 2 }
		const taken = async () => {
			const [row] = await admin((sql) => sql.unsafe(`select count from ${schema}.fabrika_form_admissions where bucket = $1`, [quota.bucket]))
			return row?.count ?? 0
		}
		const id = `q-${Bun.randomUUIDv7()}`
		expect(await framework.appendToInbox('contact', { id, email: 'a@example.com', body: 'first' }, quota)).toBe(true)
		// The same key again: the insert fails, and its take is rolled back with it.
		await expect(framework.appendToInbox('contact', { id, email: 'a@example.com', body: 'again' }, quota)).rejects.toThrow()
		expect(await taken()).toBe(1)
		expect(await framework.appendToInbox('contact', { id: `${id}-2`, email: 'a@example.com', body: 'second' }, quota)).toBe(true)
		expect(await framework.appendToInbox('contact', { id: `${id}-3`, email: 'a@example.com', body: 'third' }, quota)).toBe(false)
		const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.contact_messages where id like $1`, [`${id}%`]))
		expect(row?.n).toBe(2)
	})

	test('an inbox append refuses an undeclared column and a value the layer cannot bind', async () => {
		await expect(framework.appendToInbox('contact', { id: 'm2', email: 'a@example.com', body: 'x', admin: true }, QUOTA)).rejects.toBeInstanceOf(
			QueryRefusedError,
		)
		await expect(framework.appendToInbox('contact', { id: 'm3', email: ['a', 'b'], body: 'x' }, QUOTA)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(framework.appendToInbox('feedback', { id: 'm4' }, QUOTA)).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a binding is found only under its own webhook, and removed only from its own scope', async () => {
		const binding = { id: 'b1', webhook: 'github', scope: W1, account: 'installation:42', secret: 's3cret' }
		await framework.webhooks.createBinding({ ...binding, createdBy: 'user-1', createdAt: 1 })
		expect(await framework.webhooks.binding('github', 'b1')).toEqual(binding)
		expect(await framework.webhooks.binding('other', 'b1')).toBeNull()
		expect(await framework.webhooks.binding('github', 'missing')).toBeNull()
		expect(await framework.webhooks.removeBinding('github', 'b1', { type: 'workspace', value: 'w2' })).toBe(false)
		expect(await framework.webhooks.removeBinding('github', 'b1', W1)).toBe(true)
		expect(await framework.webhooks.binding('github', 'b1')).toBeNull()
	})

	const bind = (id: string) =>
		framework.webhooks.createBinding({ id, webhook: 'github', scope: W1, account: 'repository:7', secret: 's', createdBy: 'u', createdAt: 1 })

	/** Completes `claim` in a transaction of its own, as a delivery's invocation does, and commits or rolls it back. */
	async function complete(claim: DeliveryClaim, commit = true): Promise<boolean> {
		const invocation = dataAccessOf(layer).invocation(false)
		try {
			const completed = await framework.webhooks.completeDelivery(claim, await invocation.session())
			await (commit ? invocation.commit() : invocation.rollback())
			return completed
		} finally {
			await invocation.rollback()
		}
	}

	test('one copy of a delivery claims it, concurrent copies included; a completed one is never claimed again', async () => {
		await bind('b2')
		await bind('b3')
		const copies = await Promise.all([1, 2, 3, 4].map(() => framework.webhooks.claimDelivery('b2', 'd1', 10, 1000, 0)))
		const claims = copies.filter((claim) => claim !== null)
		expect(claims).toEqual([{ bindingId: 'b2', key: 'd1', leaseUntil: 1010 }])
		expect(await framework.webhooks.claimDelivery('b3', 'd1', 10, 1000, 0)).not.toBeNull()
		const [claim] = claims
		if (claim === undefined) throw new Error('no claim')
		expect(await complete(claim)).toBe(true)
		// Completed: not even a copy that comes after the lease would have ended runs it again.
		expect(await framework.webhooks.claimDelivery('b2', 'd1', 5000, 1000, 0)).toBeNull()
	})

	test('a claim given back, or whose completion rolled back, runs again; an expired one is taken over and fences the first', async () => {
		await bind('b5')
		const first = await framework.webhooks.claimDelivery('b5', 'k1', 100, 1000, 0)
		if (first === null) throw new Error('no claim')
		await framework.webhooks.releaseDelivery(first)
		const second = await framework.webhooks.claimDelivery('b5', 'k1', 200, 1000, 0)
		if (second === null) throw new Error('no claim after the release')
		expect(await complete(second, false)).toBe(true)
		// The completion rolled back with its handler's work, as after a crash before the commit: the lease still holds.
		expect(await framework.webhooks.claimDelivery('b5', 'k1', 1100, 1000, 0)).toBeNull()
		const third = await framework.webhooks.claimDelivery('b5', 'k1', 1300, 1000, 0)
		expect(third).toEqual({ bindingId: 'b5', key: 'k1', leaseUntil: 2300 })
		expect(await complete(second)).toBe(false)
		await framework.webhooks.releaseDelivery(second)
		if (third === null) throw new Error('no takeover')
		expect(await complete(third)).toBe(true)
	})

	test('a key an older release recorded, without a lease, is a completed delivery', async () => {
		await bind('b6')
		await admin((sql) =>
			sql.unsafe(`insert into ${schema}.fabrika_webhook_deliveries (binding_id, delivery_id, received_at) values ('b6', 'old', 100)`)
		)
		expect(await framework.webhooks.claimDelivery('b6', 'old', 1_000_000, 1000, 0)).toBeNull()
	})

	test('a delivery key is kept for the retention window only', async () => {
		await bind('b4')
		const claim = await framework.webhooks.claimDelivery('b4', 'k1', 100, 10, 0)
		if (claim === null) throw new Error('no claim')
		expect(await complete(claim)).toBe(true)
		expect(await framework.webhooks.claimDelivery('b4', 'k1', 150, 10, 50)).toBeNull()
		expect(await framework.webhooks.claimDelivery('b4', 'k1', 300, 10, 200)).not.toBeNull()
	})
})
