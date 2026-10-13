import type { EmailMessage } from '@fabrika/email'
import type { AppPresentation } from './app-presentation'
import { catalogFor, type MessageKind, type MessageTemplates, type MessageValues } from './catalog'

/** The templates IAM renders a presentation's e-mails with: its catalog's, in the presentation's language. */
export function messageTemplatesFor(presentation: AppPresentation): MessageTemplates {
	return catalogFor(presentation.locale).messages
}

/** One IAM e-mail: the template of its kind rendered from the closed values, to one mailbox. */
export function renderEmail<K extends MessageKind>(input: {
	readonly to: string
	readonly presentation: AppPresentation
	readonly kind: K
	readonly values: MessageValues[K]
	readonly idempotencyKey: string
}): EmailMessage {
	const template: MessageTemplates[K] = messageTemplatesFor(input.presentation)[input.kind]
	const rendered = template(input.values)
	return { to: input.to, subject: rendered.subject, text: rendered.text, html: rendered.html, idempotencyKey: input.idempotencyKey }
}
