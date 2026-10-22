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

const RESEND_EMAILS_URL = 'https://api.resend.com/emails'
const LABEL = 'Resend'
const BROADCAST_TAG = { name: 'category', value: 'broadcast' }
const resendSuccessSchema = z.object({ id: z.string() })
const resendErrorSchema = z.object({ name: z.string() })
const QUOTA_ERRORS: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded'])
/** Resend refuses a message over 40 MB once its attachments are base64; 25 MiB of bytes leaves room for the rest. */
const RESEND_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface ResendEmailSenderOptions extends HttpEmailSenderOptions {
	readonly apiKey: string
}

export class ResendEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: true,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: RESEND_MAX_ATTACHMENT_BYTES,
		// Resend takes one-to-one marketing mail through this API, with consent and an unsubscribe; it has no channel apart.
		broadcast: true,
	}
	readonly #apiKey: string

	constructor(options: ResendEmailSenderOptions) {
		if (!isCredential(options.apiKey)) {
			throw new EmailDeliveryError('Resend API key is invalid', { code: 'invalid_configuration' })
		}
		super({ label: LABEL, provider: 'resend' }, options)
		this.#apiKey = options.apiKey
	}

	protected request(message: EmailMessage): HttpEmailRequest {
		const attachments = message.attachments ?? []
		return {
			url: RESEND_EMAILS_URL,
			headers: { Authorization: `Bearer ${this.#apiKey}`, 'Idempotency-Key': message.idempotencyKey },
			body: {
				from: formatMailbox(this.from.address, message.fromName ?? this.from.name),
				to: message.to,
				subject: message.subject,
				text: message.text,
				...(message.html === undefined ? {} : { html: message.html }),
				...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
				...(message.unsubscribeUrl === undefined ? {} : { headers: oneClickUnsubscribeHeaders(message.unsubscribeUrl) }),
				// Tagged, so the account's logs and webhooks tell broadcast mail from transactional.
				...(message.broadcast === true ? { tags: [BROADCAST_TAG] } : {}),
				...(attachments.length === 0
					? {}
					: {
						attachments: attachments.map((attachment) => ({
							filename: attachment.filename,
							content: base64Of(attachment.content),
							content_type: attachment.contentType,
						})),
					}),
			},
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		return resendSuccessSchema.safeParse(response.body).data?.id
	}

	protected override refusal(response: ProviderResponse): EmailDeliveryError | undefined {
		const status = response.status
		const name = resendErrorSchema.safeParse(response.body).data?.name
		if (status === 401 || status === 403) {
			// A 403 is also an unverified sender domain.
			return new EmailDeliveryError(`Resend refused the credentials or the sender (${status})`, { code: 'provider_unauthorized', httpStatus: status })
		}
		if (status === 409 && name === 'concurrent_idempotent_requests') {
			return new EmailDeliveryError('A matching Resend request is still in progress', { code: 'request_in_progress', httpStatus: status })
		}
		if (status === 409 && name === 'invalid_idempotent_request') {
			return new EmailDeliveryError('Resend already accepted a different message under this idempotency key', {
				code: 'idempotency_conflict',
				httpStatus: status,
			})
		}
		if (status === 429 && name !== undefined && QUOTA_ERRORS.has(name)) {
			return new EmailDeliveryError('Resend sending quota exceeded', { code: 'quota_exceeded', httpStatus: status })
		}
		return undefined
	}
}

const resendVariablesSchema = z.object({ FABRIKA_EMAIL_RESEND_API_KEY: credentialVariable })

export const resendEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_RESEND_API_KEY', secret: true, required: true }],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(resendVariablesSchema, env)
		return new ResendEmailSender({ apiKey: variables.FABRIKA_EMAIL_RESEND_API_KEY, from, fetch })
	},
}
