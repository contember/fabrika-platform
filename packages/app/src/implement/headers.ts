// The one response header policy of a contract application (ADR-0022 rule 2, framework document §5). The framework
// sets it on every response it answers, denials included; the proxy will set the same policy on its own (B4).

import type { CspExtensions, CspSource } from '@fabrika/auth-core'

/** Every powerful feature off. ADR-0022 leaves the exact list to B4; this is the list until then. */
const PERMISSIONS_POLICY = [
	'accelerometer',
	'autoplay',
	'bluetooth',
	'camera',
	'display-capture',
	'encrypted-media',
	'fullscreen',
	'gamepad',
	'geolocation',
	'gyroscope',
	'hid',
	'idle-detection',
	'local-fonts',
	'magnetometer',
	'microphone',
	'midi',
	'payment',
	'picture-in-picture',
	'publickey-credentials-create',
	'publickey-credentials-get',
	'screen-wake-lock',
	'serial',
	'usb',
	'web-share',
	'xr-spatial-tracking',
].map((feature) => `${feature}=()`).join(', ')

export type HeaderPolicy = readonly (readonly [name: string, value: string])[]

function origins(sources: readonly CspSource[]): string[] {
	return sources.map((source) => source.origin)
}

/**
 * The policy for one application: the fixed CSP, extended by the contract's named origins and by the Operations
 * ingest origin the browser reports errors to.
 */
export function headerPolicy(csp: CspExtensions, operationsOrigin: string | null): HeaderPolicy {
	const connect = ["'self'", ...(operationsOrigin === null ? [] : [operationsOrigin]), ...origins(csp.connectSrc)]
	const frameAncestors = csp.frameAncestors.length === 0 ? ["'none'"] : origins(csp.frameAncestors)
	const directives = [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		`img-src ${["'self'", 'data:', 'blob:', ...origins(csp.imgSrc)].join(' ')}`,
		"font-src 'self' data:",
		`connect-src ${connect.join(' ')}`,
		"form-action 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		`frame-ancestors ${frameAncestors.join(' ')}`,
	]
	return Object.freeze([
		['Content-Security-Policy', directives.join('; ')],
		['X-Content-Type-Options', 'nosniff'],
		['Cache-Control', 'no-store'],
		['Referrer-Policy', 'no-referrer'],
		['Cross-Origin-Opener-Policy', 'same-origin'],
		['Permissions-Policy', PERMISSIONS_POLICY],
	])
}

/** A copy of `response` carrying the policy; whatever the handler or an asset server set for these names is replaced. */
export function withHeaderPolicy(response: Response, policy: HeaderPolicy): Response {
	const headers = new Headers(response.headers)
	for (const [name, value] of policy) {
		headers.set(name, value)
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
