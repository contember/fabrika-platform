// The challenge widget in the DOM: what it fetches and posts, what it reports, and its translated texts. The DOM comes
// first: the widget registers its element when it loads.

import { mount, type Mounted } from './dom'

import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { Challenge } from '../Challenge'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

/** What React handed the registered element: a property where it defines one, an attribute otherwise. */
function setting(element: Element | undefined, name: string): unknown {
	return element === undefined ? undefined : (Reflect.get(element, name) ?? element.getAttribute(name))
}

function widget(container: HTMLElement): HTMLElement {
	const element = container.querySelector('altcha-widget')
	if (!(element instanceof HTMLElement)) throw new Error('no altcha-widget rendered')
	return element
}

async function report(element: HTMLElement, detail: Record<string, unknown>): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new CustomEvent('statechange', { detail }))
	})
}

describe('Challenge', () => {
	test('renders the widget against the procedure’s challenge URL, posting its payload as challengeToken', async () => {
		mounted = await mount(<Challenge url="https://notes.test/__fabrika/challenge/register" />)
		const element = widget(mounted.container)
		expect(setting(element, 'challenge')).toBe('https://notes.test/__fabrika/challenge/register')
		expect(setting(element, 'name')).toBe('challengeToken')
		expect(setting(element, 'auto')).toBe('off')
		expect(element.className).toBe('fui-challenge')
		expect(customElements.get('altcha-widget')).toBeDefined()
	})

	test('reports the solved payload, and null once it expires or fails', async () => {
		const tokens: (string | null)[] = []
		mounted = await mount(<Challenge url="/__fabrika/challenge/register" onToken={(token) => tokens.push(token)} />)
		const element = widget(mounted.container)
		await report(element, { state: 'verifying' })
		await report(element, { state: 'verified', payload: 'eyJjaGFsbGVuZ2UiOnt9fQ==' })
		await report(element, { state: 'expired' })
		await report(element, { state: 'error' })
		expect(tokens).toEqual(['eyJjaGFsbGVuZ2UiOnt9fQ==', null, null])
	})

	test('translated strings are registered once, under a language of their own', async () => {
		const strings = { label: 'Nejsem robot', verified: 'Ověřeno' }
		mounted = await mount(
			<>
				<Challenge url="/__fabrika/challenge/a" strings={strings} />
				<Challenge url="/__fabrika/challenge/b" strings={{ verified: 'Ověřeno', label: 'Nejsem robot' }} />
			</>,
		)
		const [first, second] = [...mounted.container.querySelectorAll('altcha-widget')]
		const language = String(setting(first, 'language'))
		expect(language).toMatch(/^x-fui-\d+$/)
		expect(setting(second, 'language')).toBe(language)
		expect(globalThis.$altcha.i18n.get(language)).toMatchObject({
			label: 'Nejsem robot',
			verified: 'Ověřeno',
			expired: 'Verification expired. Try again.',
		})
	})

	test('only the texts the widget renders as text reach it: never its footer, which it renders as HTML', async () => {
		const strings = { label: 'Nejsem robot', footer: '<img src=x onerror=alert(1)>' }
		mounted = await mount(<Challenge url="/__fabrika/challenge/c" strings={strings} />)
		const language = String(setting(widget(mounted.container), 'language'))
		const registered = globalThis.$altcha.i18n.get(language)
		expect(registered?.['label']).toBe('Nejsem robot')
		expect(registered?.['footer']).not.toContain('onerror')
	})
})
