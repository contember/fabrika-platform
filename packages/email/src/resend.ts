import { z } from 'zod'
import { type EmailProvider, type EmailSenderIdentity, parseProviderVariables } from './config.js'
import { base64Of } from './content.js'
import {
	EmailDeliveryError,
	type EmailDeliveryResult,
	type EmailFetch,
	type EmailMessage,
	type EmailSender,
	type EmailSenderCapabilities,
	oneClickUnsubscribeHeaders,
} from './email.js'
import { parseTimeout, postToProvider, type ProviderResponse } from './http.js'
import { isValidEmailSenderIdentity, isVisibleAscii, validateEmailAttachments, validateEmailMessage } from './validation.js'

const RESEND_EMAILS_URL = 'https://api.resend.com/emails'
const LABEL = 'Resend'
const resendSuccessSchema = z.object({ id: z.string().min(1) })
const resendErrorSchema = z.object({ name: z.string() })
const QUOTA_ERRORS: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded'])
/** RFC 5322 specials a display name may still hold after validation; any of them makes the name a quoted string. */
const DISPLAY_NAME_SPECIALS = /[()[\]:;@,.]/
/** Resend refuses a message over 40 MB once its attachments are base64; 25 MiB of bytes leaves room for the rest. */
const RESEND_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface ResendEmailSenderOptions {
	readonly apiKey: string
	readonly from: EmailSenderIdentity
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

export class ResendEmailSender implements EmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: true,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: RESEND_MAX_ATTACHMENT_BYTES,
	}
	readonly #apiKey: string
	readonly #from: EmailSenderIdentity
	readonly #fetch: EmailFetch
	readonly #timeoutMs: number

	constructor(options: ResendEmailSenderOptions) {
		if (!validApiKey(options.apiKey)) {
			throw new EmailDeliveryError('Resend API key is invalid', { code: 'invalid_configuration' })
		}
		if (!isValidEmailSenderIdentity(options.from)) {
			throw new EmailDeliveryError('Resend sender is invalid', { code: 'invalid_configuration' })
		}

		this.#apiKey = options.apiKey
		this.#from = options.from
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.#timeoutMs = parseTimeout(LABEL, options.timeoutMs)
	}

	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		validateEmailAttachments(message, this.capabilities, LABEL)
		const attachments = message.attachments ?? []

		const response = await postToProvider({
			label: LABEL,
			fetch: this.#fetch,
			url: RESEND_EMAILS_URL,
			headers: { Authorization: `Bearer ${this.#apiKey}`, 'Idempotency-Key': message.idempotencyKey },
			body: {
				from: formatMailbox(this.#from.address, message.fromName ?? this.#from.name),
				to: message.to,
				subject: message.subject,
				text: message.text,
				...(message.html === undefined ? {} : { html: message.html }),
				...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
				...(message.unsubscribeUrl === undefined ? {} : { headers: oneClickUnsubscribeHeaders(message.unsubscribeUrl) }),
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
			signal,
			timeoutMs: this.#timeoutMs,
		})

		if (!response.ok) throw responseError(response)

		const parsed = resendSuccessSchema.safeParse(response.body)
		if (!parsed.success) {
			throw new EmailDeliveryError('Resend returned an invalid success response', { code: 'malformed_response', httpStatus: response.status })
		}

		return { status: 'accepted', provider: 'resend', messageId: parsed.data.id }
	}
}

const resendVariablesSchema = z.object({ FABRIKA_EMAIL_RESEND_API_KEY: z.string().refine(validApiKey) })

export const resendEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_RESEND_API_KEY', secret: true, required: true }],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(resendVariablesSchema, env)
		return new ResendEmailSender({ apiKey: variables.FABRIKA_EMAIL_RESEND_API_KEY, from, fetch })
	},
}

function responseError(response: ProviderResponse): EmailDeliveryError {
	const status = response.status
	const parsed = resendErrorSchema.safeParse(response.body)
	const name = parsed.success ? parsed.data.name : undefined
	if (status === 401 || status === 403) {
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
	if (status === 429) {
		return new EmailDeliveryError('Resend rate limit exceeded', { code: 'rate_limited', httpStatus: status })
	}
	if (status >= 500) {
		return new EmailDeliveryError('Resend is unavailable', { code: 'provider_unavailable', httpStatus: status })
	}
	return new EmailDeliveryError(`Resend rejected the request (${status})`, { code: 'provider_rejected', httpStatus: status })
}

function formatMailbox(address: string, name: string | undefined): string {
	if (name === undefined) return address
	return DISPLAY_NAME_SPECIALS.test(name) ? `"${name}" <${address}>` : `${name} <${address}>`
}

function validApiKey(value: string): boolean {
	return value.length > 0 && isVisibleAscii(value)
}
