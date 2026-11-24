import { afterEach, describe, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { Field } from '../Field'
import type { FormErrorLike } from '../Form'
import { FormDialog } from '../FormDialog'
import { Input, Select } from '../inputs'
import { type StandardIssue, type StandardSchema, useForm } from '../use-form'
import { byText, click, key, mount, type Mounted, query } from './dom'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

interface DealInput {
	readonly title: string
	readonly value: string
	readonly stage: string
}

interface Deal {
	readonly title: string
	readonly value: number
	readonly stage: string
}

// A schema as zod's `~standard` answers: a whole number from its text, a required title, and a check over two fields.
const dealSchema: StandardSchema<DealInput, Deal> = {
	'~standard': {
		validate(input) {
			const read = (name: string): string => {
				const value: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, name) : undefined
				return typeof value === 'string' ? value : ''
			}
			const issues: StandardIssue[] = []
			const title = read('title').trim()
			if (title === '') issues.push({ message: 'Enter a title', path: ['title'] })
			const value = read('value')
			if (!/^\d+$/.test(value)) issues.push({ message: 'Enter a whole number', path: [{ key: 'value' }] })
			if (read('stage') === 'won' && value === '0') issues.push({ message: 'A won deal has a value' })
			return issues.length > 0 ? { issues } : { value: { title, value: Number(value), stage: read('stage') } }
		},
	},
}

const blank: DealInput = { title: '', value: '', stage: 'lead' }

function Harness(
	{ onSubmit, error = null, initial = blank }: {
		readonly onSubmit: (deal: Deal) => Promise<unknown> | void
		readonly error?: FormErrorLike | null
		readonly initial?: DealInput
	},
) {
	const [open, setOpen] = useState(true)
	const form = useForm(dealSchema, initial)
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<FormDialog open={open} title="New deal" form={form} onSubmit={onSubmit} onClose={() => setOpen(false)} error={error} submitLabel="Create deal">
				<Field label="Title" required {...form.field('title')}>
					<Input />
				</Field>
				<Field label="Value" required {...form.field('value')}>
					<Input inputMode="numeric" />
				</Field>
				<Field label="Stage" {...form.field('stage')}>
					<Select options={[{ value: 'lead', label: 'Lead' }, { value: 'won', label: 'Won' }]} />
				</Field>
			</FormDialog>
		</>
	)
}

/** Sets a control's value as a person typing does: past React's value tracking, then the events React reads. */
async function type(control: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
	const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype
	await act(async () => {
		control.focus()
		Reflect.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
		control.dispatchEvent(new Event('input', { bubbles: true }))
		control.dispatchEvent(new Event('change', { bubbles: true }))
		// React may have loaded before happy-dom and then reads a text input's change on keyup, as the app kit's `type` does.
		control.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
	})
}

async function submit(root: ParentNode): Promise<void> {
	const form = query(root, 'form', HTMLFormElement)
	await act(async () => {
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
	})
}

const control = (name: string) => query(document, `[name="${name}"]`, HTMLElement)
const input = (name: string) => query(document, `input[name="${name}"]`, HTMLInputElement)
const describedBy = (element: Element) =>
	(element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent)

describe('useForm with a Field', () => {
	test('a bound field shows the value and writes what the person types', async () => {
		const submitted: Deal[] = []
		mounted = await mount(<Harness onSubmit={(deal) => void submitted.push(deal)} initial={{ title: 'Printers', value: '12', stage: 'lead' }} />)
		expect(input('title').value).toBe('Printers')
		await type(input('value'), '4200')
		await type(query(document, 'select[name="stage"]', HTMLSelectElement), 'won')
		await submit(document)
		expect(submitted).toEqual([{ title: 'Printers', value: 4200, stage: 'won' }])
	})
	test('other initial values (the record changed meanwhile) start the form over; the same values keep what was typed', async () => {
		mounted = await mount(<Harness onSubmit={() => {}} initial={{ title: 'Printers', value: '1', stage: 'lead' }} />)
		await type(input('title'), 'Mine')
		await mounted.render(<Harness onSubmit={() => {}} initial={{ title: 'Printers', value: '1', stage: 'lead' }} />)
		expect(input('title').value).toBe('Mine')
		await mounted.render(<Harness onSubmit={() => {}} initial={{ title: 'Printers, third floor', value: '1', stage: 'lead' }} />)
		expect(input('title').value).toBe('Printers, third floor')
	})
})

