/**
 * DOM harness for the component tests. Import it FIRST in every test file: ESM evaluates imports in order, so the
 * globals exist before React or a component reads `document`.
 *
 * happy-dom runs no layout: assert on structure, ARIA, focus and callbacks, never on geometry.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

if (!globalThis.document) {
	// happy-dom replaces the fetch stack with its own; keep Bun's so nothing outside the DOM changes behaviour.
	const runtimeFetch = globalThis.fetch
	const runtimeResponse = globalThis.Response
	const runtimeRequest = globalThis.Request
	const runtimeHeaders = globalThis.Headers

	// The router needs a real origin: History API calls on `about:blank` fail.
	GlobalRegistrator.register({ url: 'http://app.test/' })

	globalThis.fetch = runtimeFetch
	globalThis.Response = runtimeResponse
	globalThis.Request = runtimeRequest
	globalThis.Headers = runtimeHeaders

	afterAll(async () => {
		await GlobalRegistrator.unregister()
	})
}

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

export interface Mounted {
	readonly container: HTMLElement
	render(node: ReactNode): Promise<void>
	unmount(): Promise<void>
}

/** Mounts `node` into a fresh container that replaces whatever the previous test left in the shared document. */
export async function mount(node: ReactNode): Promise<Mounted> {
	document.body.innerHTML = '<div data-testid="container"></div>'
	const container = document.body.firstElementChild
	if (!(container instanceof HTMLElement)) throw new Error('container did not mount')
	const root: Root = createRoot(container)
	const mounted: Mounted = {
		container,
		async render(next) {
			await act(async () => root.render(next))
		},
		async unmount() {
			await act(async () => root.unmount())
		},
	}
	await mounted.render(node)
	return mounted
}

export function query<E extends Element>(root: ParentNode, selector: string, type: abstract new(...args: never[]) => E): E {
	const element = root.querySelector(selector)
	if (!(element instanceof type)) throw new Error(`no ${type.name} matches ${selector}`)
	return element
}

export function queryAll<E extends Element>(root: ParentNode, selector: string, type: abstract new(...args: never[]) => E): E[] {
	return [...root.querySelectorAll(selector)].filter((element): element is E => element instanceof type)
}

/** A primary-button click; `init` adds modifier keys or another button. Answers whether the event was prevented. */
export async function click(element: Element, init: MouseEventInit = {}): Promise<boolean> {
	const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
	await act(async () => {
		element.dispatchEvent(event)
	})
	return event.defaultPrevented
}

export async function key(element: Element, keyName: string, init: KeyboardEventInit = {}): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }))
	})
}

export function byText<E extends Element>(root: ParentNode, selector: string, text: string, type: abstract new(...args: never[]) => E): E {
	const found = queryAll(root, selector, type).find((element) => element.textContent?.trim() === text)
	if (found === undefined) throw new Error(`no ${selector} with text ${JSON.stringify(text)}`)
	return found
}
