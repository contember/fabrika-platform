// Brevo's transactional email API (https://developers.brevo.com/reference/sendtransacemail), built from its
// documentation in November 2026 and checked only against a stubbed fetch (backlog 289). A 201 carries the message id.
// Brevo dedupes a repeated `idempotencyKey` for 30 minutes only, while a relay or an outbox retries for hours, so the
// adapter sends the key but does not report itself idempotent: an unknown outcome over Brevo waits for a person.

import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { base64Of } from './content.js'
import { EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities } from './email.js'
import { credentialVariable, type HttpEmailRequest, HttpEmailSender, type HttpEmailSenderOptions, isCredential } from './http-sender.js'
import type { ProviderResponse } from './http.js'
import { extensionOf } from './validation.js'

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email'
const brevoSuccessSchema = z.object({ messageId: z.string() })
/** A refusal's `code` is one of a documented set; its `message` is free text and is never read. */
const brevoErrorSchema = z.object({ code: z.string() })
/** Brevo bounds a sender's or a recipient's display name at 70 characters; the contract allows 128. */
const BREVO_MAX_NAME_LENGTH = 70
/**
 * Brevo bounds a transactional message at 20 MB with its attachments base64; 10 MiB of bytes leaves room for the
 * bodies. Its help center also mentions 4 MB per file, which is not enforced here (backlog 289).
 */
const BREVO_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/**
 * The extensions Brevo takes an attachment with, from its API reference. It takes no media type: it derives it from the
 * file name, so the adapter refuses any other file before the request instead of losing the message to a 400.
 */
const BREVO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(
	('xlsx xls ods docx docm doc csv pdf txt gif jpg jpeg png tif tiff rtf bmp cgm css shtml html htm zip xml ppt pptx tar ez ics mobi msg pub '
		+ 'eps odt mp3 m4a m4v wma ogg flac wav aif aifc aiff mp4 mov avi mkv mpeg mpg wmv pkpass xlsm').split(' '),
)
/**
 * A repeated idempotency key (`duplicate_parameter`), an identical request too soon (`duplicate_request`), or a request
 * the reference's error codes call already processed: each says an earlier request may have sent the message.
 */
const DUPLICATE_CODES: ReadonlySet<string> = new Set(['duplicate_parameter', 'duplicate_request', 'Request already processed'])
/** The account has no credits left (402 `not_enough_credits`; the reference also lists `Insufficient credits`). */
const NO_CREDITS_CODES: ReadonlySet<string> = new Set(['not_enough_credits', 'Insufficient credits'])
/**
 * The key or the account may not send: a failed authentication, an unknown key, a missing permission, an account still
 * validated. The reference lists `Authentication failed` and `api-key not found` beside the snake_case codes.
 */
const NOT_ALLOWED_CODES: ReadonlySet<string> = new Set([
	'unauthorized',
	'Authentication failed',
	'api-key not found',
	'permission_denied',
	'account_under_validation',
])

export interface BrevoEmailSenderOptions extends HttpEmailSenderOptions {
	/** An API key (v3) of the account. */
	readonly apiKey: string
}

