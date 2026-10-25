// Cloudflare Email Service's Email Sending REST API (https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
// built from its documentation in October 2026 and verified only against a stubbed fetch. It has no idempotency key,
// and Cloudflare takes transactional mail only. The REST API, not the Workers `send_email` binding, so the transport is
// one set of `FABRIKA_EMAIL_*` on every runtime that sends: a Worker, a Bun process on Zerops, an application.

import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { base64Of } from './content.js'
import { EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities, oneClickUnsubscribeHeaders } from './email.js'
import { credentialVariable, type HttpEmailRequest, HttpEmailSender, type HttpEmailSenderOptions, isCredential } from './http-sender.js'
import type { ProviderResponse } from './http.js'

const CLOUDFLARE_ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts'
/** A Cloudflare account ID: 32 hexadecimal digits, the path of every request. */
const ACCOUNT_ID_PATTERN = /^[0-9a-fA-F]{32}$/
const cloudflareSuccessSchema = z.object({
	success: z.literal(true),
	result: z.object({
		message_id: z.string(),
		permanent_bounces: z.array(z.string()).optional(),
		suppressed_recipients: z.array(z.string()).optional(),
	}),
})
/**
 * Cloudflare counts the whole message, attachments base64 and MIME-wrapped, against 5 MiB; 3 MiB of bytes leaves
 * about a mebibyte for the bodies and the headers.
 */
const CLOUDFLARE_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024

export interface CloudflareEmailSenderOptions extends HttpEmailSenderOptions {
	/** An account API token with the Email Sending Write permission and nothing else. */
	readonly apiToken: string
	/** The account the token sends for: the path of every request. */
	readonly accountId: string
}

/** A refusal's body carries numeric codes and machine-readable messages; only the status is read. */
export class CloudflareEmailSender extends HttpEmailSender {
	readonly capabilities: EmailSenderCapabilities = {
		idempotent: false,
		confirmation: 'sync',
		maxBatch: 1,
		listUnsubscribe: true,
		maxAttachmentBytes: CLOUDFLARE_MAX_ATTACHMENT_BYTES,
		// Cloudflare Email Service takes transactional mail only, so it sends no broadcast.
	}
	readonly #apiToken: string
	readonly #sendUrl: string

	constructor(options: CloudflareEmailSenderOptions) {
		if (!isCredential(options.apiToken)) {
			throw new EmailDeliveryError('Cloudflare API token is invalid', { code: 'invalid_configuration' })
		}
		if (!ACCOUNT_ID_PATTERN.test(options.accountId)) {
			throw new EmailDeliveryError('Cloudflare account ID is invalid', { code: 'invalid_configuration' })
		}
		super({ label: 'Cloudflare', provider: 'cloudflare' }, options)
		this.#apiToken = options.apiToken
		this.#sendUrl = `${CLOUDFLARE_ACCOUNTS_URL}/${options.accountId}/email/sending/send`
	}

	protected request(message: EmailMessage): HttpEmailRequest {
		const senderName = message.fromName ?? this.from.name
		const attachments = message.attachments ?? []
		return {
			url: this.#sendUrl,
			headers: { Authorization: `Bearer ${this.#apiToken}` },
			body: {
				from: { address: this.from.address, ...(senderName === undefined ? {} : { name: senderName }) },
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
							content: base64Of(attachment.content),
							filename: attachment.filename,
							type: attachment.contentType,
							disposition: 'attachment',
						})),
					}),
			},
		}
	}

	protected messageId(response: ProviderResponse): string | undefined {
		const result = cloudflareSuccessSchema.safeParse(response.body).data?.result
		if (result === undefined) return undefined
		// A 200 groups the recipients by outcome; the one recipient listed as bounced or suppressed got nothing. The
		// lists name the address, so they stay out of the refusal.
		if ((result.permanent_bounces?.length ?? 0) > 0 || (result.suppressed_recipients?.length ?? 0) > 0) {
			throw new EmailDeliveryError(`Cloudflare refused the recipient (${response.status})`, { code: 'provider_rejected', httpStatus: response.status })
		}
		return result.message_id
	}

	protected override refusal(response: ProviderResponse): EmailDeliveryError | undefined {
		// Documented as a resource not found: under this path, an account the token cannot reach.
		if (response.status === 404) {
			return new EmailDeliveryError('Cloudflare knows no such account (404)', { code: 'provider_unauthorized', httpStatus: response.status })
		}
		return undefined
	}
}

const cloudflareVariablesSchema = z.object({
	FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN: credentialVariable,
	FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID: z.string().regex(ACCOUNT_ID_PATTERN),
})

export const cloudflareEmailProvider: EmailProvider = {
	variables: [
		{ name: 'FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN', secret: true, required: true },
		{ name: 'FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID', secret: false, required: true },
	],
	create({ from, env, fetch }) {
		const variables = parseProviderVariables(cloudflareVariablesSchema, env)
		return new CloudflareEmailSender({
			apiToken: variables.FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN,
			accountId: variables.FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID,
			from,
			fetch,
		})
	},
}
