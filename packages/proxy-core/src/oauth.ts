import { isApplicationEntry, type OAuthProtectedResource, oauthProtectedResourceMetadata, type ProxyApp } from './manifest'

/**
 * The auth service's RFC 9728 metadata endpoint. Separate from `/verify` because a 2xx from `/verify`
 * admits the request to the app, while metadata is answered by the proxy itself and never forwarded.
 */
export const OAUTH_METADATA_VERIFY_PATH = '/oauth-metadata'

/**
 * The entry's protected resource whose metadata URL is this request's host and exact raw pathname. Only an
 * installation entry has one.
 */
export function findOAuthMetadata(app: ProxyApp, url: URL): OAuthProtectedResource | null {
	if (isApplicationEntry(app)) return null
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
