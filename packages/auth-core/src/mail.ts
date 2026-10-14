// An application's wording of IAM's e-mails: per message and language, a subject, a plain-text body and optionally an
// HTML body, with `{{name}}` placeholders from a closed set. IAM fills them, escapes every value and puts in the action
// link; without an HTML body it builds the HTML part itself. The HTML body is a closed subset (`mailHtmlTokens`): text
// structure only, and a link only to `{{actionUrl}}`, `{{appUrl}}` or a `mailto:` address. The contract build, the
// static reader, IAM's schema parser and IAM's renderer all apply `mailTemplateProblems`.

import type { Locale } from './locale'

export const MESSAGE_KINDS = ['invitation', 'enrollment', 'reset'] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

/**
 * The placeholders each message fills. `companyLabel` and `message` are empty until an invitation carries them.
 * `appUrl` is the application's address, its first registered return origin: IAM sends a template that names it only
 * while one is registered, and its own wording otherwise.
 */
export const MAIL_PLACEHOLDERS = {
	invitation: ['displayName', 'recipient', 'inviterLabel', 'companyLabel', 'message', 'actionUrl', 'appUrl', 'expiry'],
	enrollment: ['displayName', 'recipient', 'actionUrl', 'appUrl', 'expiry'],
	reset: ['displayName', 'recipient', 'actionUrl', 'appUrl', 'expiry'],
} as const satisfies { readonly [K in MessageKind]: readonly string[] }

export type MailPlaceholder<K extends MessageKind> = (typeof MAIL_PLACEHOLDERS)[K][number]

/** One message in one language: the subject line, the plain-text body and, optionally, the HTML body. */
export interface MailTemplate {
	readonly subject: string
	readonly text: string
	/** A body in the closed HTML subset of `mailHtmlTokens`; absent, IAM builds the HTML part from `text`. */
	readonly html?: string
}

/** The contract's `mail`: the templates it declares, by message and language. A missing one is IAM's default. */
export type MailTemplates = { readonly [K in MessageKind]?: { readonly [L in Locale]?: MailTemplate } }

export const MAX_MAIL_SUBJECT_LENGTH = 200
export const MAX_MAIL_TEXT_BYTES = 8 * 1024
export const MAX_MAIL_HTML_BYTES = 16 * 1024

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export function isMessageKind(value: string): value is MessageKind {
	return MESSAGE_KINDS.some((kind) => kind === value)
}

/** Why `template` cannot be the `kind` message, one line each; empty when it can. */
export function mailTemplateProblems(kind: MessageKind, template: MailTemplate): string[] {
	const problems: string[] = []
	const { subject, text } = template
	if (subject.replaceAll(PLACEHOLDER, '').trim() === '') problems.push('the subject has no words of its own: a value may be empty')
	if (Array.from(subject).length > MAX_MAIL_SUBJECT_LENGTH) problems.push(`the subject is longer than ${MAX_MAIL_SUBJECT_LENGTH} characters`)
	if (/\p{Cc}/u.test(subject)) problems.push('the subject is not one line: it contains a line break or a control character')
	if (new TextEncoder().encode(text).length > MAX_MAIL_TEXT_BYTES) problems.push(`the text is longer than ${MAX_MAIL_TEXT_BYTES} bytes`)
	problems.push(...placeholderProblems(kind, 'the subject', subject), ...placeholderProblems(kind, 'the text', text))
	if (subject.includes('{{actionUrl}}')) problems.push('the subject names {{actionUrl}}: the one-time link belongs in the text, never in a header')
	if (!text.includes('{{actionUrl}}')) problems.push('the text has no {{actionUrl}}: IAM puts the one-time link there')
	if (template.html !== undefined) problems.push(...htmlProblems(kind, template.html))
	return problems
}

function htmlProblems(kind: MessageKind, html: string): string[] {
	if (new TextEncoder().encode(html).length > MAX_MAIL_HTML_BYTES) return [`the HTML is longer than ${MAX_MAIL_HTML_BYTES} bytes`]
	const parsed = mailHtmlTokens(html)
	const problems = [...placeholderProblems(kind, 'the HTML', html), ...(parsed.ok ? [] : parsed.problems)]
	if (parsed.ok && !parsed.tokens.some((token) => token.kind === 'open' && token.href === ACTION_URL)) {
		problems.push('the HTML has no <a href="{{actionUrl}}">: IAM puts the one-time link there')
	}
	return problems
}

/** The elements an HTML body may use: text structure, a list, a quote and a link. Nothing loads, runs or submits. */
export const MAIL_HTML_ELEMENTS = [
	'a',
	'b',
	'blockquote',
	'br',
	'div',
	'em',
	'h1',
	'h2',
	'h3',
	'hr',
	'i',
	'li',
	'ol',
	'p',
	'span',
	'strong',
	'u',
	'ul',
] as const

const VOID_ELEMENTS: readonly string[] = ['br', 'hr']
const ACTION_URL = '{{actionUrl}}'
const APP_URL = '{{appUrl}}'
const MAILTO = /^mailto:[^\s"'<>{}&]+$/
const CHARACTER_REFERENCE = /^&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/

/**
 * One piece of an HTML body: literal text (placeholders included, character references as written), an element that
 * opens (with a link's `href`, verbatim), or one that closes. IAM renders the body from these, never from its source.
 */
export type MailHtmlToken =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'open'; readonly name: string; readonly href: string | null }
	| { readonly kind: 'close'; readonly name: string }

