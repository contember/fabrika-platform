import { responseError } from './errors'

export const GITHUB_ACCEPT = 'application/vnd.github+json'
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_USER_AGENT = 'vozka'
const MAX_RESPONSE_BYTES = 64 * 1024

interface RequestCancellation {
	readonly signal: AbortSignal
	throwIfCancelled(): void
	dispose(): void
}

export function createCancellation(callerSignal: AbortSignal | undefined, timeoutMs: number): RequestCancellation {
	const controller = new AbortController()
	let timedOut = false
	const abortFromCaller = (): void => controller.abort()
	if (callerSignal?.aborted === true) {
		controller.abort()
	} else {
		callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
	}
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	return {
		signal: controller.signal,
		throwIfCancelled() {
			if (callerSignal?.aborted === true) {
				throw abortError()
			}
			if (timedOut) {
				throw timeoutError()
			}
			if (controller.signal.aborted) {
				throw abortError()
			}
		},
		dispose() {
			clearTimeout(timer)
			callerSignal?.removeEventListener('abort', abortFromCaller)
		},
	}
}

export async function readBoundedJson(
	response: Response,
	cancellation: RequestCancellation,
	maxResponseBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
	cancellation.throwIfCancelled()
	const contentLength = response.headers.get('content-length')
	if (contentLength !== null && /^[0-9]+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
		void response.body?.cancel().catch(() => {})
		throw responseError()
	}
	const reader = response.body?.getReader()
	if (reader === undefined) {
		throw responseError()
	}
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readChunk(reader, cancellation)
			if (result.done) {
				break
			}
			total += result.value.byteLength
			if (total > maxResponseBytes) {
				throw responseError()
			}
			chunks.push(result.value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		cancellation.throwIfCancelled()
		throw error
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	cancellation.throwIfCancelled()
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		const body: unknown = JSON.parse(text)
		cancellation.throwIfCancelled()
		return body
	} catch (error) {
		cancellation.throwIfCancelled()
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw error
		}
		throw responseError()
	}
}

function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cancellation: RequestCancellation,
): Promise<{ done: true } | { done: false; value: Uint8Array }> {
	cancellation.throwIfCancelled()
	return new Promise((resolve, reject) => {
		const aborted = (): void => {
			cleanup()
			try {
				cancellation.throwIfCancelled()
			} catch (error) {
				reject(error)
			}
		}
		const cleanup = (): void => cancellation.signal.removeEventListener('abort', aborted)
		cancellation.signal.addEventListener('abort', aborted, { once: true })
		reader.read().then(
			(result) => {
				cleanup()
				resolve(result.done ? { done: true } : { done: false, value: result.value })
			},
			() => {
				cleanup()
				try {
					cancellation.throwIfCancelled()
					reject(responseError())
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function abortError(): DOMException {
	return new DOMException('GitHub App request was aborted', 'AbortError')
}

function timeoutError(): DOMException {
	return new DOMException('GitHub App request timed out', 'TimeoutError')
}
