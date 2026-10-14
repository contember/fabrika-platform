import { afterEach, describe, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { AppShell } from '../AppShell'
import { Button, ButtonLink } from '../Button'
import { FieldList } from '../FieldList'
import { Checkbox } from '../inputs'
import { ToastProvider, useToast } from '../Toast'
import { byText, click, mount, type Mounted, query, queryAll } from './dom'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

describe('Button', () => {
	test('defaults to type button and the secondary variant', async () => {
		mounted = await mount(<Button>Save</Button>)
		const button = query(mounted.container, 'button', HTMLButtonElement)
		expect(button.type).toBe('button')
		expect(button.className).toContain('fui-button--secondary')
		expect(button.hasAttribute('aria-busy')).toBe(false)
	})

	test('loading disables it, marks it busy, shows a spinner and keeps the label', async () => {
		let clicks = 0
		mounted = await mount(
			<Button variant="primary" loading onClick={() => clicks++}>
				Save
			</Button>,
		)
		const button = query(mounted.container, 'button', HTMLButtonElement)
		expect(button.disabled).toBe(true)
		expect(button.getAttribute('aria-busy')).toBe('true')
		expect(button.querySelector('.fui-spinner')).not.toBeNull()
		expect(button.textContent).toBe('Save')
		await click(button)
		expect(clicks).toBe(0)
	})

	test('ButtonLink is an anchor styled as a button', async () => {
		mounted = await mount(<ButtonLink href="/deals/new" variant="primary" size="sm">New deal</ButtonLink>)
		const link = query(mounted.container, 'a', HTMLAnchorElement)
		expect(link.getAttribute('href')).toBe('/deals/new')
		expect(link.className).toBe('fui-button fui-button--primary fui-button--sm')
	})
})

describe('Checkbox', () => {
	test('sets the DOM indeterminate property and reports the new checked state', async () => {
		const changes: boolean[] = []
		function Harness() {
			const [mixed, setMixed] = useState(true)
			return (
				<>
					<Checkbox label="All" checked={false} indeterminate={mixed} onChange={(checked) => changes.push(checked)} />
					<button type="button" onClick={() => setMixed(false)}>
						Settle
					</button>
				</>
			)
		}
		mounted = await mount(<Harness />)
		const input = query(mounted.container, 'input', HTMLInputElement)
		expect(input.indeterminate).toBe(true)
		await click(input)
		expect(changes).toEqual([true])
		await click(byText(mounted.container, 'button', 'Settle', HTMLButtonElement))
		expect(input.indeterminate).toBe(false)
	})
})

describe('ToastProvider', () => {
	test('useToast outside the provider throws a clear error', async () => {
		function Orphan() {
			useToast()
			return null
		}
		const original = console.error
		console.error = () => {}
		try {
			await expect(mount(<Orphan />)).rejects.toThrow('inside a <ToastProvider>')
		} finally {
			console.error = original
		}
	})

	test('show adds a toast to the polite live region, dismiss removes it, and the timeout removes it', async () => {
		function Trigger() {
			const toast = useToast()
			return (
				<>
					<button type="button" onClick={() => toast.show({ tone: 'success', message: 'Saved', timeoutMs: 0 })}>
						Sticky
					</button>
					<button type="button" onClick={() => toast.show({ message: 'Brief', timeoutMs: 20 })}>
						Brief
					</button>
				</>
			)
		}
		mounted = await mount(
			<ToastProvider>
				<Trigger />
			</ToastProvider>,
		)
		const region = query(mounted.container, '.fui-toast-region', HTMLElement)
		expect(region.getAttribute('role')).toBe('status')
		expect(region.getAttribute('aria-live')).toBe('polite')

		await click(byText(mounted.container, 'button', 'Sticky', HTMLButtonElement))
		await click(byText(mounted.container, 'button', 'Brief', HTMLButtonElement))
		expect(queryAll(region, '.fui-toast', HTMLElement).map((toast) => toast.textContent)).toEqual(['Saved×', 'Brief×'])
		expect(region.querySelector('.fui-toast--success')?.textContent).toBe('Saved×')

		await act(async () => {
			await Bun.sleep(40)
		})
		expect(queryAll(region, '.fui-toast', HTMLElement).map((toast) => toast.textContent)).toEqual(['Saved×'])

		await click(query(region, 'button[aria-label="Dismiss"]', HTMLButtonElement))
		expect(queryAll(region, '.fui-toast', HTMLElement)).toHaveLength(0)
	})
})

describe('AppShell', () => {
	test('landmarks, the active item marked as the current page, and counts', async () => {
		mounted = await mount(
			<AppShell
				brand="CRM"
				nav={[{ label: 'Deals', href: '/deals', active: true, count: 3 }, { label: 'Contacts', href: '/contacts' }]}
				user="Jana"
			>
				<p>Body</p>
			</AppShell>,
		)
		const root = mounted.container
		expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('Main')
		expect(root.querySelector('header')?.textContent).toContain('Jana')
		expect(root.querySelector('main')?.textContent).toBe('Body')
		const links = queryAll(root, 'nav a', HTMLAnchorElement)
		expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['page', null])
		expect(links[0]?.querySelector('.fui-count-badge')?.textContent).toBe('3')
	})
})

describe('FieldList', () => {
	test('a blank value shows a muted dash, zero does not', async () => {
		mounted = await mount(
			<FieldList
				items={[{ label: 'Owner', value: null }, { label: 'Note', value: '' }, { label: 'Missing', value: undefined }, { label: 'Count', value: 0 }]}
			/>,
		)
		expect(queryAll(mounted.container, 'dd', HTMLElement).map((dd) => dd.textContent)).toEqual(['—', '—', '—', '0'])
	})
})
