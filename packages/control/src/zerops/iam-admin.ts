import type { HttpService } from '@fabrika/platform'

/**
 * Private-network implementation of the IAM admin fetch port — TRANSPORT ONLY.
 *
 * It readdresses the request to IAM's private origin and changes nothing else. In particular it does
 * NOT rewrite `Origin`/`Referer`. It used to: it replaced them with IAM's private RPC origin so that
 * IAM's CSRF check — which compared against IAM's PUBLIC issuer — would pass. In any deployment where
 * those two differ, which is the normal production shape, they never agreed and every console call to
 * the Access plane answered 403. The rewrite was papering over a deeper mistake anyway: the browser's
 * `Origin` is the CONSOLE's, never IAM's, so no rewriting scheme could have made an issuer comparison
 * correct. IAM is now TOLD which origins may drive its admin surface (`FABRIKA_IAM_ADMIN_ORIGINS`),
 * and it needs the header exactly as the browser sent it to apply that.
 *
 * The session cookie flows through untouched for the same reason: IAM authenticates, authorizes and
 * audits the BROWSER's principal, not the control plane's.
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
