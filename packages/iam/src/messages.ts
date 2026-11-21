import { iamMessageTemplate, type MailTemplate, type MessageKind, type MessageValues, type RenderedMessage } from '@fabrika/auth-core'
import { type EmailMessage, MAX_EMAIL_SUBJECT_LENGTH } from '@fabrika/email'
import { type AppPresentation, landingUrl } from './app-presentation'
import type { Services } from './services'

/** How long one send may take. IAM has no request-scoped signal that outlives `waitUntil`, so each send carries its own. */
export const EMAIL_SEND_DEADLINE_MS = 30_000

/**
 * The template IAM renders a presentation's `kind` e-mail with: the application's own wording in the presentation's
 * language when it declares one, else the catalog's (`iamMessageTemplate`, which `fabrika app dev`'s stand-in IAM
 * renders with too).
 */
export async function messageTemplateFor<K extends MessageKind>(
	services: Services,
	presentation: AppPresentation,
	kind: K,
): Promise<(values: MessageValues[K]) => RenderedMessage> {
	const app = presentation.app
	const row = app === null ? null : await services.repositories.appSchema.getMailTemplate(app, kind, presentation.locale)
	const template: MailTemplate | null = row === null
		? null
		: { subject: row.subject, text: row.body, ...(row.html === null ? {} : { html: row.html }) }
	return iamMessageTemplate(kind, {
		locale: presentation.locale,
		template,
		displayName: presentation.displayName ?? app ?? '',
		appUrl: landingUrl(presentation),
		maxSubjectLength: MAX_EMAIL_SUBJECT_LENGTH,
	})
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
