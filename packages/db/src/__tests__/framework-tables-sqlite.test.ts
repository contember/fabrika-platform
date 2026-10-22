// The framework's webhook tables on SQLite (a bun:sqlite stand-in for a Durable Object's storage): bindings as guarded
// trees, and delivery keys claimed under a lease, completed in the handler's transaction, given back or taken over.

import { beforeEach, describe, expect, test } from 'bun:test'
import { dataAccessOf, type DeliveryClaim, frameworkTablesOf } from '../framework'
import { TestAuthority } from './fixtures/authority'
import { type SqliteFramework, sqliteFramework } from './fixtures/sqlite-framework'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

let db: SqliteFramework
let framework: ReturnType<typeof frameworkTablesOf>
let layer: unknown

beforeEach(async () => {
	db = await sqliteFramework()
	layer = connected(tables, { database: db.database, capabilities: new TestAuthority('user:alice') }).database
	framework = frameworkTablesOf(layer)
})

const W1 = { type: 'workspace', value: 'w1' }

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

describe('the webhook bindings on SQLite', () => {
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

	test('removing a binding removes its delivery keys with it', async () => {
		await bind('b-gone')
		expect(await framework.webhooks.claimDelivery('b-gone', 'd1', 10, 1000, 0)).not.toBeNull()
		expect(await framework.webhooks.removeBinding('github', 'b-gone', W1)).toBe(true)
		expect(db.exec(`select delivery_id from fabrika_webhook_deliveries where binding_id = 'b-gone'`)).toEqual([])
	})
})

describe('the webhook deliveries on SQLite', () => {
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

	test('a key recorded without a lease is a completed delivery', async () => {
		await bind('b6')
		db.exec(`insert into fabrika_webhook_deliveries (binding_id, delivery_id, received_at) values ('b6', 'old', 100)`)
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

	test('a delivery of a binding that does not exist is refused by the foreign key', async () => {
		await expect(framework.webhooks.claimDelivery('missing', 'k1', 100, 10, 0)).rejects.toMatchObject({ sqlState: '23503' })
	})
})
