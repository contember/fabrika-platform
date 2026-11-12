import { mountContainer } from '@fabrika/annotations/testing/dom.ts'
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasHostContext, type CanvasThread, type CanvasThreads, localCanvasHost } from './hostContext'
import { ThreadList } from './ThreadList'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
})

function thread(state: CanvasThread['state'], agentBody: string): CanvasThread {
	return {
		id: 'ann-1',
		state,
		revision: 1,
		snippet: 'selected wording',
		comments: [{ id: 'c1', author: 'agent', body: agentBody, createdAt: '2026-01-01T00:00:00.000Z' }],
	}
}

function fakeThreads(initial: CanvasThread[]): CanvasThreads & { set: (next: CanvasThread[]) => void } {
	let threads = initial
	const listeners = new Set<() => void>()
	return {
		subscribe(onChange) {
			listeners.add(onChange)
			return () => listeners.delete(onChange)
		},
		current: () => threads,
		reply: async () => {},
		setResolved: async () => {},
		set(next) {
			threads = next
			for (const listener of listeners) listener()
		},
	}
}

async function mount(threads: CanvasThreads): Promise<HTMLElement> {
	const container = mountContainer('')
	root = createRoot(container)
	await act(async () =>
		root?.render(
			<CanvasHostContext.Provider value={{ ...localCanvasHost, threads }}>
				<ThreadList />
			</CanvasHostContext.Provider>,
		)
	)
	return container
}

test('HTML in an agent reply is shown as text, markdown is still formatted', async () => {
	const container = await mount(fakeThreads([thread('open', '**Fixed** <img src=x onerror="alert(1)">')]))
	expect(container.querySelector('img')).toBeNull()
	expect(container.querySelector('strong')?.textContent).toBe('Fixed')
	expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
})

test('a reply draft survives the thread moving to the resolved list', async () => {
	const store = fakeThreads([thread('open', 'Done')])
	const container = await mount(store)
	const textarea = container.querySelector('textarea')
	if (textarea === null) throw new Error('no reply box')
	await act(async () => {
		textarea.value = 'one more thing'
		textarea.dispatchEvent(new Event('input', { bubbles: true }))
	})
	await act(async () => store.set([thread('resolved', 'Done')]))
	expect(container.querySelector('textarea')?.value).toBe('one more thing')
})

test('an agent reply keeps https links and drops script URLs to their text', async () => {
	const body = '[docs](https://example.com/a) [click](javascript:alert(1)) ![x](javascript:alert(2)) <javascript:alert(3)>'
	const container = await mount(fakeThreads([thread('open', body)]))
	const hrefs = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
	expect(hrefs).toEqual(['https://example.com/a'])
	expect(container.querySelector('img')).toBeNull()
	expect(container.textContent).toContain('click')
})

test('an entity cannot spell a script or data URL in an agent reply', async () => {
	const body = [
		'[a](javascript&colon;alert(1))',
		'[b](&#106;avascript:alert(1))',
		'[c](javascript&#58;alert(1))',
		'[d][ref]',
		'![e](&#100;ata:text/html,x)',
	].join(' ') + '\n\n[ref]: javascript&colon;alert(1)\n'
	const container = await mount(fakeThreads([thread('open', body)]))
	const urls = [
		...[...container.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? ''),
		...[...container.querySelectorAll('img')].map((image) => image.getAttribute('src') ?? ''),
	]
	for (const url of urls) expect(new URL(url, 'https://canvas.test/').protocol).toBe('https:')
})
