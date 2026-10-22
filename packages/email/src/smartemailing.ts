// SmartEmailing's transactional API v3 (https://app.smartemailing.cz/docs/api/v3/), built from its OpenAPI document and
// verified only against a stubbed fetch. It has no idempotency key, and a 201 only queues the request.

import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities } from './email.js'
import {
	credentialVariable,
	type HttpEmailRequest,
	HttpEmailSender,
	type HttpEmailSenderOptions,
	isCredential,
	optionalVariable,
} from './http-sender.js'
import type { ProviderResponse } from './http.js'

const SMARTEMAILING_SEND_URL = 'https://app.smartemailing.cz/api/v3/send/transactional-emails-bulk'
const DEFAULT_TAG = 'fabrika'
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const smartEmailingSuccessSchema = z.object({ data: z.tuple([z.object({ id: z.string() })]) })

export interface SmartEmailingEmailSenderOptions extends HttpEmailSenderOptions {
	/** The account's user name or e-mail: the first half of the Basic credential. */
	readonly username: string
	readonly apiKey: string
	/** Groups the messages in SmartEmailing's statistics. */
	readonly tag?: string
}

/** Its error body's `message` is free text that may quote the request, so a refusal is classified by status alone. */
export class SmartEmailingEmailSender extends HttpEmailSender {
	/**
	 * The API takes up to five tasks a request, but `send` carries one. Its API documents no message headers, so a
	 * one-click unsubscribe is refused rather than sent without one.
	 */
	readonly capabilities: EmailSenderCapabilities = { idempotent: false, confirmation: 'queued', maxBatch: 1 }
	readonly #authorization: string
	readonly #tag: string

	constructor(options: SmartEmailingEmailSenderOptions) {
		if (!validUsername(options.username)) {
			throw new EmailDeliveryError('SmartEmailing username is invalid', { code: 'invalid_configuration' })
		}
		if (!isCredential(options.apiKey)) {
			throw new EmailDeliveryError('SmartEmailing API key is invalid', { code: 'invalid_configuration' })
		}
		super({ label: 'SmartEmailing', provider: 'smartemailing' }, options)
		const tag = options.tag ?? DEFAULT_TAG
		if (!TAG_PATTERN.test(tag)) {
			throw new EmailDeliveryError('SmartEmailing tag is invalid', { code: 'invalid_configuration' })
		}

		this.#authorization = `Basic ${btoa(`${options.username}:${options.apiKey}`)}`
		this.#tag = tag
	}

	protected request(message: EmailMessage): HttpEmailRequest {
		const senderName = message.fromName ?? this.from.name
		return {
			url: SMARTEMAILING_SEND_URL,
			headers: { Authorization: this.#authorization },
			body: {
				sender_credentials: {
					from: this.from.address,
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
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		return smartEmailingSuccessSchema.safeParse(response.body).data?.data[0].id
	}
}

const smartEmailingVariablesSchema = z.object({
	FABRIKA_EMAIL_SMARTEMAILING_USERNAME: z.string().refine(validUsername),
	FABRIKA_EMAIL_SMARTEMAILING_API_KEY: credentialVariable,
	FABRIKA_EMAIL_SMARTEMAILING_TAG: optionalVariable((value) => TAG_PATTERN.test(value)),
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

function validUsername(value: string): boolean {
	return isCredential(value) && !value.includes(':')
}
