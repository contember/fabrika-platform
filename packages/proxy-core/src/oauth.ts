import { AGENT_CALLER, AGENT_SCOPE_MODES } from '@fabrika/auth-core'
import {
	type ContractProxyApp,
	isApplicationEntry,
	type OAuthProtectedResource,
	oauthProtectedResourceMetadata,
	parseOAuthProtectedResource,
	type ProxyApp,
} from './manifest'

/**
 * The auth service's RFC 9728 metadata endpoint. Separate from `/verify` because a 2xx from `/verify`
 * admits the request to the app, while metadata is answered by the proxy itself and never forwarded.
 */
export const OAUTH_METADATA_VERIFY_PATH = '/oauth-metadata'

/** Where an application environment publishes the metadata of its one resource, its origin (ADR-0090). */
export const AGENT_METADATA_PATH = '/.well-known/oauth-protected-resource'

/** Whether an application entry has a row an agent may call: only such an entry is a protected resource. */
export function admitsAgent(app: ProxyApp): app is ContractProxyApp {
	return isApplicationEntry(app) && app.endpoints.some((row) => row.callers.some((caller) => caller === AGENT_CALLER))
}

/**
 * The resource an application environment is at the host the request names: the origin `<scheme>://<host>`, with the
 * scheme from the manifest, as the login bounce builds it. The host is one of the entry's (`selectApp`). Null when the
 * resource or the issuer is no valid RFC 9728 document field, which refuses the request.
 */
export function agentResourceOf(app: ContractProxyApp, url: URL, issuer: string): OAuthProtectedResource | null {
	if (!URL.canParse(`${app.scheme}://${url.host}`) || !URL.canParse(issuer)) return null
	const origin = new URL(`${app.scheme}://${url.host}`).origin
	return parseOAuthProtectedResource({
		resource: origin,
		resourceMetadata: `${origin}${AGENT_METADATA_PATH}`,
		authorizationServers: [new URL(issuer).origin],
		scopesSupported: [...AGENT_SCOPE_MODES],
	})
}

/**
 * The entry's protected resource whose metadata URL is this request's host and exact raw pathname: an installation
 * entry's registered one, or an application environment's own when it admits `agent`.
 */
export function findOAuthMetadata(app: ProxyApp, url: URL, issuer: string): OAuthProtectedResource | null {
	if (isApplicationEntry(app)) {
		return url.pathname === AGENT_METADATA_PATH && admitsAgent(app) ? agentResourceOf(app, url, issuer) : null
	}
	const hostname = url.hostname.toLowerCase()
	return app.oauthResources?.find((resource) => {
		const metadata = new URL(resource.resourceMetadata)
		return metadata.hostname === hostname && metadata.pathname === url.pathname
	}) ?? null
}

export function oauthMetadataResponse(resource: OAuthProtectedResource, method: string): Response {
	if (method !== 'GET' && method !== 'HEAD') {
		return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } })
	}
	return new Response(method === 'HEAD' ? null : JSON.stringify(oauthProtectedResourceMetadata(resource)), {
		status: 200,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	})
}
