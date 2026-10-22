// Postmark's Email API (https://postmarkapp.com/developer/api/email-api), built from its documentation and verified only
// against a stubbed fetch. It has no idempotency key; a 200 means Postmark took the message.

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
/** Postmark refuses a message over 10 MB once its attachments are base64; 6 MiB of bytes leaves room for the bodies. */
const POSTMARK_MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024

export interface PostmarkEmailSenderOptions extends HttpEmailSenderOptions {
	/** A server token: it sends through that server's default transactional stream. */
	readonly serverToken: string
}

/** Postmark puts an `ErrorCode` and free text in a refusal; the text may quote the request, so only the status is read. */
export class PostmarkEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: false,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: POSTMARK_MAX_ATTACHMENT_BYTES,
	}
	readonly #serverToken: string

	constructor(options: PostmarkEmailSenderOptions) {
		super({ label: 'Postmark', provider: 'postmark' }, options)
		if (!isCredential(options.serverToken)) {
			throw new EmailDeliveryError('Postmark server token is invalid', { code: 'invalid_configuration' })
		}
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
}

const postmarkVariablesSchema = z.object({ FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: credentialVariable })

export const postmarkEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN', secret: true, required: true }],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(postmarkVariablesSchema, env)
		return new PostmarkEmailSender({ serverToken: variables.FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN, from, fetch })
	},
}
