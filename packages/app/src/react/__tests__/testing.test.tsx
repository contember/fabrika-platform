// `@fabrika/app/react/testing` itself: the DOM keeps Bun's web platform and does not navigate, and `type` is a change
// React reads, found by the control's label.

import { mount, press } from './dom'

import { controlByLabel, type, waitForText } from '@fabrika/app/react/testing'
import { describe, expect, test } from 'bun:test'
import { type FormEvent, type ReactNode, useState } from 'react'

describe('installDom', () => {
	test("keeps Bun's blob, file, form and abort classes, so a file made of a fetched blob holds its bytes", async () => {
		const blob = await new Response('a,b\r\n').blob()
		const file = new File([blob], 'rows.csv', { type: 'text/csv' })
		expect(await file.text()).toBe('a,b\r\n')
		const form = new FormData()
		form.append('file', file)
		expect(form.get('file')).toBeInstanceOf(File)
		expect(new AbortController().signal).toBeInstanceOf(AbortSignal)
	})

	test('a submitted form gives its handler the fields a browser sends, in a FormData of Bun', async () => {
		let submitted: FormData | undefined
		// `Form`'s handler of @fabrika/ui, plus the submitter a browser passes.
		const onSubmit = (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault()
			submitted = new FormData(event.currentTarget, event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null)
		}
		const view = await mount(
			<form onSubmit={onSubmit}>
				<label>
					Title
					<input name="title" />
				</label>
				<textarea name="note" aria-label="Note" />
				<select name="tags" multiple defaultValue={['a', 'c']}>
					<option value="a">A</option>
					<option value="b">B</option>
					<option value="c">C</option>
				</select>
				<input type="checkbox" name="urgent" defaultChecked />
				<input type="checkbox" name="archived" value="yes" />
				<input type="radio" name="size" value="s" />
				<input type="radio" name="size" value="m" defaultChecked />
				<input name="locked" defaultValue="x" disabled />
				<fieldset disabled>
					<input name="pending" defaultValue="x" />
				</fieldset>
				<input type="file" name="attachment" />
				<button type="submit" name="intent" value="save">Save</button>
				<button type="submit" name="intent" value="discard">Discard</button>
			</form>,
		)
		await type('Title', 'Report', view.container)
		await type('Note', 'first\nsecond', view.container)
		await press(view.container.querySelector('button[value="save"]'))
		await view.unmount()
		expect(submitted).toBeInstanceOf(FormData)
		const entries = [...(submitted?.entries() ?? [])].map((
			[name, value]: readonly [string, unknown],
		) => [name, value instanceof File ? value.name : value])
		expect(entries).toEqual([
			['title', 'Report'],
			['note', 'first\nsecond'],
			['tags', 'a'],
			['tags', 'c'],
			['urgent', 'on'],
			['size', 'm'],
			['attachment', ''],
			['intent', 'save'],
		])
	})

	test("a download's link click leaves the page where it is", async () => {
		const before = window.location.href
		const link = document.createElement('a')
		link.href = URL.createObjectURL(new Blob(['x']))
		link.download = 'x.txt'
		link.click()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(window.location.href).toBe(before)
		expect(document.body).not.toBeNull()
	})
})

describe('type and controlByLabel', () => {
	function Filters(): ReactNode {
		const [title, setTitle] = useState('')
		const [status, setStatus] = useState('open')
		const [note, setNote] = useState('')
		return (
			<form>
				<label htmlFor="title">
					Title<span aria-hidden="true">*</span>
				</label>
				<input id="title" type="search" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
				<label>
					Status
					<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
						<option value="open">Open</option>
						<option value="done">Done</option>
					</select>
				</label>
				<textarea aria-label="Note" value={note} onChange={(event) => setNote(event.currentTarget.value)} />
				<output>{`${title}|${status}|${note}`}</output>
			</form>
		)
	}

	test('a controlled input, select and textarea see the typed value, each found by its accessible name', async () => {
		const view = await mount(<Filters />)
		await type('Title', 'report')
		await type('Status', 'done')
		await type('Note', 'hello')
		await waitForText('report|done|hello')
		expect(view.container.querySelector('output')?.textContent).toBe('report|done|hello')
		expect(() => controlByLabel('Missing')).toThrow("no control labelled 'Missing'")
		await view.unmount()
	})
})
