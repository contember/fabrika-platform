import { mountContainer } from './testing/dom'

import { AnnotationHostContext } from '@fabrika/annotations/runtime'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnotationEditor } from './AnnotationEditor'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

const REFUSAL = 'Refused by the server'
let server: ReturnType<typeof Bun.serve>
let uploads = 0
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch() {
			uploads++
			return Response.json({ error: REFUSAL }, { status: 400 })
		},
	})
})
afterAll(() => server.stop(true))

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
	uploads = 0
})

async function renderEditor() {
	const container = mountContainer('')
	root = createRoot(container)
	const host = { sessionId: 's', isShared: false, fsAvailable: false, uploadUrl: () => new URL('/upload', server.url).href }
	await act(async () => {
		root?.render(
			<AnnotationHostContext.Provider value={host}>
				<AnnotationEditor note="" onNoteChange={() => {}} images={[]} onAddImage={() => {}} onRemoveImage={() => {}} sessionId="s" />
			</AnnotationHostContext.Provider>,
		)
	})
	const input = container.querySelector('input[type="file"]')
	if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
	return { container, input }
}

async function choose(input: HTMLInputElement, file: File) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true })
	await act(async () => {
		input.dispatchEvent(new Event('change', { bubbles: true }))
		await Bun.sleep(50)
	})
}

test('the file picker offers only the image types the upload accepts', async () => {
	const { input } = await renderEditor()
	expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp')
})

test('an image of another type is refused with a message, without an upload', async () => {
	const { container, input } = await renderEditor()
	await choose(input, new File(['<svg />'], 'drawing.svg', { type: 'image/svg+xml' }))
	expect(uploads).toBe(0)
	expect(container.querySelector('[role="alert"]')?.textContent).toBe('Only PNG, JPEG, GIF and WebP images can be attached')
})

test('a refusal from the server is shown', async () => {
	const { container, input } = await renderEditor()
	await choose(input, new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' }))
	expect(uploads).toBe(1)
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(REFUSAL)
})
