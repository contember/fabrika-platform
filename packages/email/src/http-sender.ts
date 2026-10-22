// What every HTTP provider adapter shares, so an adapter holds only its provider's mapping: the request it sends for a
// message, the message id of an accepted answer, and the answers it tells apart beyond the HTTP status. The base
// validates the message against the adapter's capabilities before any I/O and classifies the rest.

import { z } from 'zod'
import type { EmailSenderIdentity } from './config.js'
import {
	EmailDeliveryError,
	type EmailDeliveryResult,
	type EmailFetch,
	type EmailMessage,
	type EmailSender,
	type EmailSenderCapabilities,
} from './email.js'
import { parseTimeout, postToProvider, type ProviderResponse } from './http.js'
import {
	isValidEmailSenderIdentity,
	isVisibleAscii,
	validateEmailAttachments,
	validateEmailBodies,
	validateEmailBroadcast,
	validateEmailMessage,
} from './validation.js'

/** The options every HTTP adapter takes beside its credentials. */
export interface HttpEmailSenderOptions {
	readonly from: EmailSenderIdentity
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

export interface HttpEmailRequest {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

export abstract class HttpEmailSender implements EmailSender {
	abstract readonly capabilities: EmailSenderCapabilities
	protected readonly from: EmailSenderIdentity
	readonly #label: string
	readonly #provider: string
	readonly #fetch: EmailFetch
	readonly #timeoutMs: number

	/** `label` names the provider in every message, `provider` in every result. An adapter checks its credentials first. */
	protected constructor(names: { readonly label: string; readonly provider: string }, options: HttpEmailSenderOptions) {
		if (!isValidEmailSenderIdentity(options.from)) {
			throw new EmailDeliveryError(`${names.label} sender is invalid`, { code: 'invalid_configuration' })
		}
		this.from = options.from
		this.#label = names.label
		this.#provider = names.provider
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.#timeoutMs = parseTimeout(names.label, options.timeoutMs)
	}

	/** The request for a message that passed validation. */
	protected abstract request(message: EmailMessage): HttpEmailRequest | Promise<HttpEmailRequest>

	/** The message id of a 2xx answer; undefined when the answer is not a valid success. May throw a refusal. */
	protected abstract messageId(response: ProviderResponse): string | undefined

	/** A failed answer the provider tells apart beyond its status; undefined leaves it to `refusalByStatus`. */
	protected refusal(_response: ProviderResponse): EmailDeliveryError | undefined {
		return undefined
	}

	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		if (message.unsubscribeUrl !== undefined && this.capabilities.listUnsubscribe !== true) {
			throw new EmailDeliveryError(`${this.#label} cannot write the List-Unsubscribe headers`, { code: 'invalid_message' })
		}
		validateEmailAttachments(message, this.capabilities, this.#label)
		validateEmailBodies(message, this.capabilities, this.#label)
		validateEmailBroadcast(message, this.capabilities, this.#label)

		const request = await this.request(message)
		const response = await postToProvider({ label: this.#label, fetch: this.#fetch, ...request, signal, timeoutMs: this.#timeoutMs })
		if (!response.ok) throw this.refusal(response) ?? refusalByStatus(this.#label, response.status)

		const messageId = this.messageId(response)
		if (messageId === undefined || messageId === '') {
			throw new EmailDeliveryError(`${this.#label} returned an invalid success response`, {
				code: 'malformed_response',
				httpStatus: response.status,
			})
		}
		return { status: 'accepted', provider: this.#provider, messageId }
	}
}

/** The classification of a failed answer by its status alone, for every answer an adapter does not tell apart. */
export function refusalByStatus(label: string, status: number): EmailDeliveryError {
	if (status === 401 || status === 403) {
		return new EmailDeliveryError(`${label} refused the credentials (${status})`, { code: 'provider_unauthorized', httpStatus: status })
	}
	if (status === 429) return new EmailDeliveryError(`${label} rate limit exceeded`, { code: 'rate_limited', httpStatus: status })
	if (status >= 500) return new EmailDeliveryError(`${label} is unavailable`, { code: 'provider_unavailable', httpStatus: status })
	return new EmailDeliveryError(`${label} rejected the request (${status})`, { code: 'provider_rejected', httpStatus: status })
}

/** RFC 5322 specials a display name may still hold after validation; any of them makes the name a quoted string. */
const DISPLAY_NAME_SPECIALS = /[()[\]:;@,.]/

/** `Name <address>` for an API that takes the sender as one header value; validation keeps the name quotable. */
export function formatMailbox(address: string, name: string | undefined): string {
	if (name === undefined) return address
	return DISPLAY_NAME_SPECIALS.test(name) ? `"${name}" <${address}>` : `${name} <${address}>`
}

/** An API key or token: non-empty visible ASCII, so it fits a header unchanged. */
export function isCredential(value: string): boolean {
	return value.length > 0 && isVisibleAscii(value)
}

/** The name of a provider's stream or route: 1..64 letters, digits, `_` and `-`. */
export function isChannelName(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/** A provider variable that holds a credential. */
export const credentialVariable = z.string().refine(isCredential)

/** An optional provider variable: empty is absent, and a present value must pass `valid`. */
export function optionalVariable(valid: (value: string) => boolean) {
	return z.string().optional().transform((value) => (value === '' ? undefined : value)).refine((value) => value === undefined || valid(value))
}

/**
 * The message's key as a provider that takes at most `maxLength` characters sends it. A longer key is sent as its
 * SHA-256, which keeps one key one key: a retry sends the same digest, another message another.
 */
export async function providerIdempotencyKey(key: string, maxLength: number): Promise<string> {
	if (key.length <= maxLength) return key
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
