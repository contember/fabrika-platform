// An application's wording of IAM's e-mails: per message and language, a subject and a plain-text body with `{{name}}`
// placeholders from a closed set. IAM fills them, builds the HTML part itself and puts in the action link. The contract
// build, the static reader, IAM's schema parser and IAM's renderer all apply `mailTemplateProblems`.

import type { Locale } from './locale'

export const MESSAGE_KINDS = ['invitation', 'enrollment', 'reset'] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** The placeholders each message fills. `companyLabel` and `message` are empty until an invitation carries them. */
export const MAIL_PLACEHOLDERS = {
	invitation: ['displayName', 'recipient', 'inviterLabel', 'companyLabel', 'message', 'actionUrl', 'expiry'],
	enrollment: ['displayName', 'recipient', 'actionUrl', 'expiry'],
	reset: ['displayName', 'recipient', 'actionUrl', 'expiry'],
} as const satisfies { readonly [K in MessageKind]: readonly string[] }

export type MailPlaceholder<K extends MessageKind> = (typeof MAIL_PLACEHOLDERS)[K][number]

/** One message in one language: the subject line and the plain-text body. */
export interface MailTemplate {
	readonly subject: string
	readonly text: string
}

/** The contract's `mail`: the templates it declares, by message and language. A missing one is IAM's default. */
export type MailTemplates = { readonly [K in MessageKind]?: { readonly [L in Locale]?: MailTemplate } }

export const MAX_MAIL_SUBJECT_LENGTH = 200
export const MAX_MAIL_TEXT_BYTES = 8 * 1024

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export function isMessageKind(value: string): value is MessageKind {
	return MESSAGE_KINDS.some((kind) => kind === value)
}

/** Why `template` cannot be the `kind` message, one line each; empty when it can. */
export function mailTemplateProblems(kind: MessageKind, template: MailTemplate): string[] {
	const problems: string[] = []
	const { subject, text } = template
	if (subject.trim() === '') problems.push('the subject is empty')
	if (Array.from(subject).length > MAX_MAIL_SUBJECT_LENGTH) problems.push(`the subject is longer than ${MAX_MAIL_SUBJECT_LENGTH} characters`)
	if (/\p{Cc}/u.test(subject)) problems.push('the subject is not one line: it contains a line break or a control character')
	if (new TextEncoder().encode(text).length > MAX_MAIL_TEXT_BYTES) problems.push(`the text is longer than ${MAX_MAIL_TEXT_BYTES} bytes`)
	problems.push(...placeholderProblems(kind, 'the subject', subject), ...placeholderProblems(kind, 'the text', text))
	if (!text.includes('{{actionUrl}}')) problems.push('the text has no {{actionUrl}}: IAM puts the one-time link there')
	return problems
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
