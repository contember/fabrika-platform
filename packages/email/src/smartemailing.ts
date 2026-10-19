// SmartEmailing's transactional API v3 (https://app.smartemailing.cz/docs/api/v3/), built from its OpenAPI document and
// verified only against a stubbed fetch. It has no idempotency key, and a 201 only queues the request.

import { z } from 'zod'
import { type EmailProvider, type EmailSenderIdentity, parseProviderVariables } from './config.js'
import {
	EmailDeliveryError,
	type EmailDeliveryResult,
	type EmailFetch,
	type EmailMessage,
	type EmailSender,
	type EmailSenderCapabilities,
} from './email.js'
import { parseTimeout, postToProvider } from './http.js'
import { isValidEmailSenderIdentity, isVisibleAscii, validateEmailAttachments, validateEmailMessage } from './validation.js'

const SMARTEMAILING_SEND_URL = 'https://app.smartemailing.cz/api/v3/send/transactional-emails-bulk'
const LABEL = 'SmartEmailing'
const DEFAULT_TAG = 'fabrika'
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const smartEmailingSuccessSchema = z.object({ data: z.tuple([z.object({ id: z.string().min(1) })]) })

export interface SmartEmailingEmailSenderOptions {
	/** The account's user name or e-mail: the first half of the Basic credential. */
	readonly username: string
	readonly apiKey: string
	readonly from: EmailSenderIdentity
	/** Groups the messages in SmartEmailing's statistics. */
	readonly tag?: string
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

export class SmartEmailingEmailSender implements EmailSender {
	/** The API takes up to five tasks a request, but `send` carries one. */
	readonly capabilities: EmailSenderCapabilities = { idempotent: false, confirmation: 'queued', maxBatch: 1 }
	readonly #authorization: string
	readonly #from: EmailSenderIdentity
	readonly #tag: string
	readonly #fetch: EmailFetch
	readonly #timeoutMs: number

	constructor(options: SmartEmailingEmailSenderOptions) {
		if (!validUsername(options.username)) {
			throw new EmailDeliveryError('SmartEmailing username is invalid', { code: 'invalid_configuration' })
		}
		if (!validApiKey(options.apiKey)) {
			throw new EmailDeliveryError('SmartEmailing API key is invalid', { code: 'invalid_configuration' })
		}
		if (!isValidEmailSenderIdentity(options.from)) {
			throw new EmailDeliveryError('SmartEmailing sender is invalid', { code: 'invalid_configuration' })
		}
		const tag = options.tag ?? DEFAULT_TAG
		if (!TAG_PATTERN.test(tag)) {
			throw new EmailDeliveryError('SmartEmailing tag is invalid', { code: 'invalid_configuration' })
		}

		this.#authorization = `Basic ${btoa(`${options.username}:${options.apiKey}`)}`
		this.#from = options.from
		this.#tag = tag
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.#timeoutMs = parseTimeout(LABEL, options.timeoutMs)
	}

	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		// Its API documents no message headers, so a one-click unsubscribe is refused rather than sent without one.
		if (message.unsubscribeUrl !== undefined) {
			throw new EmailDeliveryError('SmartEmailing cannot write the List-Unsubscribe headers', { code: 'invalid_message' })
		}
		validateEmailAttachments(message, this.capabilities, LABEL)

		const senderName = message.fromName ?? this.#from.name
		const response = await postToProvider({
			label: LABEL,
			fetch: this.#fetch,
			url: SMARTEMAILING_SEND_URL,
			headers: { Authorization: this.#authorization },
			body: {
				sender_credentials: {
					from: this.#from.address,
					...(senderName === undefined ? {} : { sender_name: senderName }),
					...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
				},
				tag: this.#tag,
				// Unverified: the API documents no rule for a message without `html_body`.
				message_contents: {
					subject: message.subject,
					text_body: message.text,
					...(message.html === undefined ? {} : { html_body: message.html }),
				},
				tasks: [{ recipient: { emailaddress: message.to } }],
			},
			signal,
			timeoutMs: this.#timeoutMs,
		})

		// The error body's `message` is free text that may quote the request, so only the status is classified.
		if (!response.ok) throw responseError(response.status)

		const parsed = smartEmailingSuccessSchema.safeParse(response.body)
		if (!parsed.success) {
			throw new EmailDeliveryError('SmartEmailing returned an invalid success response', { code: 'malformed_response', httpStatus: response.status })
		}

		return { status: 'accepted', provider: 'smartemailing', messageId: parsed.data.data[0].id }
	}
}

const smartEmailingVariablesSchema = z.object({
	FABRIKA_EMAIL_SMARTEMAILING_USERNAME: z.string().refine(validUsername),
	FABRIKA_EMAIL_SMARTEMAILING_API_KEY: z.string().refine(validApiKey),
	FABRIKA_EMAIL_SMARTEMAILING_TAG: z.string().optional().transform((value) => (value === '' ? undefined : value)).refine((value) =>
		value === undefined || TAG_PATTERN.test(value)
	),
})

export const smartEmailingEmailProvider: EmailProvider = {
	variables: [
		{ name: 'FABRIKA_EMAIL_SMARTEMAILING_USERNAME', secret: true, required: true },
		{ name: 'FABRIKA_EMAIL_SMARTEMAILING_API_KEY', secret: true, required: true },
		{ name: 'FABRIKA_EMAIL_SMARTEMAILING_TAG', secret: false, required: false },
	],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(smartEmailingVariablesSchema, env)
		return new SmartEmailingEmailSender({
			username: variables.FABRIKA_EMAIL_SMARTEMAILING_USERNAME,
			apiKey: variables.FABRIKA_EMAIL_SMARTEMAILING_API_KEY,
			from,
			tag: variables.FABRIKA_EMAIL_SMARTEMAILING_TAG,
			fetch,
		})
	},
}

function responseError(status: number): EmailDeliveryError {
	if (status === 401 || status === 403) {
		return new EmailDeliveryError(`SmartEmailing refused the credentials (${status})`, { code: 'provider_unauthorized', httpStatus: status })
	}
	if (status === 429) {
		return new EmailDeliveryError('SmartEmailing rate limit exceeded', { code: 'rate_limited', httpStatus: status })
	}
	if (status >= 500) {
		return new EmailDeliveryError('SmartEmailing is unavailable', { code: 'provider_unavailable', httpStatus: status })
	}
	return new EmailDeliveryError(`SmartEmailing rejected the request (${status})`, { code: 'provider_rejected', httpStatus: status })
}

function validUsername(value: string): boolean {
	return validApiKey(value) && !value.includes(':')
}

function validApiKey(value: string): boolean {
	return value.length > 0 && isVisibleAscii(value)
}