export class BrevoEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		// Brevo keeps a key for 30 minutes, shorter than any retry horizon here, so a late retry could deliver twice.
		idempotent: false,
		confirmation: 'sync',
		maxBatch: 1,
		maxAttachmentBytes: BREVO_MAX_ATTACHMENT_BYTES,
		// No `listUnsubscribe`, and so no `broadcast`: Brevo takes no standard header in `headers`, so `List-Unsubscribe`
		// is not known to reach the recipient.
	}
	readonly #apiKey: string

	constructor(options: BrevoEmailSenderOptions) {
		if (!isCredential(options.apiKey)) {
			throw new EmailDeliveryError('Brevo API key is invalid', { code: 'invalid_configuration' })
		}
		if (options.from.name !== undefined && options.from.name.length > BREVO_MAX_NAME_LENGTH) {
			throw new EmailDeliveryError(`Brevo sender name is longer than ${BREVO_MAX_NAME_LENGTH} characters`, { code: 'invalid_configuration' })
		}
		super({ label: 'Brevo', provider: 'brevo' }, options)
		this.#apiKey = options.apiKey
	}

	protected async request(message: EmailMessage): Promise<HttpEmailRequest> {
		const name = message.fromName ?? this.from.name
		if (name !== undefined && name.length > BREVO_MAX_NAME_LENGTH) {
			throw new EmailDeliveryError(`Brevo sends no sender name longer than ${BREVO_MAX_NAME_LENGTH} characters`, { code: 'invalid_message' })
		}
		const attachments = message.attachments ?? []
		if (attachments.some((attachment) => !BREVO_ATTACHMENT_EXTENSIONS.has(extensionOf(attachment.filename)))) {
			throw new EmailDeliveryError('Brevo sends no attachment of this file type', { code: 'invalid_message' })
		}
		return {
			url: BREVO_SEND_URL,
			headers: { 'api-key': this.#apiKey, Accept: 'application/json' },
			body: {
				sender: { email: this.from.address, ...(name === undefined ? {} : { name }) },
				to: [{ email: message.to }],
				subject: message.subject,
				// Brevo requires an HTML body without a template; a message without one, or with a blank one, gets its text
				// as HTML, so the recipient never sees an empty message.
				htmlContent: message.html === undefined || message.html.trim() === '' ? brevoHtmlOfText(message.text) : message.html,
				textContent: message.text,
				...(message.replyTo === undefined ? {} : { replyTo: { email: message.replyTo } }),
				headers: { idempotencyKey: await brevoIdempotencyKey(message.idempotencyKey) },
				...(attachments.length === 0
					? {}
					: { attachment: attachments.map((attachment) => ({ name: attachment.filename, content: base64Of(attachment.content) })) }),
			},
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		return brevoSuccessSchema.safeParse(response.body).data?.messageId
	}

	protected override refusal(response: ProviderResponse): EmailDeliveryError | undefined {
		const status = response.status
		const code = brevoErrorSchema.safeParse(response.body).data?.code
		if (status === 402 || (code !== undefined && NO_CREDITS_CODES.has(code))) {
			return new EmailDeliveryError(`Brevo account has no credits left (${status})`, { code: 'quota_exceeded', httpStatus: status })
		}
		// A 429 or a 5xx keeps the meaning of its status whatever its code.
		if (code === undefined || status >= 500 || status === 429) return undefined
		if (DUPLICATE_CODES.has(code)) {
			// Brevo took a request under this key, or an identical one, and does not say whether its content matched.
			return new EmailDeliveryError(`Brevo already took a request under this idempotency key (${status})`, {
				code: 'idempotency_conflict',
				httpStatus: status,
			})
		}
		if (NOT_ALLOWED_CODES.has(code)) {
			return new EmailDeliveryError(`Brevo refused the key or the account (${status})`, { code: 'provider_unauthorized', httpStatus: status })
		}
		return undefined
	}
}

/**
 * The message's key as Brevo takes it, a UUID: the first 16 bytes of its SHA-256 with the version 4 and variant bits
 * set. One key is always one UUID, so a retry sends the same one; Brevo recommends a version 4 UUID.
 */
async function brevoIdempotencyKey(key: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).slice(0, 16)
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A plain text as the HTML body Brevo requires: every character escaped, each line break a `<br>`. */
export function brevoHtmlOfText(text: string): string {
	const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
	return escaped.replace(/\r\n|\r|\n/g, '<br>\n')
}

const brevoVariablesSchema = z.object({ FABRIKA_EMAIL_BREVO_API_KEY: credentialVariable })

export const brevoEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_BREVO_API_KEY', secret: true, required: true }],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(brevoVariablesSchema, env)
		return new BrevoEmailSender({ apiKey: variables.FABRIKA_EMAIL_BREVO_API_KEY, from, fetch })
	},
}
