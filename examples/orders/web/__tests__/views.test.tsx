// The demo's screens in a DOM over the real application behind the test kit's proxy decision: the navigation each role
// gets, a salesperson's own customers, and the first scenario as accounting clicks it, a delete the platform refuses
// with the page saying why. `bun test --isolate` gives this file its own DOM globals.

import './dom'

import { createClient } from '@fabrika/app/client'
import { type TestCaller, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createRoot, type Root } from 'react-dom/client'
import { contract } from '../../fabrika.contract'
import app from '../../src/app'
import { FIRM_ID } from '../../src/schemas'
import { Orders } from '../app'

const sqlite = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'web/views.test.tsx' })
afterAll(() => sqlite.close())
const kit = testKit(app, { database: sqlite.database })
const owner = kit.testCaller([{ role: 'majitel' }], { label: 'Jana Králová', email: 'jana@zrnko.example' })
const petr = kit.testCaller([{ role: 'obchodnik' }], { label: 'Petr Horák', email: 'petr@zrnko.example' })
const lenka = kit.testCaller([{ role: 'uctarna' }], { label: 'Lenka Dvořáková', email: 'lenka@zrnko.example' })
const ownerApi = createClient(contract, 'api', { fetch: kit.browser(owner) })

const customer = await ownerApi.customers.create({
	firmId: FIRM_ID,
	name: 'Kavárna U Modré lípy',
	ico: '99000101',
	city: 'Praha',
	email: 'o@lipa.example',
})
await ownerApi.customers.assign({ id: customer.id, salesperson: petr.id, label: 'Petr Horák' })
await ownerApi.customers.create({ firmId: FIRM_ID, name: 'Restaurace Stará pošta', ico: '99000105', city: 'Olomouc', email: 'p@posta.example' })
const order = await ownerApi.orders.create({
	customerId: customer.id,
	number: 'OBJ-2026-0412',
	title: 'Espresso směs, 12 kg',
	dueOn: '2026-11-14',
	amountCzk: 7440,
})

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (ready()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`timed out waiting for ${what}; the page shows: ${document.body.textContent}`)
}

function press(element: Element | null | undefined): void {
	if (!(element instanceof HTMLElement)) throw new Error('nothing to press')
	element.click()
}

const rowTexts = (): string[] => [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '')
const navTexts = (): string[] => [...document.querySelectorAll('nav a')].map((link) => link.textContent?.trim() ?? '')

let shown: Root | null = null
afterEach(() => {
	shown?.unmount()
	shown = null
})

function open(caller: TestCaller, path: string): void {
	history.replaceState(null, '', path)
	const container = document.createElement('div')
	document.body.replaceChildren(container)
	const fetch = kit.browser(caller)
	shown = createRoot(container)
	shown.render(<Orders clients={[createClient(contract, 'api', { fetch })]} fetch={fetch} />)
}

describe('the navigation', () => {
	test('accounting gets the orders and invoicing, not the customers', async () => {
		open(lenka, '/')
		await until(() => navTexts().includes('Fakturace'), 'the invoicing link')
		expect(navTexts()).toEqual(['Objednávky', 'Fakturace'])
	})

	test('a salesperson sees only the customers assigned to them', async () => {
		open(petr, '/odberatele')
		await until(() => rowTexts().some((row) => row.includes('Kavárna U Modré lípy')), 'the assigned customer')
		expect(rowTexts().join(' ')).not.toContain('Stará pošta')
		expect(document.querySelector('h1')?.textContent).toBe('Moji odběratelé')
	})
})

describe('scenario 1: accounting deletes an order', () => {
	test('the platform refuses it, the page says why, and the order stays', async () => {
		open(lenka, '/')
		await until(() => rowTexts().some((row) => row.includes('OBJ-2026-0412')), 'the order')
		press(document.querySelector('button[aria-label="Smazat OBJ-2026-0412"]'))
		await until(() => document.querySelector('[role="dialog"]') !== null, 'the confirmation')
		press([...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Smazat'))
		await until(() => document.querySelector('.orders-refusal') !== null, 'the refusal')
		expect(document.querySelector('.orders-refusal')?.textContent).toContain('Mazat objednávky smí jen majitel')
		expect((await ownerApi.orders.get({ id: order.id })).number).toBe('OBJ-2026-0412')
	})
})
