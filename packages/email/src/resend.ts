import { EmailDeliveryError, type EmailDeliveryResult, type EmailMessage, type EmailSender } from './email.js'
import { isValidEmailFrom, validateEmailMessage } from './validation.js'

const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

export type EmailFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ResendEmailSenderOptions {
	readonly apiKey: string
	readonly from: string
	readonly fetch?: EmailFetch
	readonly timeoutMs?: number
}

export class ResendEmailSender implements EmailSender {
	readonly #apiKey: string
	readonly #from: string
	readonly #fetch: EmailFetch
	readonly #timeoutMs: number

	constructor(options: ResendEmailSenderOptions) {
		if (!validApiKey(options.apiKey)) {
			throw new EmailDeliveryError('Resend API key is invalid', { code: 'invalid_configuration', retryable: false })
		}
		if (!isValidEmailFrom(options.from)) {
			throw new EmailDeliveryError('Resend sender is invalid', { code: 'invalid_configuration', retryable: false })
		}
		const timeoutMs = options.timeoutMs ?? 10_000
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
			throw new EmailDeliveryError('Resend timeout is invalid', { code: 'invalid_configuration', retryable: false })
		}

		this.#apiKey = options.apiKey
		this.#from = options.from
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.#timeoutMs = timeoutMs
	}

	async send(message: EmailMessage): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)

		let response: Response
		const signal = AbortSignal.timeout(this.#timeoutMs)
		try {
			response = await this.#fetch(RESEND_EMAILS_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': message.idempotencyKey,
				},
				signal,
				body: JSON.stringify({
					from: this.#from,
					to: message.to,
					subject: message.subject,
					text: message.text,
					...(message.html === undefined ? {} : { html: message.html }),
				}),
			})
		} catch {
			if (signal.aborted) {
				throw new EmailDeliveryError('Resend request timed out', { code: 'request_timeout', retryable: true })
			}
			throw new EmailDeliveryError('Resend request failed', { code: 'network_error', retryable: true })
		}

		if (!response.ok) throw await responseError(response)

		const messageId = await readMessageId(response)
		if (messageId === undefined) {
			throw new EmailDeliveryError('Resend returned an invalid success response', {
				code: 'malformed_response',
				retryable: true,
				httpStatus: response.status,
			})
		}

		return { status: 'accepted', provider: 'resend', messageId }
	}
}

async function responseError(response: Response): Promise<EmailDeliveryError> {
	const providerError = await readProviderError(response)
	if (response.status === 429) {
		return new EmailDeliveryError('Resend rate limit exceeded', { code: 'rate_limited', retryable: true, httpStatus: response.status })
	}
	if (response.status >= 500) {
		return new EmailDeliveryError('Resend is unavailable', { code: 'provider_unavailable', retryable: true, httpStatus: response.status })
	}
	if (response.status === 409 && providerError === 'concurrent_idempotent_requests') {
		return new EmailDeliveryError('A matching Resend request is still in progress', {
			code: 'request_in_progress',
			retryable: true,
			httpStatus: response.status,
		})
	}
	return new EmailDeliveryError(`Resend rejected the request (${response.status})`, {
		code: 'provider_rejected',
		retryable: false,
		httpStatus: response.status,
	})
}

async function readMessageId(response: Response): Promise<string | undefined> {
	const body = await readJson(response)
	if (!isRecord(body)) return undefined
	const id: unknown = Reflect.get(body, 'id')
	return typeof id === 'string' && id.length > 0 ? id : undefined
}

async function readProviderError(response: Response): Promise<string | undefined> {
	const body = await readJson(response)
	if (!isRecord(body)) return undefined
	const name: unknown = Reflect.get(body, 'name')
	return typeof name === 'string' ? name : undefined
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json()
	} catch {
		return undefined
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validApiKey(value: string): boolean {
	if (value.length === 0 || value.trim() !== value) return false
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 33 || code > 126) return false
	}
	return true
}
