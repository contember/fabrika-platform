// AhaSend's API v2 (https://ahasend.com/docs/api-reference/messages/create-message), built from its documentation and
// verified only against a stubbed fetch. It keeps an idempotency key for 24 hours, and a 202 carries one result per
// recipient, which can itself be a refusal.

import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { base64Of } from './content.js'
import { EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities, oneClickUnsubscribeHeaders } from './email.js'
import {
	credentialVariable,
	type HttpEmailRequest,
	HttpEmailSender,
	type HttpEmailSenderOptions,
	isCredential,
	providerIdempotencyKey,
} from './http-sender.js'
import type { ProviderResponse } from './http.js'

const AHASEND_API_URL = 'https://api.ahasend.com/v2/accounts'
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_IDEMPOTENCY_KEY_LENGTH = 255
const ahaSendResultSchema = z.object({
	// `queued` and `scheduled` are documented; any status but `error` with an id is taken, so a new one is no failure.
	data: z.tuple([z.object({ status: z.string(), id: z.string().nullable() })]),
})
/**
 * AhaSend refuses a message over 20 MiB with its attachments base64 and MIME-wrapped; 12 MiB of bytes leaves room for
 * the bodies, and its body stays under the 30 MB request bound.
 */
const AHASEND_MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
/** The openers of a MiniJinja expression, statement and comment. */
const TEMPLATE_OPENER = /\{(?=[{%#])/g

export interface AhaSendEmailSenderOptions extends HttpEmailSenderOptions {
	/** An API key v2, scoped to `messages:send:{domain}` at least. */
	readonly apiKey: string
	/** The account the key belongs to: the path of every request. */
	readonly accountId: string
}

/** A refusal's body is one free-text `message`, so only the status is read. */
export class AhaSendEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: true,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: AHASEND_MAX_ATTACHMENT_BYTES,
	}
	readonly #apiKey: string
	readonly #messagesUrl: string

	constructor(options: AhaSendEmailSenderOptions) {
		super({ label: 'AhaSend', provider: 'ahasend' }, options)
		if (!isCredential(options.apiKey)) {
			throw new EmailDeliveryError('AhaSend API key is invalid', { code: 'invalid_configuration' })
		}
		if (!ACCOUNT_ID_PATTERN.test(options.accountId)) {
			throw new EmailDeliveryError('AhaSend account ID is invalid', { code: 'invalid_configuration' })
		}
		this.#apiKey = options.apiKey
		this.#messagesUrl = `${AHASEND_API_URL}/${options.accountId}/messages`
	}

	protected async request(message: EmailMessage): Promise<HttpEmailRequest> {
		const senderName = message.fromName ?? this.from.name
		const attachments = message.attachments ?? []
		return {
			url: this.#messagesUrl,
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				'Idempotency-Key': await providerIdempotencyKey(message.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH),
			},
			body: {
				from: { email: this.from.address, ...(senderName === undefined ? {} : { name: senderName }) },
				recipients: [{ email: message.to }],
				subject: literalTemplate(message.subject),
				text_content: literalTemplate(message.text),
				...(message.html === undefined ? {} : { html_content: literalTemplate(message.html) }),
				...(message.replyTo === undefined ? {} : { reply_to: { email: message.replyTo } }),
				...(message.unsubscribeUrl === undefined ? {} : { headers: oneClickUnsubscribeHeaders(message.unsubscribeUrl) }),
				...(attachments.length === 0
					? {}
					: {
						attachments: attachments.map((attachment) => ({
							base64: true,
							data: base64Of(attachment.content),
							content_type: attachment.contentType,
							file_name: attachment.filename,
						})),
					}),
			},
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		const result = ahaSendResultSchema.safeParse(response.body).data?.data[0]
		if (result === undefined) return undefined
		// The item's `error` is free text about the recipient, so it stays out of the refusal.
		if (result.status === 'error') {
			throw new EmailDeliveryError(`AhaSend refused the recipient (${response.status})`, { code: 'provider_rejected', httpStatus: response.status })
		}
		return result.id ?? undefined
	}

	protected override refusal(response: ProviderResponse): EmailDeliveryError | undefined {
		const status = response.status
		if (status === 404) {
			return new EmailDeliveryError('AhaSend knows no such account (404)', { code: 'provider_unauthorized', httpStatus: status })
		}
		if (status === 409) {
			return new EmailDeliveryError('A matching AhaSend request is still in progress', { code: 'request_in_progress', httpStatus: status })
		}
		// A malformed body is a 400; a 422 is only the key reused for another request.
		if (status === 422) {
			return new EmailDeliveryError('AhaSend refused the idempotency key for this request (422)', {
				code: 'idempotency_conflict',
				httpStatus: status,
			})
		}
		return undefined
	}
}

/**
 * AhaSend renders a message's subject and bodies as MiniJinja templates, so `{{`, `{%` or `{#` in the content would be
 * evaluated, or refused when it does not render. Each such `{` is written as an expression that outputs it.
 */
export function literalTemplate(value: string): string {
	return value.replace(TEMPLATE_OPENER, "{{ '{' }}")
}

const ahaSendVariablesSchema = z.object({
	FABRIKA_EMAIL_AHASEND_API_KEY: credentialVariable,
	FABRIKA_EMAIL_AHASEND_ACCOUNT_ID: z.string().regex(ACCOUNT_ID_PATTERN),
})

export const ahaSendEmailProvider: EmailProvider = {
	variables: [
		{ name: 'FABRIKA_EMAIL_AHASEND_API_KEY', secret: true, required: true },
		{ name: 'FABRIKA_EMAIL_AHASEND_ACCOUNT_ID', secret: false, required: true },
	],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(ahaSendVariablesSchema, env)
		return new AhaSendEmailSender({
			apiKey: variables.FABRIKA_EMAIL_AHASEND_API_KEY,
			accountId: variables.FABRIKA_EMAIL_AHASEND_ACCOUNT_ID,
			from,
			fetch,
		})
	},
}
