// What an application themes through props and tokens instead of the kit's class names: the shell's top bar and its
// filled navigation, boxed tabs, a pill without its dot, a table's column widths and wrapping cells, and the tokens
// the stylesheet reads for the table head, the field label and the main region.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AppShell } from '../AppShell'
import { type Column, DataTable } from '../DataTable'
import { StatusPill } from '../StatusPill'
import { Tabs } from '../Tabs'
import { mount, type Mounted, query, queryAll } from './dom'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const nav = [{ label: 'Queue', href: '/queue', active: true, count: 12 }]

describe('AppShell', () => {
	test('has no top bar without a user or actions, or with topBar={false}; one with a user', async () => {
		mounted = await mount(
			<AppShell brand="Intake" nav={nav}>
				<p>Body</p>
			</AppShell>,
		)
		expect(mounted.container.querySelector('header')).toBeNull()
		await mounted.render(
			<AppShell brand="Intake" nav={nav} user="Ada" topBar={false}>
				<p>Body</p>
			</AppShell>,
		)
		expect(mounted.container.querySelector('header')).toBeNull()
		await mounted.render(
			<AppShell brand="Intake" nav={nav} user="Ada">
				<p>Body</p>
			</AppShell>,
		)
		expect(mounted.container.querySelector('header')?.textContent).toContain('Ada')
	})

	test("navStyle='filled' marks the shell for a filled current item and its inverted badge", async () => {
		mounted = await mount(
			<AppShell brand="Intake" nav={nav} navStyle="filled">
				<p>Body</p>
			</AppShell>,
		)
		expect(query(mounted.container, '.fui-shell', HTMLElement).classList.contains('fui-shell--nav-filled')).toBe(true)
	})
})

describe('Tabs, StatusPill and DataTable variants', () => {
	test("boxed tabs keep the tab list's roles and its counts", async () => {
		mounted = await mount(<Tabs label="Views" variant="boxed" items={[{ key: 'all', label: 'All', count: 3 }]} active="all" onChange={() => {}} />)
		const list = query(mounted.container, '[role="tablist"]', HTMLElement)
		expect(list.classList.contains('fui-tabs--boxed')).toBe(true)
		expect(queryAll(list, '[role="tab"]', HTMLButtonElement)[0]?.textContent).toBe('All3')
	})

	test('a pill without its dot', async () => {
		mounted = await mount(<StatusPill dot={false}>New</StatusPill>)
		expect(mounted.container.querySelector('.fui-pill__dot')).toBeNull()
		expect(mounted.container.textContent).toBe('New')
	})

	test('a column takes a width from the scale and a cell that wraps, on its head and on its cells', async () => {
		const columns: readonly Column<{ readonly id: string; readonly note: string }>[] = [
			{ key: 'note', header: 'Note', cell: (row) => row.note, width: 'lg', wrap: true },
			{ key: 'id', header: 'Id', cell: (row) => row.id },
		]
		mounted = await mount(<DataTable columns={columns} rows={[{ id: 'r1', note: 'A long note' }]} rowKey={(row) => row.id} />)
		const heads = queryAll(mounted.container, 'th', HTMLElement)
		const cells = queryAll(mounted.container, 'td', HTMLElement)
		for (const element of [heads[0], cells[0]]) {
			expect(element?.classList.contains('fui-table__cell--width-lg')).toBe(true)
			expect(element?.classList.contains('fui-table__cell--wrap')).toBe(true)
		}
		expect(cells[1]?.className).toBe('fui-table__cell')
	})
})

describe('the stylesheet', () => {
	const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8')
	const components = readFileSync(new URL('../components.css', import.meta.url), 'utf8')

	test.each([
		['--fui-table-head-transform', 'text-transform: var(--fui-table-head-transform)'],
		['--fui-table-head-tracking', 'letter-spacing: var(--fui-table-head-tracking)'],
		['--fui-label-color', 'color: var(--fui-label-color)'],
		['--fui-label-weight', 'font-weight: var(--fui-label-weight)'],
		['--fui-main-padding', 'padding: var(--fui-main-padding)'],
		['--fui-column-width-lg', 'width: var(--fui-column-width-lg)'],
	])('%s is a token the components read', (token, rule) => {
		expect(theme).toContain(`${token}:`)
		expect(components).toContain(rule)
	})
})
