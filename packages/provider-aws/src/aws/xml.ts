// The strict, minimal XML reader for the few CloudFormation and RDS answers the provider reads (ADR-0081): AWS's query
// protocol answers in XML. It reads elements, their attributes and their text, and nothing else.
//
// Refused, never skipped: a DTD or any `<!…>` (so no entity can be declared or expanded), a processing instruction
// other than the leading XML declaration, a comment, CDATA, an entity other than the five XML predefines, mixed content
// (text beside child elements), a duplicate attribute, a mismatched close, and anything after the root. The document,
// its depth and its element count are bounded. A refusal names the problem and its offset, never the content.
//
// Character references (`&#13;`, `&#xA;`) are read: AWS's serializers write a line break in a value that way. They
// declare nothing and expand to one character, which must be one XML allows. Literal line ends are normalized as XML
// 1.0 says (§2.11: CRLF and CR become LF; §3.3.3: a literal tab, CR or LF in an attribute value becomes a space); a
// reference keeps the character it names.

/** One element: its name, its attributes, its child elements, and its text (empty when it has children). */
export interface XmlElement {
	readonly name: string
	readonly attributes: Readonly<Record<string, string>>
	readonly children: readonly XmlElement[]
	readonly text: string
}

/** Bounds lower than the defaults; a higher one is held to its default (a deeper document would exhaust the stack). */
export interface XmlLimits {
	/** The longest document read, in characters. */
	readonly maxLength?: number
	/** The deepest nesting, the root counted as 1. */
	readonly maxDepth?: number
	/** The most elements in the document. */
	readonly maxElements?: number
}

export const XML_MAX_LENGTH = 1024 * 1024
export const XML_MAX_DEPTH = 32
export const XML_MAX_ELEMENTS = 50_000

/** A document the reader refuses: `reason` names the problem, `offset` where it was found; neither quotes the content. */
export class XmlError extends Error {
	constructor(readonly reason: string, readonly offset: number) {
		super(`XML: ${reason} at offset ${offset}`)
		this.name = 'XmlError'
	}
}

/** An element's or an attribute's name, without a namespace prefix on an element (AWS writes none). */
const ELEMENT_NAME = /[A-Za-z_][A-Za-z0-9_.-]*/y
const ATTRIBUTE_NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y
const WHITESPACE = /[ \t\r\n]*/y
/** XML's layout whitespace: space, tab, CR and LF, nothing else Unicode calls a space. */
const LAYOUT = /^[ \t\r\n]*$/
/**
 * The leading declaration: version 1.0, an optional UTF-8 encoding, an optional standalone. The keywords and `yes`/`no`
 * are lower case; only the encoding's name is read in any case.
 */
const DECLARATION =
	/<\?xml[ \t\r\n]+version=(["'])1\.0\1(?:[ \t\r\n]+encoding=(["'])[Uu][Tt][Ff]-8\2)?(?:[ \t\r\n]+standalone=(["'])(?:yes|no)\3)?[ \t\r\n]*\?>/y
/** The five predefined entities, in a `Map`, so no name finds a member of `Object.prototype`. */
const PREDEFINED: ReadonlyMap<string, string> = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]])

/** Whether `code` is a character XML 1.0 allows. */
function allowedCharacter(code: number): boolean {
	return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)
		|| (code >= 0x10000 && code <= 0x10ffff)
}