describe('FormDialog', () => {
	test('refused values never reach onSubmit: each message sits at its field, and the first refused field takes the focus', async () => {
		const submitted: Deal[] = []
		mounted = await mount(<Harness onSubmit={(deal) => void submitted.push(deal)} />)
		await type(input('value'), '12k')
		await submit(document)
		expect(submitted).toEqual([])
		expect(input('title').getAttribute('aria-invalid')).toBe('true')
		expect(describedBy(input('title'))).toEqual(['Enter a title'])
		expect(describedBy(input('value'))).toEqual(['Enter a whole number'])
		expect(document.activeElement).toBe(input('title'))
		expect(query(document, '[role="alert"]', HTMLElement).textContent).toBe('Check the highlighted fields.')
	})

	test('after a refusal a field clears as soon as it is fixed', async () => {
		mounted = await mount(<Harness onSubmit={() => {}} />)
		await submit(document)
		await type(input('title'), 'Printers')
		expect(input('title').hasAttribute('aria-invalid')).toBe(false)
		expect(input('value').getAttribute('aria-invalid')).toBe('true')
	})

	test('an issue of no field is the summary', async () => {
		mounted = await mount(<Harness onSubmit={() => {}} initial={{ title: 'Printers', value: '0', stage: 'won' }} />)
		await submit(document)
		expect(query(document, '[role="alert"]', HTMLElement).textContent).toBe('A won deal has a value')
	})

	test('while onSubmit runs the dialog is pending: a spinning submit, a disabled cancel, no dismissal, no second submit', async () => {
		let finish = () => {}
		let calls = 0
		mounted = await mount(
			<Harness
				initial={{ title: 'Printers', value: '1', stage: 'lead' }}
				onSubmit={() => {
					calls++
					return new Promise<void>((resolve) => {
						finish = resolve
					})
				}}
			/>,
		)
		await submit(document)
		const create = byText(document, 'button', 'Create deal', HTMLButtonElement)
		expect(create.disabled).toBe(true)
		expect(create.getAttribute('aria-busy')).toBe('true')
		expect(byText(document, 'button', 'Cancel', HTMLButtonElement).disabled).toBe(true)
		await key(query(document, '[role="dialog"]', HTMLElement), 'Escape')
		expect(document.querySelector('[role="dialog"]')).not.toBeNull()
		await submit(document)
		expect(calls).toBe(1)
		await act(async () => finish())
		expect(create.disabled).toBe(false)
	})

	test("the server's field errors show at their fields and take the focus; its message alone is the summary", async () => {
		const initial = { title: 'Printers', value: '1', stage: 'lead' }
		mounted = await mount(<Harness onSubmit={() => {}} initial={initial} />)
		await submit(document)
		await mounted.render(<Harness onSubmit={() => {}} initial={initial} error={{ message: 'Invalid input', fields: { value: 'Too large' } }} />)
		expect(describedBy(input('value'))).toEqual(['Too large'])
		expect(document.activeElement).toBe(input('value'))
		await mounted.render(<Harness onSubmit={() => {}} initial={initial} error={{ message: 'Your role in this org does not allow this.' }} />)
		expect(query(document, '[role="alert"]', HTMLElement).textContent).toBe('Your role in this org does not allow this.')
	})

	test('a reopened dialog starts from the initial values, without the errors it was closed with', async () => {
		mounted = await mount(<Harness onSubmit={() => {}} initial={{ title: 'Printers', value: '1', stage: 'lead' }} />)
		await type(input('title'), '')
		await submit(document)
		expect(input('title').getAttribute('aria-invalid')).toBe('true')
		await click(byText(document, 'button', 'Cancel', HTMLButtonElement))
		expect(document.querySelector('[role="dialog"]')).toBeNull()
		await click(byText(document, 'button', 'Open', HTMLButtonElement))
		expect(input('title').value).toBe('Printers')
		expect(input('title').hasAttribute('aria-invalid')).toBe(false)
		expect(control('title').id).not.toBe('')
	})
})
