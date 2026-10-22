// Postmark's Email API (https://postmarkapp.com/developer/api/email-api), built from its documentation and verified on a
// live server in October 2026. It has no idempotency key; a 200 means Postmark took the message.

import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { base64Of } from './content.js'
import { EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities, oneClickUnsubscribeHeaders } from './email.js'
import {
	credentialVariable,
	formatMailbox,
	type HttpEmailRequest,
	HttpEmailSender,
	type HttpEmailSenderOptions,
	isCredential,
} from './http-sender.js'
import type { ProviderResponse } from './http.js'

const POSTMARK_EMAIL_URL = 'https://api.postmarkapp.com/email'
const postmarkSuccessSchema = z.object({ MessageID: z.string(), ErrorCode: z.literal(0) })
/** A refusal's `ErrorCode` is a documented number; its `Message` is free text and is never read. */
const postmarkErrorSchema = z.object({ ErrorCode: z.number() })
/** Out of credits: sending resumes once the account has them again. */
const OUT_OF_CREDITS = 405
/** The sender signature is missing (400) or unconfirmed (401), or the account is pending approval (412, 413). */
const SENDER_NOT_ALLOWED: ReadonlySet<number> = new Set([400, 401, 412, 413])
/** Postmark counts the decoded bytes of every attachment together and takes fewer than 10 MiB; the bodies are apart. */
const POSTMARK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 - 1
/** The extensions Postmark refuses an attachment for (ErrorCode 411), from its documentation. */
const FORBIDDEN_EXTENSIONS: readonly string[] =
	'vbs exe bin bat chm com cpl crt hlp hta inf ins isp jse lnk mdb pcd pif reg scr sct shs vbe vba wsf wsh wsl msc msi msp mst'.split(' ')

export interface PostmarkEmailSenderOptions extends HttpEmailSenderOptions {
	/** A server token: it sends through that server's default transactional stream. */
	readonly serverToken: string
}

export class PostmarkEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: false,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: POSTMARK_MAX_ATTACHMENT_BYTES,
		refusedAttachmentExtensions: FORBIDDEN_EXTENSIONS,
	}
	readonly #serverToken: string

	constructor(options: PostmarkEmailSenderOptions) {
		if (!isCredential(options.serverToken)) {
			throw new EmailDeliveryError('Postmark server token is invalid', { code: 'invalid_configuration' })
		}
		super({ label: 'Postmark', provider: 'postmark' }, options)
		this.#serverToken = options.serverToken
	}

	protected request(message: EmailMessage): HttpEmailRequest {
		const attachments = message.attachments ?? []
		return {
			url: POSTMARK_EMAIL_URL,
			headers: { 'X-Postmark-Server-Token': this.#serverToken, Accept: 'application/json' },
			body: {
				From: formatMailbox(this.from.address, message.fromName ?? this.from.name),
				To: message.to,
				Subject: message.subject,
				TextBody: message.text,
				...(message.html === undefined ? {} : { HtmlBody: message.html }),
				...(message.replyTo === undefined ? {} : { ReplyTo: message.replyTo }),
				...(message.unsubscribeUrl === undefined
					? {}
					: { Headers: Object.entries(oneClickUnsubscribeHeaders(message.unsubscribeUrl)).map(([Name, Value]) => ({ Name, Value })) }),
				...(attachments.length === 0
					? {}
					: {
						Attachments: attachments.map((attachment) => ({
							Name: attachment.filename,
							Content: base64Of(attachment.content),
							ContentType: attachment.contentType,
						})),
					}),
			},
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		return postmarkSuccessSchema.safeParse(response.body).data?.MessageID
	}

	protected override refusal(response: ProviderResponse): EmailDeliveryError | undefined {
		const status = response.status
		const code = postmarkErrorSchema.safeParse(response.body).data?.ErrorCode
		if (status !== 422 || code === undefined) return undefined
		if (code === OUT_OF_CREDITS) {
			return new EmailDeliveryError('Postmark account is out of credits', { code: 'quota_exceeded', httpStatus: status })
		}
		if (SENDER_NOT_ALLOWED.has(code)) {
			return new EmailDeliveryError(`Postmark refused the sender or the account (${code})`, { code: 'provider_unauthorized', httpStatus: status })
		}
		return undefined
	}
}

const postmarkVariablesSchema = z.object({ FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: credentialVariable })

export const postmarkEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN', secret: true, required: true }],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(postmarkVariablesSchema, env)
		return new PostmarkEmailSender({ serverToken: variables.FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN, from, fetch })
	},
}
