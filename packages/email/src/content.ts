import type { EmailMessage } from './email.js'

/** What a local sender compares when one idempotency key arrives twice: everything the recipient would see. */
export interface EmailContent {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly replyTo?: string
	readonly fromName?: string
	readonly unsubscribeUrl?: string
}

export function sameEmailContent(left: EmailContent, right: EmailContent): boolean {
	return left.to === right.to && left.subject === right.subject && left.text === right.text && left.html === right.html
		&& left.replyTo === right.replyTo && left.fromName === right.fromName && left.unsubscribeUrl === right.unsubscribeUrl
}

export function emailContentOf(message: EmailMessage): EmailContent {
	return {
		to: message.to,
		subject: message.subject,
		text: message.text,
		...(message.html === undefined ? {} : { html: message.html }),
		...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		...(message.fromName === undefined ? {} : { fromName: message.fromName }),
		...(message.unsubscribeUrl === undefined ? {} : { unsubscribeUrl: message.unsubscribeUrl }),
	}
}
