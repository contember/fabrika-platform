import { MAX_HTML } from '../src/review/model'

const MAX_CHILDREN = 8
const MAX_TEXT = 80
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

function trimTree(node: Element, depth: number): void {
	if (node.tagName.toLowerCase() === 'svg') {
		node.replaceChildren()
		return
	}
	let elements = 0
	for (const child of [...node.childNodes]) {
		if (child.nodeType === Node.TEXT_NODE) {
			const text = child.textContent ?? ''
			if (text.trim() === '') child.remove()
			else if (text.length > MAX_TEXT) child.textContent = `${text.slice(0, MAX_TEXT)}…`
			continue
		}
		if (!(child instanceof Element) || DROPPED_TAGS.has(child.tagName)) {
			child.remove()
			continue
		}
		elements++
		if (depth === 0 || elements > MAX_CHILDREN) child.remove()
		else trimTree(child, depth - 1)
	}
	if (depth === 0 && elements > 0) node.append(node.ownerDocument.createComment(` ${elements} child elements cut `))
	else if (elements > MAX_CHILDREN) node.append(node.ownerDocument.createComment(` ${elements - MAX_CHILDREN} more `))
}

/** The element's markup, shallower until it fits: the agent sees structure, classes and attributes, not whole subtrees. */
export function htmlOf(element: Element): string {
	for (let depth = 5; depth >= 0; depth--) {
		const clone = element.cloneNode(true)
		if (!(clone instanceof Element)) return ''
		trimTree(clone, depth)
		const html = clone.outerHTML
		if (html.length <= MAX_HTML) return html
	}
	const shallow = element.cloneNode(false)
	return shallow instanceof Element ? shallow.outerHTML.slice(0, MAX_HTML) : ''
}

function headingIn(container: Element): string | undefined {
	const label = container.getAttribute('aria-label')
	if (label !== null && label.trim() !== '') return label.trim()
	const labelledBy = container.getAttribute('aria-labelledby')
	const labelElement = labelledBy === null ? null : container.ownerDocument.getElementById(labelledBy.split(/\s+/)[0] ?? '')
	const heading = labelElement ?? container.querySelector('h1, h2, h3, h4, legend, [role="heading"]')
	const text = heading?.textContent?.replace(/\s+/g, ' ').trim()
	return text === undefined || text === '' ? undefined : text.slice(0, 80)
}

const LANDMARKS: readonly { selector: string; kind: string }[] = [
	{ selector: 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]', kind: 'Dialog' },
	{ selector: 'section, article, fieldset, form, [role="region"], [role="tabpanel"]', kind: 'Section' },
]

/** The page heading and the nearest section and dialog around the element, outermost first. */
export function contextOf(element: Element): string | undefined {
	const parts: string[] = []
	const pageHeading = element.ownerDocument.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()
	if (pageHeading !== undefined && pageHeading !== '') parts.push(`Page "${pageHeading.slice(0, 80)}"`)
	for (const landmark of LANDMARKS) {
		const container = element.closest(landmark.selector)
		const heading = container === null ? undefined : headingIn(container)
		if (heading !== undefined && !parts.includes(`Page "${heading}"`)) parts.push(`${landmark.kind} "${heading}"`)
	}
	return parts.length === 0 ? undefined : parts.join(' › ')
}
