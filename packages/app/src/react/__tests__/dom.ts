// The DOM of the hook tests: happy-dom's globals for this file's process, with Bun's own fetch kept (the clients'
// transport and the test kit run on it). Import it first. `bun test --isolate` gives each file its own globals.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const runtime = { fetch: globalThis.fetch, Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers }
GlobalRegistrator.register({ url: 'http://app.test/' })
Object.assign(globalThis, runtime)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
afterAll(() => GlobalRegistrator.unregister())

export interface Mounted {
	readonly container: HTMLElement
	render(node: ReactNode): Promise<void>
	unmount(): Promise<void>
}

/** Renders `node` into a fresh container, inside `act`, so its effects ran when the promise settles. */
export async function mount(node: ReactNode): Promise<Mounted> {
	const container = document.createElement('div')
	document.body.append(container)
	const root: Root = createRoot(container)
	const mounted: Mounted = {
		container,
		async render(next) {
			await act(async () => root.render(next))
		},
		async unmount() {
			await act(async () => root.unmount())
			container.remove()
		},
	}
	await mounted.render(node)
	return mounted
}

/** Lets every pending request and re-render settle. */
export async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
	}
}

/** Clicks `element` inside `act`, then lets what it started settle. */
export async function press(element: Element | null | undefined): Promise<void> {
	if (!(element instanceof HTMLElement)) throw new Error('nothing to press')
	await act(async () => element.click())
	await settle()
}
