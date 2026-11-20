// The request half both HTTP adapters share: the caller's signal, the adapter's own timeout, how a thrown fetch is
// classified, and a redirect that is never followed. Messages name the provider and nothing the request carried.

import { EmailDeliveryError, type EmailFetch } from './email.js'

export interface ProviderRequest {
	/** The provider's name as it appears in error messages. */
	readonly label: string
	readonly fetch: EmailFetch
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
	readonly signal: AbortSignal
	readonly timeoutMs: number
}

export interface ProviderResponse {
	readonly ok: boolean
	readonly status: number
	/** The parsed JSON body, or undefined when it is not JSON. Never put into an error. */
	readonly body: unknown
}

/**
 * The answer with its body already read, so an abort or a timeout while the body arrives is classified as one. A redirect
 * is never followed: a followed one would send the credential headers and the message to wherever it points.
 */
export async function postToProvider(request: ProviderRequest): Promise<ProviderResponse> {
	if (request.signal.aborted) throw abortedError(request.label)
	const timeout = AbortSignal.timeout(request.timeoutMs)
	const signal = AbortSignal.any([request.signal, timeout])
	try {
		const response = await request.fetch(request.url, {
			method: 'POST',
			headers: { ...request.headers, 'Content-Type': 'application/json' },
			signal,
			body: JSON.stringify(request.body),
			redirect: 'manual',
		})
		if (isRedirect(response)) {
			void response.body?.cancel().catch(() => undefined)
			throw redirectError(request.label, response.status)
		}
		const text = await untilAborted(response.text(), signal)
		return { ok: response.ok, status: response.status, body: parseJson(text) }
	} catch (error) {
		if (error instanceof EmailDeliveryError) throw error
		if (request.signal.aborted) throw abortedError(request.label)
		if (timeout.aborted) throw new EmailDeliveryError(`${request.label} request timed out`, { code: 'request_timeout' })
		throw new EmailDeliveryError(`${request.label} request failed`, { code: 'network_error' })
	}
}

/**
 * A 3xx, or the opaque answer a browser-like runtime gives for one under `redirect: 'manual'`. The endpoint answered
 * without taking the message, and the same request gets the same answer, so it is a permanent `provider_rejected`: the
 * configured URL is not the provider's API, and a person fixes it.
 */
function isRedirect(response: Response): boolean {
	return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
}

function redirectError(label: string, status: number): EmailDeliveryError {
	const shown = status === 0 ? 'redirect' : `${status}`
	return new EmailDeliveryError(`${label} answered with a redirect (${shown}), which is not followed`, {
		code: 'provider_rejected',
		...(status === 0 ? {} : { httpStatus: status }),
	})
}

export function parseTimeout(label: string, value: number | undefined): number {
	const timeoutMs = value ?? 10_000
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
		throw new EmailDeliveryError(`${label} timeout is invalid`, { code: 'invalid_configuration' })
	}
	return timeoutMs
}

/** An injected fetch's body need not follow the signal, so the read races it. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason)
		signal.addEventListener('abort', onAbort, { once: true })
		pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
	})
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function abortedError(label: string): EmailDeliveryError {
	return new EmailDeliveryError(`${label} request was aborted by the caller`, { code: 'aborted' })
}
