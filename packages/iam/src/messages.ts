import {
	fillMailTemplate,
	type MailHtmlToken,
	mailHtmlTokens,
	type MailPlaceholder,
	type MailTemplate,
	mailTemplateProblems,
	type MessageKind,
} from '@fabrika/auth-core'
import { type EmailMessage, MAX_EMAIL_SUBJECT_LENGTH } from '@fabrika/email'
import { type AppPresentation, landingUrl } from './app-presentation'
import { catalogFor, type MessageValues, type RenderedMessage } from './catalog'
import { escapeHtml } from './html'
import type { Services } from './services'

/** How long one send may take. IAM has no request-scoped signal that outlives `waitUntil`, so each send carries its own. */
export const EMAIL_SEND_DEADLINE_MS = 30_000

type Placeholders<K extends MessageKind> = { readonly [P in MailPlaceholder<K>]: string }

/** The values an application's template of each message names, beside those every message names. */
const PLACEHOLDER_VALUES: {
	readonly [K in MessageKind]: (values: MessageValues[K]) => Omit<Placeholders<K>, 'displayName' | 'expiry' | 'appUrl'>
} = {
	invitation: ({ recipient, inviterLabel, companyLabel, message, actionUrl }) => ({ recipient, inviterLabel, companyLabel, message, actionUrl }),
	enrollment: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
	reset: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
}

/**
 * The template IAM renders a presentation's `kind` e-mail with: the application's own wording in the presentation's
 * language when it declares one, else the catalog's. A stored template the rule no longer admits is the catalog's, and
 * so is one that names `{{appUrl}}` while the application has no registered return origin to build it from.
 */
export async function messageTemplateFor<K extends MessageKind>(
	services: Services,
	presentation: AppPresentation,
	kind: K,
): Promise<(values: MessageValues[K]) => RenderedMessage> {
	const catalog = catalogFor(presentation.locale)
	const app = presentation.app
	const row = app === null ? null : await services.repositories.appSchema.getMailTemplate(app, kind, presentation.locale)
	if (app === null || row === null) {
		return catalog.messages[kind]
	}
	const template: MailTemplate = { subject: row.subject, text: row.body, ...(row.html === null ? {} : { html: row.html }) }
	const html = template.html === undefined ? null : mailHtmlTokens(template.html)
	const appUrl = landingUrl(presentation)
	const namesAppUrl = [template.subject, template.text, template.html ?? ''].some((part) => part.includes('{{appUrl}}'))
	if (mailTemplateProblems(kind, template).length > 0 || (namesAppUrl && appUrl === null)) {
		return catalog.messages[kind]
	}
	const tokens = html !== null && html.ok ? html.tokens : null
	return (values) => {
		const placeholders: Readonly<Record<string, string>> = {
			...PLACEHOLDER_VALUES[kind](values),
			displayName: presentation.displayName ?? app,
			expiry: catalog.applicationMail.expiry(values.expiresAt),
			appUrl: appUrl ?? '',
		}
		const message = applicationMessage(template, placeholders, values.actionUrl, catalog.applicationMail.button[kind])
		return tokens === null ? message : { ...message, html: renderHtml(tokens, placeholders) }
	}
}

/**
 * An application's HTML body, rendered from its tokens and never from its source: each element as the subset writes
 * it, the literal text as the application wrote it (`mailHtmlTokens` admitted no `<` and no bare `&` in it), every value
 * escaped, and each link's `href` the escaped URL it names.
 */
function renderHtml(tokens: readonly MailHtmlToken[], placeholders: Readonly<Record<string, string>>): string {
	return tokens.map((token) => {
		if (token.kind === 'close') return `</${token.name}>`
		if (token.kind === 'open') {
			return token.href === null ? `<${token.name}>` : `<${token.name} href="${escapeHtml(fillMailTemplate(token.href, placeholders))}">`
		}
		return token.text.replaceAll(/\{\{([^{}]*)\}\}/g, (_, name: string) => escapeHtml(placeholders[name] ?? ''))
	}).join('')
}

/**
 * An application's wording filled in: the text as written, the subject on one line, and IAM's own HTML part — the
 * escaped text as paragraphs and IAM's button to the action URL. An application's own HTML body replaces that part.
 */
function applicationMessage(
	template: MailTemplate,
	placeholders: Readonly<Record<string, string>>,
	actionUrl: string,
	button: string,
): RenderedMessage {
	const text = fillMailTemplate(template.text, placeholders).replaceAll('\r\n', '\n')
	const oneLine = Object.fromEntries(Object.entries(placeholders).map(([name, value]) => [name, value.replaceAll(/\p{Cc}+/gu, ' ')]))
	const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '')
	const html = [
		...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`),
		`<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(button)}</a></p>`,
	].join('')
	return { subject: boundedSubject(fillMailTemplate(template.subject, oneLine)), text, html }
}

/** A filled subject the sender accepts: values can expand a short template past its limit, so the end gives way. */
function boundedSubject(subject: string): string {
	if (subject.length <= MAX_EMAIL_SUBJECT_LENGTH) return subject
	let bounded = ''
	for (const character of subject) {
		if (bounded.length + character.length > MAX_EMAIL_SUBJECT_LENGTH - 1) break
		bounded += character
	}
	return `${bounded}…`
}

/** One IAM e-mail: the template of its kind rendered from the closed values, to one mailbox. */
export async function renderEmail<K extends MessageKind>(services: Services, input: {
	readonly to: string
	readonly presentation: AppPresentation
	readonly kind: K
	readonly values: MessageValues[K]
	readonly idempotencyKey: string
}): Promise<EmailMessage> {
	const template = await messageTemplateFor(services, input.presentation, input.kind)
	const rendered = template(input.values)
	return { to: input.to, subject: rendered.subject, text: rendered.text, html: rendered.html, idempotencyKey: input.idempotencyKey }
}
