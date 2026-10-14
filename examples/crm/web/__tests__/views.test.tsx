// The CRM's screens rendered in a DOM over the real application behind the test kit's proxy decision: what a manager
// and a viewer see, a deal created through its dialog, a refused input shown at its field, a stale edit shown as a
// conflict, and tasks marked done from the selection toolbar. Needs FABRIKA_TEST_POSTGRES_URL; `bun test --isolate`
// gives this file its own DOM globals.

import './dom'

import { createClient } from '@fabrika/app/client'
import { type TestCaller, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createRoot, type Root } from 'react-dom/client'
import { contract } from '../../fabrika.contract'
import app from '../../src/app'
import { Crm } from '../app'

const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'web/views.test.tsx' })

/** Waits until `ready` holds, letting requests and renders settle between tries. */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (ready()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`timed out waiting for ${what}; the page shows: ${document.body.textContent}`)
}

async function press(element: Element | null | undefined): Promise<void> {
	if (!(element instanceof HTMLElement)) throw new Error('nothing to press')
	element.click()
}

/** Sets a control's value as typing would, so the form's `FormData` reads it. */
function fill(form: Element, name: string, value: string): void {
	const control = form.querySelector(`[name="${name}"]`)
	if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
		throw new Error(`no control named ${name}`)
	}
	control.value = value
}

const button = (name: string): HTMLButtonElement | undefined =>
	[...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name)

const rowTexts = (): string[] => [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '')

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database, files: new MemoryFileObjects() })
	const acme = kit.scope('org', 'acme')
	const manager = kit.testCaller([{ role: 'manager', scope: acme }], { label: 'Mia Manager', email: 'mia@acme.example' })
	const viewer = kit.testCaller([{ role: 'viewer', scope: acme }], { label: 'Vic Viewer' })
	const managerApi = createClient(contract, 'api', { fetch: kit.browser(manager) })

	const company = await managerApi.companies.create({ orgId: 'acme', name: 'Initech' })
	const seeded = await managerApi.deals.create({ companyId: company.id, title: 'Printers for the third floor', value: 4200 })

	let shown: Root | null = null
	afterEach(() => {
		shown?.unmount()
		shown = null
	})

	/** The CRM at `path`, as `caller` sees it, until the test ends. */
	function open(caller: TestCaller, path: string): void {
		history.replaceState(null, '', path)
		const container = document.createElement('div')
		document.body.replaceChildren(container)
		const fetch = kit.browser(caller)
		shown = createRoot(container)
		shown.render(<Crm clients={[createClient(contract, 'api', { fetch })]} fetch={fetch} />)
	}

	describe('the deals screen', () => {
		test("a manager sees the org's deals, the caller in the top bar and the create button", async () => {
			open(manager, '/deals')
			await until(() => rowTexts().some((row) => row.includes('Printers for the third floor') && row.includes('Initech')), 'the seeded deal')
			expect(document.querySelector('header')?.textContent).toContain('mia@acme.example')
			await until(() => button('New deal') !== undefined, 'the create button')
			expect(document.querySelector('[aria-current="page"]')?.textContent).toContain('Deals')
		})

		test('a viewer sees the same deals and no create button', async () => {
			open(viewer, '/deals')
			await until(() => rowTexts().some((row) => row.includes('Printers for the third floor')), 'the seeded deal')
			await until(() => document.querySelector('header')?.textContent?.includes('Vic Viewer') === true, 'the caller')
			expect(button('New deal')).toBeUndefined()
		})

		test('an empty title is refused at its field before anything is sent, and a valid deal opens its own screen', async () => {
			open(manager, '/deals')
			await until(() => button('New deal') !== undefined, 'the create button')
			await press(button('New deal'))
			const form = document.querySelector('form[aria-label="New deal"]')
			if (form === null) throw new Error('no dialog form')
			await until(() => form.querySelector(`option[value="${company.id}"]`) !== null, 'the company to pick')
			fill(form, 'companyId', company.id)
			fill(form, 'title', '')
			fill(form, 'value', '900')
			await press(button('Create deal'))
			await until(() => form.querySelector('[aria-invalid="true"]') !== null, 'the field error')
			expect(form.querySelector('[aria-invalid="true"]')?.getAttribute('name')).toBe('title')
			expect(form.querySelector('[role="alert"]')?.textContent).toContain('Check the highlighted fields')
			fill(form, 'title', 'Toner subscription')
			await press(button('Create deal'))
			await until(() => document.querySelector('h1')?.textContent === 'Toner subscription', 'the new deal screen')
			expect(location.pathname).toStartWith('/deals/')
			expect((await managerApi.deals.list({})).items.map((deal) => deal.title)).toContain('Toner subscription')
		})
	})

	describe('the deal screen', () => {
		test('an edit of a version someone else changed meanwhile is shown as a conflict, and nothing is saved', async () => {
			open(manager, `/deals/${seeded.id}`)
			await until(() => document.querySelector('h1')?.textContent === 'Printers for the third floor', 'the deal')
			await until(() => button('Edit') !== undefined, 'the edit button')
			await managerApi.deals.edit({ id: seeded.id, title: 'Printers, third floor', value: 4300, source: null, expectVersion: 1 })
			await press(button('Edit'))
			const form = document.querySelector('form[aria-label="Edit deal"]')
			if (form === null) throw new Error('no edit form')
			fill(form, 'title', 'Mine wins')
			await press(button('Save'))
			await until(() => form.querySelector('[role="alert"]') !== null, 'the conflict')
			expect(form.querySelector('[role="alert"]')?.textContent).toContain('Someone changed it meanwhile')
			expect((await managerApi.deals.get({ id: seeded.id })).title).toBe('Printers, third floor')
		})

		test('an address that names no screen says so', async () => {
			open(manager, '/nowhere')
			await until(() => document.body.textContent?.includes('This address names no screen of the CRM.') === true, 'the not-found screen')
			expect(document.querySelector('[aria-current="page"]')).toBeNull()
		})
	})

	describe('the tasks screen', () => {
		test('the selected tasks are marked done from the selection toolbar, and move to the Done tab', async () => {
			await managerApi.tasks.create({ dealId: seeded.id, title: 'Call the facilities manager', dueOn: '2099-01-10' })
			await managerApi.tasks.create({ dealId: seeded.id, title: 'Send the quote', dueOn: '2099-01-11' })
			open(manager, '/tasks')
			await until(() => rowTexts().filter((row) => row.includes('2099')).length === 2, 'the open tasks')
			expect(document.querySelector('[role="toolbar"]')).toBeNull()
			for (const title of ['Call the facilities manager', 'Send the quote']) {
				await press([...document.querySelectorAll('label')].find((label) => label.textContent === `Select ${title}`)?.querySelector('input'))
			}
			await until(() => document.querySelector('[role="toolbar"]')?.textContent?.includes('2 selected') === true, 'the toolbar')
			await press(button('Mark done'))
			await until(() => rowTexts().every((row) => !row.includes('2099')), 'the tasks to leave the open tab')
			await press([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Done')))
			await until(() => rowTexts().filter((row) => row.includes('2099')).length === 2, 'the done tasks')
			expect((await managerApi.tasks.list({})).items.filter((task) => task.done).map((task) => task.title).sort()).toEqual([
				'Call the facilities manager',
				'Send the quote',
			])
		})
	})
}
