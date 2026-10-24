import type { HttpService } from '@fabrika/platform'

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

/** Private-network Operations transport for both operator gateway requests and catalog projection. */
export class HttpOperationsService implements HttpService {
	private readonly origin: URL

	constructor(origin: string, private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
		this.origin = new URL(origin)
	}

	fetch(request: Request): Promise<Response> {
		const incoming = new URL(request.url)
		const target = new URL(this.origin)
		target.pathname = incoming.pathname
		target.search = incoming.search

		const headers = new Headers(request.headers)
		headers.delete('host')
		if (headers.has('origin')) {
			headers.set('origin', target.origin)
		}
		if (headers.has('referer')) {
			headers.set('referer', `${target.origin}/`)
		}

		return fetch(
			new Request(target, {
				method: request.method,
				headers,
				...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
				redirect: 'manual',
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			}),
		)
	}
}
