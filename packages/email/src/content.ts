import type { EmailMessage } from './email.js'

/** An attachment as a local sender keeps and compares it: the bytes as base64. */
export interface EmailAttachmentContent {
	readonly filename: string
	readonly contentType: string
	readonly content: string
}

/** What a local sender compares when one idempotency key arrives twice: everything the recipient would see. */
export interface EmailContent {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly replyTo?: string
	readonly fromName?: string
	readonly unsubscribeUrl?: string
	readonly attachments?: readonly EmailAttachmentContent[]
}

export function sameEmailContent(left: EmailContent, right: EmailContent): boolean {
	return left.to === right.to && left.subject === right.subject && left.text === right.text && left.html === right.html
		&& left.replyTo === right.replyTo && left.fromName === right.fromName && left.unsubscribeUrl === right.unsubscribeUrl
		&& sameAttachments(left.attachments ?? [], right.attachments ?? [])
}

export function emailContentOf(message: EmailMessage): EmailContent {
	const attachments = message.attachments ?? []
	return {
		to: message.to,
		subject: message.subject,
		text: message.text,
		...(message.html === undefined ? {} : { html: message.html }),
		...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		...(message.fromName === undefined ? {} : { fromName: message.fromName }),
		...(message.unsubscribeUrl === undefined ? {} : { unsubscribeUrl: message.unsubscribeUrl }),
		...(attachments.length === 0
			? {}
			: {
				attachments: attachments.map((attachment) => ({
					filename: attachment.filename,
					contentType: attachment.contentType,
					content: base64Of(attachment.content),
				})),
			}),
	}
}

const BASE64_CHUNK = 0x8000

/** `bytes` as standard base64, on every runtime: `btoa` over chunks, so a large file never overflows the call stack. */
export function base64Of(bytes: Uint8Array): string {
	let binary = ''
	for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
	}
	return btoa(binary)
}

function sameAttachments(left: readonly EmailAttachmentContent[], right: readonly EmailAttachmentContent[]): boolean {
	return left.length === right.length
		&& left.every((attachment, index) => {
			const other = right[index]
			return other !== undefined && attachment.filename === other.filename && attachment.contentType === other.contentType
				&& attachment.content === other.content
		})
}
