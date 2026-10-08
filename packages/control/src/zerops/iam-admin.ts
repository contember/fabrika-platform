import type { HttpService } from '@fabrika/platform'

/**
 * Private-network implementation of the IAM admin fetch port — TRANSPORT ONLY. It readdresses the
 * request to IAM's private origin and changes nothing else; `forwardIamAdmin` has already replaced the
 * browser's cookie with the console's bearer token.
 */
export class HttpIamAdminGateway implements HttpService {
	private readonly origin: URL

	constructor(origin: string) {
		this.origin = new URL(origin)
	}

	fetch(request: Request): Promise<Response> {
		const incoming = new URL(request.url)
		const target = new URL(this.origin)
		target.pathname = incoming.pathname
		target.search = incoming.search

		const headers = new Headers(request.headers)
		headers.delete('host')

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
