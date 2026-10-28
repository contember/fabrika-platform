import {
	EmailDeliveryError,
	type EmailDeliveryResult,
	type EmailFetch,
	type EmailMessage,
	type EmailSender,
	type EmailSenderCapabilities,
} from './email.js'
import { parseTimeout, postToProvider } from './http.js'
import {
	encodePlatformMailRequest,
	installationMailKey,
	parsePlatformMailAnswer,
	PLATFORM_MAIL_CAPABILITIES,
	PLATFORM_MAIL_SEND_PATH,
} from './platform-wire.js'
import { isVisibleAscii, validateEmailAttachments, validateEmailBroadcast, validateEmailMessage } from './validation.js'

export {
	encodePlatformMailRequest,
	hashPlatformKey,
	installationMailKey,
	parsePlatformMailAnswer,
	parsePlatformMailRequest,
	PLATFORM_MAIL_CAPABILITIES,
	PLATFORM_MAIL_ERROR_STATUS,
	PLATFORM_MAIL_SEND_PATH,
	platformMailAnswerResponse,
	platformMailFingerprint,
} from './platform-wire.js'
export type {
	PlatformMailAccepted,
	PlatformMailAnswer,
	PlatformMailErrorCode,
	PlatformMailReply,
	PlatformMailRequestResult,
} from './platform-wire.js'

/** `FABRIKA_EMAIL_PROVIDER=platform`: the application sends through the platform's relay, not a provider of its own. */
export const PLATFORM_EMAIL_PROVIDER = 'platform'

const LABEL = 'Platform mail'

export interface PlatformEmailSenderOptions {
	/** The receiver's http(s) origin (`FABRIKA_PLATFORM_MAIL_URL`); the send path is appended to it. */
	readonly url: string
	readonly key: string
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

/** Hands each message to the platform's relay, which records it under its key and dispatches it later. */
export class PlatformEmailSender implements EmailSender {
	readonly capabilities: EmailSenderCapabilities = PLATFORM_MAIL_CAPABILITIES
	readonly #sendUrl: string
	readonly #key: string
	readonly #fetch: EmailFetch
	readonly #timeoutMs: number

	constructor(options: PlatformEmailSenderOptions) {
		if (!isHttpOrigin(options.url)) {
			throw new EmailDeliveryError('Platform mail URL is not an http(s) origin', { code: 'invalid_configuration' })
		}
		if (options.key.length === 0 || !isVisibleAscii(options.key)) {
			throw new EmailDeliveryError('Platform mail key is invalid', { code: 'invalid_configuration' })
		}

		this.#sendUrl = `${options.url}${PLATFORM_MAIL_SEND_PATH}`
		this.#key = options.key
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.#timeoutMs = parseTimeout(LABEL, options.timeoutMs)
	}

	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		validateEmailAttachments(message, this.capabilities, LABEL)
		validateEmailBroadcast(message, this.capabilities, LABEL)

		// postToProvider serializes the body itself; the canonical text survives the round trip unchanged.
		const body: unknown = JSON.parse(encodePlatformMailRequest(message))
		const response = await postToProvider({
			label: LABEL,
			fetch: this.#fetch,
			url: this.#sendUrl,
			headers: { Authorization: `Bearer ${this.#key}` },
			body,
			signal,
			timeoutMs: this.#timeoutMs,
		})

		const answer = parsePlatformMailAnswer(response.status, response.body)
		if (answer === null) {
			throw new EmailDeliveryError(`Platform mail relay returned an invalid answer (${response.status})`, {
				code: 'malformed_response',
				httpStatus: response.status,
			})
		}
		if ('error' in answer) {
			throw new EmailDeliveryError(`Platform mail relay refused the message (${response.status})`, {
				code: answer.error.code,
				httpStatus: response.status,
			})
		}
		return { status: 'accepted', provider: 'platform', messageId: answer.messageId }
	}
}

export interface InstallationMailSenderOptions {
	/** Control's http(s) origin; the send path is appended to it. */
	readonly url: string
	/** The secret the service shares with Control, which its key derives from (`installationMailKey`). */
	readonly secret: string
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

/**
 * An installation service's sender to Control's relay: a `PlatformEmailSender` under `installationMailKey(secret)`,
 * built at the first send because deriving the key is asynchronous. A send that cannot build it (a URL that is not an
 * origin, a secret that is not usable) throws and keeps nothing, so the next send builds it again.
 */
export function installationMailSender(options: InstallationMailSenderOptions): EmailSender {
	let sender: Promise<PlatformEmailSender> | undefined
	return {
		capabilities: PLATFORM_MAIL_CAPABILITIES,
		async send(message, signal) {
			const pending = sender ??= installationMailKey(options.secret).then((key) =>
				new PlatformEmailSender({
					url: options.url,
					key,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				})
			)
			const ready = await pending.catch((error: unknown) => {
				// Only the build that failed is dropped; a send that started a newer one keeps it.
				if (sender === pending) sender = undefined
				throw error
			})
			return ready.send(message, signal)
		},
	}
}

/**
 * `http(s)://host[:port]` exactly as written: no path, query, fragment or credentials. The one check of a relay's origin,
 * for the sender, IAM's boot and IAM's Cloudflare deploy (which also requires `https:`).
 */
export function isHttpOrigin(value: string): boolean {
	try {
		const url = new URL(value)
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
	} catch {
		return false
	}
}