interface RefusedHtml {
	readonly ok: false
	readonly problems: string[]
}

/**
 * An HTML body read by a small tokenizer that admits only `MAIL_HTML_ELEMENTS`, in lower case, balanced, with no
 * attribute but a link's double-quoted `href` to `{{actionUrl}}`, `{{appUrl}}` or a `mailto:` address, no comment and
 * no `&` that starts no character reference. So no script, style, form, frame, event handler, image, remote resource
 * or `javascript:`/`data:` URL can be written, and a value IAM inserts is text.
 */
export function mailHtmlTokens(html: string): { readonly ok: true; readonly tokens: MailHtmlToken[] } | RefusedHtml {
	const tokens: MailHtmlToken[] = []
	const open: string[] = []
	const refuse = (problem: string): RefusedHtml => ({ ok: false, problems: [problem] })
	let at = 0
	while (at < html.length) {
		const tag = html.indexOf('<', at)
		const end = tag === -1 ? html.length : tag
		if (end > at) {
			const text = html.slice(at, end)
			for (let amp = text.indexOf('&'); amp !== -1; amp = text.indexOf('&', amp + 1)) {
				if (!CHARACTER_REFERENCE.test(text.slice(amp))) return refuse('the HTML has an & that starts no character reference: write &amp;')
			}
			tokens.push({ kind: 'text', text })
		}
		if (tag === -1) break
		if (html.startsWith('<!--', tag)) return refuse('the HTML has a comment: an e-mail body has none')
		const close = html.indexOf('>', tag)
		if (close === -1) return refuse('the HTML has a < that ends no element: write &lt;')
		const source = html.slice(tag + 1, close)
		const closing = /^\/([a-z0-9]+)\s*$/.exec(source)
		if (closing !== null) {
			const name = closing[1] ?? ''
			if (open.at(-1) !== name) return refuse(`the HTML closes </${name}> where ${open.length === 0 ? 'nothing' : `<${open.at(-1)}>`} is open`)
			open.pop()
			tokens.push({ kind: 'close', name })
			at = close + 1
			continue
		}
		const opening = /^([a-z0-9]+)((?:\s+[^\s=]+="[^"]*")*)\s*(\/?)$/.exec(source)
		const name = opening?.[1]
		if (opening === null || name === undefined) {
			return refuse(`the HTML has <${source.slice(0, 40)}>, which is no element of the subset (attributes are double-quoted)`)
		}
		if (!MAIL_HTML_ELEMENTS.some((element) => element === name)) {
			return refuse(
				`the HTML has <${name}>, which an e-mail body may not use (allowed: ${MAIL_HTML_ELEMENTS.map((element) => `<${element}>`).join(', ')})`,
			)
		}
		let href: string | null = null
		for (const [, attribute = '', value = ''] of (opening[2] ?? '').matchAll(/([^\s=]+)="([^"]*)"/g)) {
			if (name !== 'a' || attribute !== 'href' || href !== null) {
				return refuse(`the HTML gives <${name}> the attribute ${attribute.slice(0, 40)}: only a link's href is allowed`)
			}
			if (value !== ACTION_URL && value !== APP_URL && !MAILTO.test(value)) {
				return refuse('the HTML links somewhere else: a link goes only to {{actionUrl}}, {{appUrl}} or a mailto: address')
			}
			href = value
		}
		const isVoid = VOID_ELEMENTS.includes(name)
		if (opening[3] === '/' && !isVoid) return refuse(`the HTML closes <${name}/> in its own tag: write <${name}></${name}>`)
		if (name === 'a' && href === null) return refuse('the HTML has an <a> without href')
		if (name === 'a' && open.includes('a')) return refuse('the HTML has a link inside a link')
		if (!isVoid) open.push(name)
		tokens.push({ kind: 'open', name, href })
		at = close + 1
	}
	if (open.length > 0) return refuse(`the HTML leaves <${open.at(-1)}> open`)
	return { ok: true, tokens }
}

function placeholderProblems(kind: MessageKind, part: string, value: string): string[] {
	const allowed: readonly string[] = MAIL_PLACEHOLDERS[kind]
	const problems: string[] = []
	for (const [, name = ''] of value.matchAll(PLACEHOLDER)) {
		if (!allowed.includes(name)) {
			problems.push(
				`${part} names {{${name.slice(0, 40)}}}, which the ${kind} message does not fill (allowed: ${allowed.map((key) => `{{${key}}}`).join(', ')})`,
			)
		}
	}
	if (value.replaceAll(PLACEHOLDER, '').includes('{{')) problems.push(`${part} has a {{ that opens no placeholder`)
	return problems
}

/** `template` with each placeholder replaced by its value; a name without a value becomes empty. */
export function fillMailTemplate(template: string, values: Readonly<Record<string, string>>): string {
	return template.replaceAll(PLACEHOLDER, (_, name: string) => values[name] ?? '')
}
