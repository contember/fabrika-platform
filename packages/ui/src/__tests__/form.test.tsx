import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { Field } from '../Field'
import { Form, type FormErrorLike } from '../Form'
import { Input, Select, Textarea } from '../inputs'
import { mount, type Mounted, query } from './dom'

let mounted: Mounted | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const describedBy = (control: Element) =>
	(control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent)

describe('Field', () => {
	test('a control without an error is not marked invalid and has no error description', async () => {
		mounted = await mount(
			<Field label="Title" hint="Shown on the board">
				<Input />
			</Field>,
		)
		const input = query(mounted.container, 'input', HTMLInputElement)
		expect(input.hasAttribute('aria-invalid')).toBe(false)
		expect(describedBy(input)).toEqual(['Shown on the board'])
	})

	test('the control gets the id the label points at, and describedby the hint and the error', async () => {
		mounted = await mount(
			<Field label="Title" hint="Shown on the board" error="Title is required" required>
				<Input />
			</Field>,
		)
		const input = query(mounted.container, 'input', HTMLInputElement)
		const label = query(mounted.container, 'label', HTMLLabelElement)
		expect(input.id).not.toBe('')
		expect(label.htmlFor).toBe(input.id)
		expect(input.getAttribute('aria-invalid')).toBe('true')
		expect(input.required).toBe(true)
		expect(describedBy(input)).toEqual(['Shown on the board', 'Title is required'])
		expect(query(mounted.container, '.fui-field__error', HTMLElement).hasAttribute('role')).toBe(false)
	})

	test('an author-given id and describedby are kept', async () => {
		mounted = await mount(
			<>
				<p id="extra">Extra</p>
				<Field label="Notes" error="Too long">
					<Textarea id="notes" aria-describedby="extra" />
				</Field>
			</>,
		)
		const textarea = query(mounted.container, 'textarea', HTMLTextAreaElement)
		expect(textarea.id).toBe('notes')
		expect(describedBy(textarea)).toEqual(['Extra', 'Too long'])
		// One id for both: the label names the control the author identified.
		expect(query(mounted.container, 'label', HTMLLabelElement).htmlFor).toBe('notes')
	})

	test('Select reads the field too and renders the placeholder first', async () => {
		mounted = await mount(
			<Field label="Stage" name="stage" error="Pick a stage">
				<Select placeholder="Choose…" options={[{ value: 'lead', label: 'Lead' }]} defaultValue="" />
			</Field>,
		)
		const select = query(mounted.container, 'select', HTMLSelectElement)
		expect(select.getAttribute('aria-invalid')).toBe('true')
		expect(select.name).toBe('stage')
		expect([...select.options].map((option) => option.textContent)).toEqual(['Choose…', 'Lead'])
	})
})

describe('Form', () => {
	const form = (error: FormErrorLike | null, onSubmit: (data: FormData) => void = () => {}) => (
		<Form onSubmit={onSubmit} error={error}>
			<Field label="Title" name="title">
				<Input defaultValue="Alpha" />
			</Field>
			<Field label="Amount" name="amount">
				<Input />
			</Field>
			<button type="submit">Save</button>
		</Form>
	)

	test('no error shows no summary and marks nothing invalid', async () => {
		mounted = await mount(form(null))
		expect(mounted.container.querySelector('[role="alert"]')).toBeNull()
		expect(mounted.container.querySelector('[aria-invalid]')).toBeNull()
	})

	test('a plain error shows its message in the summary', async () => {
		mounted = await mount(form({ message: 'You may not edit this deal' }))
		expect(query(mounted.container, '[role="alert"]', HTMLElement).textContent).toBe('You may not edit this deal')
		expect(mounted.container.querySelector('[aria-invalid]')).toBeNull()
	})

	test('field errors route to the Field with that name, under a summary that points at them', async () => {
		mounted = await mount(form({ message: 'Invalid input', fields: { amount: 'Must be positive' } }))
		expect(query(mounted.container, '[role="alert"]', HTMLElement).textContent).toBe('Check the highlighted fields.')
		const [title, amount] = [...mounted.container.querySelectorAll('input')]
		expect(title?.hasAttribute('aria-invalid')).toBe(false)
		expect(amount?.getAttribute('aria-invalid')).toBe('true')
		expect(amount ? describedBy(amount) : []).toEqual(['Must be positive'])
	})

	test('submit hands the form data to onSubmit and prevents the navigation', async () => {
		const submitted: (string | null)[] = []
		mounted = await mount(form(null, (data) => submitted.push(data.get('title') === null ? null : String(data.get('title')))))
		const element = query(mounted.container, 'form', HTMLFormElement)
		expect(element.noValidate).toBe(true)
		const event = new Event('submit', { bubbles: true, cancelable: true })
		await act(async () => {
			element.dispatchEvent(event)
		})
		expect(event.defaultPrevented).toBe(true)
		expect(submitted).toEqual(['Alpha'])
	})
})
