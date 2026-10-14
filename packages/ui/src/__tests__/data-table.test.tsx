import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { type Column, DataTable, type DataTableProps, type LoadMore } from '../DataTable'
import { byText, click, mount, type Mounted, query, queryAll } from './dom'

interface Deal {
	readonly id: string
	readonly title: string
	readonly amount: number
}

const deals: readonly Deal[] = [
	{ id: 'd1', title: 'Alpha', amount: 100 },
	{ id: 'd2', title: 'Beta', amount: 250 },
	{ id: 'd3', title: 'Gamma', amount: 75 },
]

const columns: readonly Column<Deal>[] = [
	{ key: 'title', header: 'Title', cell: (deal) => deal.title, grow: true },
	{ key: 'amount', header: 'Amount', cell: (deal) => deal.amount, align: 'end' },
]

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function SelectableTable({ rows = deals, onActions }: { rows?: readonly Deal[]; onActions?: (keys: readonly string[]) => void }) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
	return (
		<DataTable
			columns={columns}
			rows={rows}
			rowKey={(deal) => deal.id}
			selection={{ selected, onChange: setSelected }}
			selectRowLabel={(deal) => `Select ${deal.title}`}
			selectionActions={(keys) => {
				onActions?.(keys)
				return <button type="button">Archive {keys.join(',')}</button>
			}}
		/>
	)
}

function table(props: Partial<DataTableProps<Deal>>) {
	return <DataTable columns={columns} rows={deals} rowKey={(deal) => deal.id} {...props} />
}

const headerCheckbox = (root: HTMLElement) => query(root, 'thead input[type="checkbox"]', HTMLInputElement)
function byRowLabel(root: HTMLElement, label: string): HTMLInputElement {
	const found = queryAll(root, 'tbody label', HTMLLabelElement).find((element) => element.textContent === label)
	const input = found?.querySelector('input')
	if (!(input instanceof HTMLInputElement)) throw new Error(`no row checkbox labelled ${label}`)
	return input
}
const toolbar = (root: HTMLElement) => root.querySelector('[role="toolbar"]')

describe('DataTable selection', () => {
	test('the toolbar is absent without a selection', async () => {
		mounted = await mount(<SelectableTable />)
		expect(toolbar(mounted.container)).toBeNull()
		expect(headerCheckbox(mounted.container).checked).toBe(false)
		expect(headerCheckbox(mounted.container).indeterminate).toBe(false)
	})

	test('the header checkbox selects every visible row, then clears them', async () => {
		mounted = await mount(<SelectableTable />)
		await click(headerCheckbox(mounted.container))
		for (const deal of deals) expect(byRowLabel(mounted.container, `Select ${deal.title}`).checked).toBe(true)
		expect(headerCheckbox(mounted.container).checked).toBe(true)
		expect(queryAll(mounted.container, 'tr.fui-table__row--selected', HTMLTableRowElement)).toHaveLength(3)

		await click(headerCheckbox(mounted.container))
		for (const deal of deals) expect(byRowLabel(mounted.container, `Select ${deal.title}`).checked).toBe(false)
		expect(toolbar(mounted.container)).toBeNull()
	})

	test('the header checkbox is indeterminate when only some rows are selected', async () => {
		mounted = await mount(<SelectableTable />)
		await click(byRowLabel(mounted.container, 'Select Beta'))
		const header = headerCheckbox(mounted.container)
		expect(header.indeterminate).toBe(true)
		expect(header.checked).toBe(false)
		expect(header.getAttribute('aria-checked')).toBe('mixed')
	})

	test('the toolbar shows the count and the actions with the selected keys, and Clear empties it', async () => {
		const seen: (readonly string[])[] = []
		mounted = await mount(<SelectableTable onActions={(keys) => seen.push(keys)} />)
		await click(byRowLabel(mounted.container, 'Select Alpha'))
		await click(byRowLabel(mounted.container, 'Select Gamma'))
		const bar = toolbar(mounted.container)
		expect(bar?.getAttribute('aria-label')).toBe('Selection')
		expect(bar?.textContent).toContain('2 selected')
		expect(bar?.textContent).toContain('Archive d1,d3')
		expect(seen.at(-1)).toEqual(['d1', 'd3'])

		await click(byText(mounted.container, 'button', 'Clear selection', HTMLButtonElement))
		expect(toolbar(mounted.container)).toBeNull()
		expect(byRowLabel(mounted.container, 'Select Alpha').checked).toBe(false)
	})

	test('select all keeps selected rows that are not visible', async () => {
		let latest: ReadonlySet<string> = new Set()
		mounted = await mount(
			table({
				rows: deals.slice(0, 2),
				selection: { selected: new Set(['hidden']), onChange: (next) => (latest = next) },
			}),
		)
		await click(headerCheckbox(mounted.container))
		expect([...latest].sort()).toEqual(['d1', 'd2', 'hidden'])
	})
})