/** Reads `text` as one XML document and answers its root element. */
export function parseXml(text: string, limits: XmlLimits = {}): XmlElement {
	const maxLength = Math.min(limits.maxLength ?? XML_MAX_LENGTH, XML_MAX_LENGTH)
	const maxDepth = Math.min(limits.maxDepth ?? XML_MAX_DEPTH, XML_MAX_DEPTH)
	const maxElements = Math.min(limits.maxElements ?? XML_MAX_ELEMENTS, XML_MAX_ELEMENTS)
	if (text.length > maxLength) throw new XmlError('the document is too long', maxLength)
	let at = 0
	let elements = 0

	function fail(reason: string): never {
		throw new XmlError(reason, at)
	}
	function sticky(pattern: RegExp): string | null {
		pattern.lastIndex = at
		const match = pattern.exec(text)
		if (match === null) return null
		at = pattern.lastIndex
		return match[0]
	}
	function skipWhitespace(): void {
		sticky(WHITESPACE)
	}
	function expect(literal: string, reason: string): void {
		if (!text.startsWith(literal, at)) fail(reason)
		at += literal.length
	}

	/**
	 * Text up to `end` (exclusive), its references expanded and its literal line ends normalized; in an attribute value a
	 * literal tab or line end is a space. A raw `<` is refused.
	 */
	function decode(end: number, inAttribute: boolean): string {
		let out = ''
		while (at < end) {
			const code = text.codePointAt(at) ?? 0
			if (!allowedCharacter(code)) fail('a character XML does not allow')
			const character = String.fromCodePoint(code)
			if (character === '<') fail('a raw "<" in text')
			if (character !== '&') {
				at += character.length
				// CRLF and CR are one LF (§2.11): a CR followed by LF leaves the LF to the next turn.
				const normalized = character === '\r' ? (text[at] === '\n' && at < end ? '' : '\n') : character
				out += inAttribute && (normalized === '\t' || normalized === '\n') ? ' ' : normalized
				continue
			}
			const close = text.indexOf(';', at)
			if (close === -1 || close > end || close - at > 12) fail('an unterminated reference')
			const name = text.slice(at + 1, close)
			const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(name)
			if (numeric !== null) {
				const value = numeric[1] === undefined ? Number.parseInt(numeric[2] ?? '', 10) : Number.parseInt(numeric[1], 16)
				if (!allowedCharacter(value)) fail('a reference to a character XML does not allow')
				out += String.fromCodePoint(value)
			} else {
				const predefined = PREDEFINED.get(name)
				if (predefined === undefined) fail('an entity other than the five predefined')
				out += predefined
			}
			at = close + 1
		}
		return out
	}

	function element(depth: number): XmlElement {
		if (depth > maxDepth) fail('the document is nested too deep')
		elements += 1
		if (elements > maxElements) fail('the document has too many elements')
		expect('<', 'an element was expected')
		const name = sticky(ELEMENT_NAME) ?? fail('an element name was expected')
		if (text[at] === ':') fail('a namespace prefix on an element')
		// A `Map`, so an attribute named `__proto__` is one like any other, and its duplicate is found.
		const read = new Map<string, string>()
		for (;;) {
			const before = at
			skipWhitespace()
			if (text.startsWith('/>', at)) {
				at += 2
				return { name, attributes: Object.fromEntries(read), children: [], text: '' }
			}
			if (text.startsWith('>', at)) {
				at += 1
				break
			}
			if (at === before) fail('whitespace before an attribute was expected')
			const attribute = sticky(ATTRIBUTE_NAME) ?? fail('an attribute name was expected')
			if (read.has(attribute)) fail('a duplicate attribute')
			skipWhitespace()
			expect('=', 'an attribute value was expected')
			skipWhitespace()
			const quote = text[at]
			if (quote !== '"' && quote !== "'") fail('a quoted attribute value was expected')
			at += 1
			const end = text.indexOf(quote, at)
			if (end === -1) fail('an unterminated attribute value')
			read.set(attribute, decode(end, true))
			at = end + 1
		}

		const children: XmlElement[] = []
		let content = ''
		let layout = true
		for (;;) {
			if (at >= text.length) fail('the document ends inside an element')
			if (text.startsWith('</', at)) {
				at += 2
				const closing = sticky(ELEMENT_NAME)
				if (text[at] === ':') fail('a namespace prefix on an element')
				if (closing !== name) fail('a close that does not match its element')
				skipWhitespace()
				expect('>', 'the end of a close was expected')
				break
			}
			if (text.startsWith('<!', at) || text.startsWith('<?', at)) fail('a comment, CDATA, DTD or processing instruction')
			if (text.startsWith('<', at)) {
				children.push(element(depth + 1))
				continue
			}
			const next = text.indexOf('<', at)
			const end = next === -1 ? text.length : next
			const raw = text.slice(at, end)
			// XML's character data never holds `]]>` (`]]&gt;` is the way to write it).
			if (raw.includes(']]>')) fail('"]]>" in text')
			// Layout is judged on the raw text: a reference, even to a space, is content.
			if (!LAYOUT.test(raw)) layout = false
			content += decode(end, false)
		}
		// Whitespace between child elements is layout; any other text beside them is mixed content.
		if (children.length > 0) {
			if (!layout) fail('text beside child elements')
			content = ''
		}
		return { name, attributes: Object.fromEntries(read), children, text: content }
	}

	if (text.startsWith('﻿')) at = 1
	if (text.startsWith('<?xml', at) && sticky(DECLARATION) === null) fail('an XML declaration this reader does not take')
	skipWhitespace()
	if (text.startsWith('<!', at) || text.startsWith('<?', at)) fail('a comment, CDATA, DTD or processing instruction')
	const root = element(1)
	skipWhitespace()
	if (at !== text.length) fail('content after the root element')
	return root
}

/** The child elements of `parent` named `name`, in order. */
export function xmlChildren(parent: XmlElement, name: string): readonly XmlElement[] {
	return parent.children.filter((child) => child.name === name)
}

// The lookups' reasons quote only `name`, the caller's constant, never a name the document wrote.

/** The one child of `parent` named `name`, `null` when there is none; more than one is an `XmlError`. */
export function xmlOptional(parent: XmlElement, name: string): XmlElement | null {
	const found = xmlChildren(parent, name)
	if (found.length > 1) throw new XmlError(`more than one "${name}"`, 0)
	return found[0] ?? null
}

/** The one child of `parent` named `name`; none or more than one is an `XmlError`. */
export function xmlOne(parent: XmlElement, name: string): XmlElement {
	const found = xmlOptional(parent, name)
	if (found === null) throw new XmlError(`no "${name}"`, 0)
	return found
}

/** The text of the one child of `parent` named `name`, `null` when there is none; a child with elements is an `XmlError`. */
export function xmlText(parent: XmlElement, name: string): string | null {
	const found = xmlOptional(parent, name)
	if (found === null) return null
	if (found.children.length > 0) throw new XmlError(`"${name}" holds elements, not text`, 0)
	return found.text
}
