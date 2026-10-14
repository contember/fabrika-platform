// @fabrika/app/react/testing — what a screen test of an SPA needs: happy-dom's document over Bun's own web platform,
// and typing that React reads. No test-runner dependency; happy-dom's registrator is an optional peer dependency.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

/**
 * The classes and functions of Bun's web platform a screen test keeps: the client, the test kit, a form's challenge and
 * a download run on them, and happy-dom's own differ (a happy-dom `File` of a Bun `Blob` holds `[object Blob]`).
 */
const BUN_GLOBALS = [
	'fetch',
	'Request',
	'Response',
	'Headers',
	'AbortController',
	'AbortSignal',
	'URL',
	'URLSearchParams',
	'Blob',
	'File',
	'FormData',
	'TextEncoder',
	'TextDecoder',
	'ReadableStream',
] as const

export interface InstalledDom {
	/** Closes the window and removes its globals; call it from the test file's `afterAll`. */
	uninstall(): Promise<void>
}

export interface DomOptions {
	/** The page's address; `http://app.test/` by default. A router needs a real origin. */
	readonly url?: string
}

/**
 * Installs happy-dom's window as the globals, keeping Bun's fetch, abort, URL, blob, file and form classes, with
 * navigation off: a download's link click leaves the page where it is, so a later test of the file still has it. Call
 * it in a module the test file imports first: React reads `window` when it loads.
 */
export function installDom(options: DomOptions = {}): InstalledDom {
	const kept = BUN_GLOBALS.map((name) => [name, Reflect.get(globalThis, name)] as const)
	GlobalRegistrator.register({
		url: options.url ?? 'http://app.test/',
		settings: {
			navigation: {
				disableMainFrameNavigation: true,
				disableChildFrameNavigation: true,
				disableChildPageNavigation: true,
				disableFallbackToSetURL: true,
			},
		},
	})
	for (const [name, value] of kept) Reflect.set(globalThis, name, value)
	Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
	return {
		async uninstall() {
			// A request a screen started may still settle: let it, before its window goes.
			await new Promise((resolve) => setTimeout(resolve, 50))
			await GlobalRegistrator.unregister()
		},
	}
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

/**
 * The text a label gives its control: what is hidden from assistive technology (a required marker) left out, and so
 * is a control the label wraps.
 */
function readText(element: Element): string {
	const copy = element.cloneNode(true)
	if (copy instanceof Element) {
		for (const left of copy.querySelectorAll('[aria-hidden="true"], input, textarea, select')) left.remove()
	}
	return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A control's accessible name: its `aria-label`, the elements `aria-labelledby` names, or its `<label>`. */
function nameOf(control: Control): string {
	const aria = control.getAttribute('aria-label')
	if (aria !== null) return aria.trim()
	const labelledBy = control.getAttribute('aria-labelledby')
	if (labelledBy !== null) {
		return labelledBy.split(/\s+/).map((id) => {
			const label = control.ownerDocument.getElementById(id)
			return label === null ? '' : readText(label)
		}).join(' ').trim()
	}
	const labels = control.labels === null ? [] : [...control.labels]
	return labels.map(readText).join(' ').trim()
}

const isControl = (element: Element): element is Control =>
	element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement

/** The one input, textarea or select whose accessible name is `label`; throws when there is none or more than one. */
export function controlByLabel(label: string, within: ParentNode = document.body): Control {
	const found = [...within.querySelectorAll('input, textarea, select')].filter(isControl).filter((control) => nameOf(control) === label)
	const [control] = found
	if (control === undefined || found.length > 1) {
		throw new Error(`${found.length === 0 ? 'no' : found.length} control${found.length > 1 ? 's' : ''} labelled '${label}'`)
	}
	return control
}

/** The prototype whose `value` setter React's own value tracking does not see, so the next event reads as a change. */
function valueSetter(control: Control): ((value: string) => void) | undefined {
	const prototype = control instanceof HTMLTextAreaElement
		? HTMLTextAreaElement.prototype
		: control instanceof HTMLSelectElement
		? HTMLSelectElement.prototype
		: HTMLInputElement.prototype
	return Object.getOwnPropertyDescriptor(prototype, 'value')?.set
}

/**
 * Types `value` into the control labelled `label`, as React reads a person typing: it focuses the control, sets the
 * value past React's tracking, and sends `input`, `change` and `keyup`. A select takes the option's value.
 */
export async function type(label: string, value: string, within?: ParentNode): Promise<void> {
	const control = controlByLabel(label, within)
	await act(async () => {
		control.focus()
		valueSetter(control)?.call(control, value)
		control.dispatchEvent(new Event('input', { bubbles: true }))
		control.dispatchEvent(new Event('change', { bubbles: true }))
		control.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
	})
}

/** Waits, letting React render, until the text of `within` holds `text`; throws after `timeoutMs` (2 s by default). */
export async function waitForText(text: string, options: { readonly within?: Element; readonly timeoutMs?: number } = {}): Promise<void> {
	const within = options.within ?? document.body
	const deadline = Date.now() + (options.timeoutMs ?? 2000)
	while (!(within.textContent ?? '').includes(text)) {
		if (Date.now() > deadline) throw new Error(`the page did not show '${text}' in time`)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		})
	}
}
