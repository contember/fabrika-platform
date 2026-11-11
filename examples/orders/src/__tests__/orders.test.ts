// The demo's two claims behind the production proxy decision, over the application's SQLite schema: each role reaches
// what the vocabulary gives it, a salesperson only the customers an assignment names, and accounting is refused an
// order's delete before the handler runs. Runs with `bun test --isolate`.

import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'
import { FIRM_ID } from '../schemas'

const sqlite = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'orders.test.ts' })
afterAll(() => sqlite.close())
const kit = testKit(app, { database: sqlite.database })

const owner = kit.testCaller([{ role: 'majitel' }], { label: 'Majitelka' })
const petr = kit.testCaller([{ role: 'obchodnik' }], { label: 'Petr' })
const eva = kit.testCaller([{ role: 'obchodnik' }], { label: 'Eva' })
const accounting = kit.testCaller([{ role: 'uctarna' }], { label: 'Účtárna' })
const asOwner = createClient(contract, 'api', { fetch: kit.browser(owner) })
const asPetr = createClient(contract, 'api', { fetch: kit.browser(petr) })
const asEva = createClient(contract, 'api', { fetch: kit.browser(eva) })
const asAccounting = createClient(contract, 'api', { fetch: kit.browser(accounting) })

async function customerOf(name: string, salesperson: { readonly id: string; readonly label: string }) {
	const { id } = await asOwner.customers.create({ firmId: FIRM_ID, name, ico: '99000001', city: 'Brno', email: 'objednavky@example.test' })
	await asOwner.customers.assign({ id, salesperson: salesperson.id, label: salesperson.label })
	return id
}

describe('a salesperson', () => {
	test('reaches only the customers assigned to them, and their orders', async () => {
		const mine = await customerOf('Kavárna Petrova', { id: petr.id, label: 'Petr' })
		const evas = await customerOf('Bistro Evino', { id: eva.id, label: 'Eva' })
		const order = await asPetr.orders.create({ customerId: mine, number: 'T-1', title: 'Espresso 10 kg', dueOn: '2026-11-20', amountCzk: 4200 })
		expect((await asPetr.orders.get({ id: order.id })).customerName).toBe('Kavárna Petrova')
		expect((await asPetr.customers.reps()).items.map((rep) => rep.customerName)).toEqual(['Kavárna Petrova'])
		expect(await statusOf(asPetr.orders.create({ customerId: evas, number: 'T-2', title: 'Ne', dueOn: '2026-11-20', amountCzk: 1 }))).toBe(404)
		expect((await asEva.orders.list({})).items.map((item) => item.id)).not.toContain(order.id)
		expect(await statusOf(asEva.orders.get({ id: order.id }))).toBe(404)
	})

	test('does not create customers or delete orders', async () => {
		const mine = await customerOf('Cukrárna Petrova', { id: petr.id, label: 'Petr' })
		const order = await asPetr.orders.create({ customerId: mine, number: 'T-3', title: 'Filtr 5 kg', dueOn: '2026-11-21', amountCzk: 2100 })
		expect(await statusOf(asPetr.customers.create({ firmId: FIRM_ID, name: 'X', ico: '99000002', city: 'X', email: 'x@example.test' }))).toBe(403)
		expect(await statusOf(asPetr.orders.remove({ id: order.id, expectVersion: 1 }))).toBe(403)
	})
})

describe('accounting', () => {
	test('reads every order and keeps its invoicing records, but never reads the customers', async () => {
		const customer = await customerOf('Hotel Účetní', { id: eva.id, label: 'Eva' })
		const order = await asOwner.orders.create({
			customerId: customer,
			number: 'T-4',
			title: 'Zrnková káva 20 kg',
			dueOn: '2026-11-22',
			amountCzk: 10000,
		})
		expect((await asAccounting.orders.list({})).items.map((item) => item.id)).toContain(order.id)
		const record = await asAccounting.billing.prepare({ orderId: order.id, vatRate: 12 })
		const listed = (await asAccounting.billing.list()).items.find((item) => item.id === record.id)
		expect(listed?.totalCzk).toBe(11200)
		await asAccounting.billing.markInvoiced({ orderId: order.id, id: record.id, expectVersion: 1, invoiceNumber: 'FV-2026-001' })
		expect(await statusOf(asAccounting.customers.list({}))).toBe(403)
	})

	test('is refused an order delete by the proxy, and the order stays', async () => {
		const customer = await customerOf('Restaurace Mazací', { id: petr.id, label: 'Petr' })
		const order = await asOwner.orders.create({ customerId: customer, number: 'T-5', title: 'Dekaf 3 kg', dueOn: '2026-11-23', amountCzk: 1500 })
		const remove = (caller: typeof accounting) =>
			kit.browser(caller)('/api/orders.remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: order.id, expectVersion: 1 }),
			})
		const refused = await remove(accounting)
		expect(refused.status).toBe(403)
		expect(await refused.text()).toBe('forbidden')
		expect((await asOwner.orders.get({ id: order.id })).id).toBe(order.id)
		// The same request, by the one role that holds `orders.delete`, deletes it: the path is declared, the role decides.
		expect((await remove(owner)).status).toBe(200)
	})
})

describe('the owner', () => {
	test('deletes an order', async () => {
		const customer = await customerOf('Kavárna Smazaná', { id: petr.id, label: 'Petr' })
		const order = await asOwner.orders.create({ customerId: customer, number: 'T-6', title: 'Omyl', dueOn: '2026-11-24', amountCzk: 100 })
		expect(await asOwner.orders.remove({ id: order.id, expectVersion: 1 })).toEqual({ id: order.id })
		expect(await statusOf(asOwner.orders.get({ id: order.id }))).toBe(404)
	})
})