describe('DataTable status', () => {
	test('loading shows placeholder rows and an accessible status, and no data rows', async () => {
		mounted = await mount(table({ status: 'loading' }))
		expect(query(mounted.container, '[role="status"]', HTMLElement).textContent).toBe('Loading…')
		expect(queryAll(mounted.container, 'tr.fui-table__row--skeleton', HTMLTableRowElement).length).toBeGreaterThan(0)
		expect(mounted.container.textContent).not.toContain('Alpha')
	})

	test('a failed first load shows the message and Retry calls onRetry', async () => {
		let retries = 0
		mounted = await mount(table({ rows: [], status: 'error', error: 'Could not load deals', onRetry: () => retries++ }))
		expect(query(mounted.container, '[role="alert"]', HTMLElement).textContent).toBe('Could not load deals')
		expect(mounted.container.textContent).not.toContain('Alpha')
		await click(byText(mounted.container, 'button', 'Retry', HTMLButtonElement))
		expect(retries).toBe(1)
	})

	test('error without onRetry has no Retry button', async () => {
		mounted = await mount(table({ status: 'error', error: 'Nope' }))
		expect(queryAll(mounted.container, 'button', HTMLButtonElement)).toHaveLength(0)
	})

	test('ready with zero rows shows the default empty text, or the given one', async () => {
		mounted = await mount(table({ rows: [] }))
		expect(mounted.container.querySelector('tbody')?.textContent).toBe('Nothing here yet')
		await mounted.render(table({ rows: [], empty: 'No deals match' }))
		expect(mounted.container.querySelector('tbody')?.textContent).toBe('No deals match')
	})

	test('ready rows render cells, and end-aligned columns are marked for tabular numbers', async () => {
		mounted = await mount(table({ caption: 'Deals' }))
		expect(query(mounted.container, 'caption', HTMLElement).textContent).toBe('Deals')
		const cells = queryAll(mounted.container, 'tbody tr:first-child td', HTMLTableCellElement)
		expect(cells.map((cell) => cell.textContent)).toEqual(['Alpha', '100'])
		expect(cells[1]?.className).toContain('fui-table__cell--end')
	})
})

describe('DataTable load more', () => {
	const loadMore = (overrides: Partial<LoadMore>): LoadMore => ({ hasMore: true, loading: false, onLoadMore: () => {}, ...overrides })

	test('no button without hasMore', async () => {
		mounted = await mount(table({ loadMore: loadMore({ hasMore: false }) }))
		expect(mounted.container.textContent).not.toContain('Load more')
	})

	test('the button calls onLoadMore, and is disabled and busy while loading', async () => {
		let calls = 0
		mounted = await mount(table({ loadMore: loadMore({ onLoadMore: () => calls++ }) }))
		const button = byText(mounted.container, 'button', 'Load more', HTMLButtonElement)
		expect(button.disabled).toBe(false)
		await click(button)
		expect(calls).toBe(1)

		await mounted.render(table({ loadMore: loadMore({ loading: true, label: 'More deals' }) }))
		const busy = byText(mounted.container, 'button', 'More deals', HTMLButtonElement)
		expect(busy.disabled).toBe(true)
		expect(busy.getAttribute('aria-busy')).toBe('true')
	})
})

describe('a failed later page', () => {
	test('keeps the loaded rows and shows the error with a retry after them', async () => {
		let retried = 0
		mounted = await mount(
			<DataTable columns={columns} rows={deals} rowKey={(deal) => deal.id} status="error" error="The next page failed" onRetry={() => retried++} />,
		)
		const rows = queryAll(mounted.container, 'tbody tr', HTMLTableRowElement).map((row) => row.textContent)
		expect(rows.slice(0, 3)).toEqual(['Alpha100', 'Beta250', 'Gamma75'])
		expect(rows[3]).toContain('The next page failed')
		await click(byText(mounted.container, 'button', 'Retry', HTMLButtonElement))
		expect(retried).toBe(1)
	})
})
