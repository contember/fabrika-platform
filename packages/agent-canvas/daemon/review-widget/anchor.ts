import type { ReviewAnchor } from '../src/review/model'

const MAX_TEXT = 120
const QUOTE_CONTEXT = 40
const MAX_COMPONENTS = 8

function shorten(text: string, max = MAX_TEXT): string {
	const collapsed = text.replace(/\s+/g, ' ').trim()
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

const IMPLICIT_ROLES: Record<string, string> = {
	button: 'button',
	select: 'combobox',
	textarea: 'textbox',
	h1: 'heading',
	h2: 'heading',
	h3: 'heading',
	h4: 'heading',
	h5: 'heading',
	h6: 'heading',
	img: 'img',
	nav: 'navigation',
	main: 'main',
	dialog: 'dialog',
	table: 'table',
	tr: 'row',
	th: 'columnheader',
	td: 'cell',
	li: 'listitem',
	ul: 'list',
	ol: 'list',
	form: 'form',
}

const INPUT_ROLES: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' }

export function roleOf(element: Element): string | undefined {
	const explicit = element.getAttribute('role')
	if (explicit !== null && explicit !== '') return explicit.split(' ')[0]
	const tag = element.tagName.toLowerCase()
	if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined
	if (tag === 'input') return INPUT_ROLES[element.getAttribute('type') ?? 'text'] ?? 'textbox'
	return IMPLICIT_ROLES[tag]
}

/** The accessible name, approximated: the sources a reviewer's element usually has, in the order the spec reads them. */
export function nameOf(element: Element): string | undefined {
	const label = element.getAttribute('aria-label')
	if (label !== null && label.trim() !== '') return shorten(label)
	const labelledBy = element.getAttribute('aria-labelledby')
	if (labelledBy !== null) {
		const text = labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
		if (text.trim() !== '') return shorten(text)
	}
	if (element.id !== '') {
		const forLabel = element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`)
		if (forLabel?.textContent != null && forLabel.textContent.trim() !== '') return shorten(forLabel.textContent)
	}
	for (const attribute of ['alt', 'title', 'placeholder']) {
		const value = element.getAttribute(attribute)
		if (value !== null && value.trim() !== '') return shorten(value)
	}
	const role = roleOf(element)
	const namedByContent = role === 'button' || role === 'link' || role === 'heading' || role === 'cell' || role === 'columnheader' || role === 'tab'
		|| role === 'menuitem' || role === 'option'
	if (namedByContent && element.textContent !== null && element.textContent.trim() !== '') return shorten(element.textContent)
	return undefined
}

/** A CSS path from the nearest ancestor with an id, or from `body`, using `:nth-of-type` only where siblings share a tag. */
export function selectorOf(element: Element): string {
	const parts: string[] = []
	let current: Element | null = element
	while (current !== null && current.tagName.toLowerCase() !== 'body' && current.tagName.toLowerCase() !== 'html') {
		if (current.id !== '' && current.ownerDocument.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
			parts.unshift(`#${CSS.escape(current.id)}`)
			return parts.join(' > ')
		}
		const tag = current.tagName.toLowerCase()
		const parent: Element | null = current.parentElement
		const sameTag = parent === null ? [] : [...parent.children].filter((child) => child.tagName === current?.tagName)
		parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag)
		current = parent
	}
	parts.unshift('body')
	return parts.join(' > ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function componentName(type: unknown): string | undefined {
	if (typeof type === 'function') {
		const displayName: unknown = Reflect.get(type, 'displayName')
		if (typeof displayName === 'string' && displayName !== '') return displayName
		return type.name === '' ? undefined : type.name
	}
	if (isRecord(type)) {
		// memo() wraps the component in `type`, forwardRef() in `render`.
		return componentName(type['type']) ?? componentName(type['render'])
	}
	return undefined
}

/** Owner components of a React development build, outermost first; empty for other renderers and production builds. */
export function componentsOf(element: Element): string[] {
	const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))
	if (fiberKey === undefined) return []
	const names: string[] = []
	let fiber: unknown = Reflect.get(element, fiberKey)
	while (isRecord(fiber) && names.length < 40) {
		// Bundlers suffix a name that collides in their scope (`Card` → `Card13`); the source still says `Card`.
		const name = componentName(fiber['type'])?.replace(/(?<=[a-z])\d+$/, '')
		// Context providers wrap whole apps and say nothing about where the element is.
		if (name !== undefined && /^[A-Z]/.test(name) && !name.endsWith('Provider') && names[0] !== name) names.unshift(name)
		fiber = fiber['return']
	}
	return names.slice(-MAX_COMPONENTS)
}

function quoteOf(element: Element, range: Range): ReviewAnchor['quote'] {
	const exact = range.toString().trim()
	if (exact === '') return undefined
	const before = element.ownerDocument.createRange()
	before.selectNodeContents(element)
	before.setEnd(range.startContainer, range.startOffset)
	const after = element.ownerDocument.createRange()
	after.selectNodeContents(element)
	after.setStart(range.endContainer, range.endOffset)
	return {
		exact: exact.slice(0, 2000),
		before: before.toString().replace(/\s+/g, ' ').slice(-QUOTE_CONTEXT),
		after: after.toString().replace(/\s+/g, ' ').slice(0, QUOTE_CONTEXT),
	}
}

/** Describes the element, or the selection inside it, so the agent can find it in code and the widget in the page. */
export function describe(element: Element, url: string, range?: Range): ReviewAnchor {
	const role = roleOf(element)
	const name = nameOf(element)
	const text = element.textContent === null ? '' : shorten(element.textContent)
	const components = componentsOf(element)
	const quote = range === undefined ? undefined : quoteOf(element, range)
	return {
		url,
		selector: selectorOf(element),
		...(role === undefined ? {} : { role }),
		...(name === undefined ? {} : { name }),
		...(text === '' ? {} : { text }),
		...(components.length === 0 ? {} : { components }),
		...(quote === undefined ? {} : { quote }),
	}
}

function matches(element: Element, anchor: ReviewAnchor): boolean {
	if (anchor.role !== undefined && roleOf(element) !== anchor.role) return false
	if (anchor.name !== undefined && nameOf(element) !== anchor.name) return false
	return true
}

/**
 * Re-finds the anchored element after the page re-rendered: the CSS path when it still points at an element with the
 * same role and name, otherwise the only element with that role and name.
 */
export function find(document: Document, anchor: ReviewAnchor): Element | null {
	let bySelector: Element | null = null
	try {
		bySelector = document.querySelector(anchor.selector)
	} catch {
		bySelector = null
	}
	if (bySelector !== null && matches(bySelector, anchor)) return bySelector
	if (anchor.role !== undefined && anchor.name !== undefined) {
		const candidates = [...document.body.querySelectorAll('*')].filter((element) => matches(element, anchor))
		if (candidates.length === 1) return candidates[0] ?? null
	}
	return bySelector
}
