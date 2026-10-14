import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { ConfirmDialog, Dialog } from '../Dialog'
import { byText, click, key, mount, type Mounted } from './dom'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function Harness({ onClose }: { onClose?: () => void }) {
	const [open, setOpen] = useState(false)
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<Dialog
				open={open}
				title="Rename deal"
				description="The new name shows everywhere."
				onClose={() => {
					onClose?.()
					setOpen(false)
				}}
				actions={<button type="button">Save</button>}
			>
				<input aria-label="Name" />
			</Dialog>
		</>
	)
}

const dialog = () => document.querySelector('[role="dialog"]')

async function openHarness(onClose?: () => void): Promise<HTMLButtonElement> {
	mounted = await mount(<Harness onClose={onClose} />)
	const opener = byText(mounted.container, 'button', 'Open', HTMLButtonElement)
	opener.focus()
	await click(opener)
	return opener
}

describe('Dialog', () => {
	test('a closed dialog renders nothing', async () => {
		mounted = await mount(<Dialog open={false} title="Hidden" onClose={() => {}} />)
		expect(mounted.container.innerHTML).toBe('')
	})

	test('it is a labelled, described modal dialog', async () => {
		await openHarness()
		const element = dialog()
		expect(element?.getAttribute('aria-modal')).toBe('true')
		expect(document.getElementById(element?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Rename deal')
		expect(document.getElementById(element?.getAttribute('aria-describedby') ?? '')?.textContent).toBe('The new name shows everywhere.')
	})

	test('focus moves to the first focusable element inside on open', async () => {
		await openHarness()
		expect(document.activeElement?.getAttribute('aria-label')).toBe('Close')
		expect(dialog()?.contains(document.activeElement)).toBe(true)
	})

	test('focus moves to the dialog itself when nothing inside is focusable', async () => {
		mounted = await mount(<Dialog open title="Note" onClose={() => {}} closeLabel="Dismiss" />)
		const close = document.querySelector('[aria-label="Dismiss"]')
		expect(document.activeElement).toBe(close)
	})

	test('Tab from the last element wraps to the first, and Shift+Tab back', async () => {
		await openHarness()
		const element = dialog()
		if (!element) throw new Error('dialog did not open')
		const save = byText(element, 'button', 'Save', HTMLButtonElement)
		const close = byText(element, 'button', '×', HTMLButtonElement)
		save.focus()
		await key(save, 'Tab')
		expect(document.activeElement).toBe(close)
		await key(close, 'Tab', { shiftKey: true })
		expect(document.activeElement).toBe(save)
	})

	test('Escape calls onClose and focus returns to the opener', async () => {
		let closes = 0
		const opener = await openHarness(() => closes++)
		await key(document.activeElement ?? document.body, 'Escape')
		expect(closes).toBe(1)
		expect(dialog()).toBeNull()
		expect(document.activeElement).toBe(opener)
	})

	test('a click on the overlay closes, a click inside does not', async () => {
		let closes = 0
		await openHarness(() => closes++)
		const element = dialog()
		if (!element?.parentElement) throw new Error('dialog did not open')
		await click(element)
		expect(closes).toBe(0)
		await click(element.parentElement)
		expect(closes).toBe(1)
	})
})

describe('ConfirmDialog', () => {
	test('pending disables cancel and ignores Escape; confirm calls onConfirm', async () => {
		const calls: string[] = []
		const props = {
			open: true,
			title: 'Delete deal?',
			message: 'This cannot be undone.',
			confirmLabel: 'Delete',
			tone: 'danger' as const,
			onConfirm: () => calls.push('confirm'),
			onCancel: () => calls.push('cancel'),
		}
		mounted = await mount(<ConfirmDialog {...props} pending />)
		await key(document.activeElement ?? document.body, 'Escape')
		expect(calls).toEqual([])
		expect(byText(document.body, 'button', 'Cancel', HTMLButtonElement).disabled).toBe(true)
		expect(byText(document.body, 'button', 'Delete', HTMLButtonElement).getAttribute('aria-busy')).toBe('true')

		await mounted.render(<ConfirmDialog {...props} />)
		await click(byText(document.body, 'button', 'Delete', HTMLButtonElement))
		await click(byText(document.body, 'button', 'Cancel', HTMLButtonElement))
		expect(calls).toEqual(['confirm', 'cancel'])
	})
})
