// The framework's own writes against a REAL Postgres: the webhook tables of `@fabrika/db/migrations`. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { dataAccessOf, type DeliveryClaim, frameworkTablesOf } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
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
	database = openPostgres({ url: url ?? '', schema, max: 4 })
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

describe('the framework tables, before anything is bound', () => {
	test('refuses a value that is not one of scoped(tables)', () => {
		expect(() => frameworkTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
	})
})

describe.skipIf(!hasPostgres)('the framework tables on Postgres', () => {
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

	test("a binding's secret is replaced only in its own webhook and scope", async () => {
		const binding = { id: 'b-secret', webhook: 'stripe', scope: W1, account: 'acct_1', secret: 'generated' }
		await framework.webhooks.createBinding({ ...binding, createdBy: 'user-1', createdAt: 1 })
		expect(await framework.webhooks.replaceSecret('stripe', 'b-secret', { type: 'workspace', value: 'w2' }, 'whsec_other')).toBe(false)
		expect(await framework.webhooks.replaceSecret('github', 'b-secret', W1, 'whsec_other')).toBe(false)
		expect(await framework.webhooks.replaceSecret('stripe', 'missing', W1, 'whsec_other')).toBe(false)
		expect(await framework.webhooks.binding('stripe', 'b-secret')).toEqual(binding)
		expect(await framework.webhooks.replaceSecret('stripe', 'b-secret', W1, 'whsec_issued')).toBe(true)
		expect(await framework.webhooks.binding('stripe', 'b-secret')).toEqual({ ...binding, secret: 'whsec_issued' })
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
