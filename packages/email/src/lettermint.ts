// Lettermint's Sending API (https://lettermint.co/docs/api-reference/sending), built from its OpenAPI document and
// verified on a live project in October 2026. It keeps an idempotency key for 24 hours, and a 202 means it took the
// message.

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
	isChannelName,
	isCredential,
	optionalVariable,
	providerIdempotencyKey,
} from './http-sender.js'
import type { ProviderResponse } from './http.js'

const LETTERMINT_SEND_URL = 'https://api.lettermint.co/v1/send'
/** The slug Lettermint gives a new project's broadcast route. */
const DEFAULT_BROADCAST_ROUTE = 'broadcast'
const MAX_IDEMPOTENCY_KEY_LENGTH = 255
/** `pending` and `scheduled` are documented; the id is what counts, so a new status is no failure. */
const lettermintSuccessSchema = z.object({ message_id: z.string() })
/** Lettermint refuses a text or HTML body shorter than this with a 422, counting characters once trimmed. */
const LETTERMINT_MIN_BODY_LENGTH = 3
/** A 409 carries only a `message`; the one for a key reused with another body says so in these words. */
const lettermintErrorSchema = z.object({ message: z.string() })
const OTHER_PAYLOAD = /payload/i
/** A structured refusal, whose message names a route the project lacks; read only to say so, never put into the error. */
const lettermintApiErrorSchema = z.object({ error: z.object({ message: z.string() }) })
const UNKNOWN_ROUTE = /route/i
/** Lettermint refuses a request over 25 MB with its attachments base64; 15 MiB of bytes leaves room for the bodies. */
const LETTERMINT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

export interface LettermintEmailSenderOptions extends HttpEmailSenderOptions {
	/** A project API token: it sends through that project's default route. */
	readonly projectToken: string
	/** The slug of the project's broadcast route, which a `broadcast` message goes through; `broadcast` by default. */
	readonly broadcastRoute?: string
}

export class LettermintEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: true,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: LETTERMINT_MAX_ATTACHMENT_BYTES,
		minBodyLength: LETTERMINT_MIN_BODY_LENGTH,
		broadcast: true,
	}
	readonly #projectToken: string
	readonly #broadcastRoute: string

	constructor(options: LettermintEmailSenderOptions) {
		if (!isCredential(options.projectToken)) {
			throw new EmailDeliveryError('Lettermint project token is invalid', { code: 'invalid_configuration' })
		}
		const broadcastRoute = options.broadcastRoute ?? DEFAULT_BROADCAST_ROUTE
		if (!isChannelName(broadcastRoute)) {
			throw new EmailDeliveryError('Lettermint broadcast route is invalid', { code: 'invalid_configuration' })
		}
		super({ label: 'Lettermint', provider: 'lettermint' }, options)
		this.#projectToken = options.projectToken
		this.#broadcastRoute = broadcastRoute
	}

	protected async request(message: EmailMessage): Promise<HttpEmailRequest> {
		const attachments = message.attachments ?? []
		return {
			url: LETTERMINT_SEND_URL,
			headers: {
				'x-lettermint-token': this.#projectToken,
				'Idempotency-Key': await providerIdempotencyKey(message.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH),
			},
			body: {
				from: formatMailbox(this.from.address, message.fromName ?? this.from.name),
				to: [message.to],
				// Lettermint keeps broadcast mail on infrastructure apart from the transactional route.
				...(message.broadcast === true ? { route: this.#broadcastRoute } : {}),
				subject: message.subject,
				text: message.text,
				...(message.html === undefined ? {} : { html: message.html }),
				...(message.replyTo === undefined ? {} : { reply_to: [message.replyTo] }),
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
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		return lettermintSuccessSchema.safeParse(response.body).data?.message_id
	}

	protected override refusal(response: ProviderResponse, message: EmailMessage): EmailDeliveryError | undefined {
		const status = response.status
		// Only a broadcast message names a route; a transactional one takes the project's default, so its 422 is another.
		if (
			status === 422 && message.broadcast === true && UNKNOWN_ROUTE.test(lettermintApiErrorSchema.safeParse(response.body).data?.error.message ?? '')
		) {
			return new EmailDeliveryError(
				'Lettermint knows no such route in the project: create its broadcast route, or name it in FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE (422)',
				{ code: 'provider_rejected', httpStatus: status },
			)
		}
		if (status !== 409) return undefined
		// The 409 has no code, so its text is read, and only to tell the two apart; it never reaches the error. A wording
		// that no longer names the payload reads as in progress, which a retry cannot turn into a second delivery.
		const text = lettermintErrorSchema.safeParse(response.body).data?.message
		if (text !== undefined && OTHER_PAYLOAD.test(text)) {
			return new EmailDeliveryError('Lettermint already took a different request under this idempotency key', {
				code: 'idempotency_conflict',
				httpStatus: status,
			})
		}
		// Every other 409 is a request under the key still in progress, or one whose outcome is unknown, which Lettermint
		// answers the same way until the key expires. A retry cannot deliver twice, so it is retried.
		return new EmailDeliveryError('A matching Lettermint request is still in progress', { code: 'request_in_progress', httpStatus: status })
	}
}

const lettermintVariablesSchema = z.object({
	FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: credentialVariable,
	FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE: optionalVariable(isChannelName),
})

export const lettermintEmailProvider: EmailProvider = {
	variables: [
		{ name: 'FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN', secret: true, required: true },
		{ name: 'FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE', secret: false, required: false },
	],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(lettermintVariablesSchema, env)
		return new LettermintEmailSender({
			projectToken: variables.FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN,
			broadcastRoute: variables.FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE,
			from,
			fetch,
		})
	},
}
