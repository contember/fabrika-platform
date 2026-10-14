import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { Tabs } from '../Tabs'
import { key, mount, type Mounted, queryAll } from './dom'

type View = 'open' | 'won' | 'lost'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function DealTabs({ onChange }: { onChange: (view: View) => void }) {
	const [active, setActive] = useState<View>('open')
	return (
		<Tabs
			label="Deal views"
			items={[{ key: 'open', label: 'Open', count: 4 }, { key: 'won', label: 'Won' }, { key: 'lost', label: 'Lost', count: 0 }]}
			active={active}
			onChange={(view) => {
				onChange(view)
				setActive(view)
			}}
		/>
	)
}

const tabs = (root: HTMLElement) => queryAll(root, '[role="tab"]', HTMLButtonElement)
function tab(root: HTMLElement, index: number): HTMLButtonElement {
	const found = tabs(root)[index]
	if (found === undefined) throw new Error(`no tab ${index}`)
	return found
}
const selected = (root: HTMLElement) => tabs(root).find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('Tabs', () => {
	test('a key that is not a navigation key changes nothing', async () => {
		const changes: View[] = []
		mounted = await mount(<DealTabs onChange={(view) => changes.push(view)} />)
		const first = tab(mounted.container, 0)
		first.focus()
		await key(first, 'ArrowDown')
		expect(changes).toEqual([])
		expect(document.activeElement).toBe(first)
	})

	test('only the active tab is in the tab order, and the list is labelled', async () => {
		mounted = await mount(<DealTabs onChange={() => {}} />)
		expect(mounted.container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Deal views')
		expect(tabs(mounted.container).map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
		expect(selected(mounted.container)).toBe('Open4')
	})

	test('counts render as badges, zero included', async () => {
		mounted = await mount(<DealTabs onChange={() => {}} />)
		expect(queryAll(mounted.container, '.fui-count-badge', HTMLElement).map((badge) => badge.textContent)).toEqual(['4', '0'])
	})

	test('ArrowRight, ArrowLeft, Home and End move focus and select', async () => {
		const changes: View[] = []
		mounted = await mount(<DealTabs onChange={(view) => changes.push(view)} />)
		const root = mounted.container
		tab(root, 0).focus()

		await key(document.activeElement ?? root, 'ArrowRight')
		expect(document.activeElement).toBe(tab(root, 1))
		expect(selected(root)).toBe('Won')

		await key(document.activeElement ?? root, 'End')
		expect(document.activeElement).toBe(tab(root, 2))

		await key(document.activeElement ?? root, 'ArrowRight')
		expect(document.activeElement).toBe(tab(root, 0))

		await key(document.activeElement ?? root, 'ArrowLeft')
		expect(document.activeElement).toBe(tab(root, 2))

		await key(document.activeElement ?? root, 'Home')
		expect(document.activeElement).toBe(tab(root, 0))

		expect(changes).toEqual(['won', 'lost', 'open', 'lost', 'open'])
		expect(tabs(root).map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
	})
})
