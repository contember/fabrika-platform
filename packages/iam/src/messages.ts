import { fillMailTemplate, type MailPlaceholder, type MailTemplate, mailTemplateProblems, type MessageKind } from '@fabrika/auth-core'
import { type EmailMessage, MAX_EMAIL_SUBJECT_LENGTH } from '@fabrika/email'
import type { AppPresentation } from './app-presentation'
import { catalogFor, type MessageValues, type RenderedMessage } from './catalog'
import { escapeHtml } from './html'
import type { Services } from './services'

type Placeholders<K extends MessageKind> = { readonly [P in MailPlaceholder<K>]: string }

/** The values an application's template of each message names, beside those every message names. */
const PLACEHOLDER_VALUES: {
	readonly [K in MessageKind]: (values: MessageValues[K]) => Omit<Placeholders<K>, 'displayName' | 'expiry'>
} = {
	invitation: ({ recipient, inviterLabel, companyLabel, message, actionUrl }) => ({ recipient, inviterLabel, companyLabel, message, actionUrl }),
	enrollment: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
	reset: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
}

/**
 * The template IAM renders a presentation's `kind` e-mail with: the application's own wording in the presentation's
 * language when it declares one, else the catalog's. A stored template the rule no longer admits is the catalog's.
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
	const template: MailTemplate = { subject: row.subject, text: row.body }
	if (mailTemplateProblems(kind, template).length > 0) {
		return catalog.messages[kind]
	}
	return (values) => {
		const placeholders: Readonly<Record<string, string>> = {
			...PLACEHOLDER_VALUES[kind](values),
			displayName: presentation.displayName ?? app,
			expiry: catalog.applicationMail.expiry(values.expiresAt),
		}
		return applicationMessage(template, placeholders, values.actionUrl, catalog.applicationMail.button[kind])
	}
}

/**
 * An application's wording filled in: the text as written, the subject on one line, and IAM's own HTML part — the
 * escaped text as paragraphs and IAM's button to the action URL. The application authors no HTML.
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
