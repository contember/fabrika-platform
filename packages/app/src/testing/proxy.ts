// The proxy in front of the test kit's application: production's decision, proxy-core's verify service over the
// endpoint table `contractProxyTable` compiles from the contract, asked the way the Cloudflare proxy Worker asks it.

import { type ContractArtifact, DELEGATION_HEADER, ENDPOINT_HEADER, rawRequestTarget } from '@fabrika/auth-core'
import {
	APP_QUERY_PARAM,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	type DelegationIssuer,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	type IamGateway,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
} from '@fabrika/proxy-core'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'

/** What the proxy did with a request: answered it itself, or forwarded it with what only the proxy may set. */
export type ProxyOutcome =
	| {
		readonly outcome: 'forward'
		/** Every header only the proxy may assert, with the value the decision gave it. */
		readonly asserted: ReadonlyMap<string, string>
		/** Whether the request's own `Authorization` reaches the application: not on an anonymous endpoint. */
		readonly keepsAuthorization: boolean
	}
	| { readonly outcome: 'answer'; readonly response: Response }

/** What the proxy reads of a request; its headers have already lost every one a client may not assert. */
export interface ProxiedRequest {
	readonly method: string
	readonly url: string
	readonly headers: Headers
}

export type TestProxy = (request: ProxiedRequest) => Promise<ProxyOutcome>

export interface EndpointProxyOptions {
	readonly artifact: ContractArtifact
	readonly appId: string
	readonly host: string
	readonly iam: IamGateway
	readonly issuer: string
	/** Issues the delegation grants of membership and scope-creating endpoints, as IAM does for the proxy. */
	readonly delegations: DelegationIssuer | null
}

const ASSERTED_HEADERS = [PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, ENDPOINT_HEADER, DELEGATION_HEADER]

/** The production proxy: the verify service over the contract's endpoint table, asked the way an enforcement point asks it. */
export function endpointProxy(options: EndpointProxyOptions): TestProxy {
	const verify = createVerifyService({
		manifest: {
			apps: [{ id: options.appId, hosts: [options.host], upstream: 'app', scheme: 'https', ...contractProxyTable(options.artifact) }],
		},
		iam: options.iam,
		issuer: options.issuer,
		delegations: options.delegations,
	})
	const verifyUrl = `https://fabrika-proxy.internal${DEFAULT_VERIFY_PATH}?${APP_QUERY_PARAM}=${encodeURIComponent(options.appId)}`
	return async (request) => {
		const headers = new Headers(request.headers)
		const target = rawRequestTarget(request.url)
		headers.set(FORWARDED_METHOD_HEADER, request.method)
		headers.set(FORWARDED_URI_HEADER, `${target.pathname}${target.search}`)
		headers.set(FORWARDED_HOST_HEADER, new URL(request.url).host)
		headers.set(FORWARDED_PROTO_HEADER, 'https')
		const verification = await verify(new Request(verifyUrl, { method: 'GET', headers }))
		if (!verification.ok) {
			return { outcome: 'answer', response: verification }
		}
		const asserted = new Map<string, string>()
		for (const header of ASSERTED_HEADERS) {
			const value = verification.headers.get(header)
			if (value !== null && value !== '') {
				asserted.set(header, value)
			}
		}
		return { outcome: 'forward', asserted, keepsAuthorization: asserted.has(PROXY_TOKEN_HEADER) }
	}
}
