import type { HttpService } from '@fabrika/platform'

/** Private-network implementation of the IAM admin fetch port. */
export class HttpIamAdminGateway implements HttpService {
	private readonly origin: URL

	constructor(origin: string, private readonly localBearer?: string) {
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
		if (this.localBearer !== undefined && this.localBearer !== '') {
			headers.set('authorization', `Bearer ${this.localBearer}`)
		}

		return fetch(
			new Request(target, {
				method: request.method,
				headers,
				...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
				redirect: 'manual',
			}),
		)
	}
}
