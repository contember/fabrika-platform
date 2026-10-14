// The one response header policy of a contract application and the file treatment of its downloads (ADR-0022,
// "Response headers"). The proxy sets them on every answer, its own denials included; the framework sets the same
// definition in-process. Exported as `@fabrika/proxy-core/headers`, which imports nothing at runtime.

import type { CspExtensions } from '@fabrika/auth-core'

/** Every powerful feature off. ADR-0022 lists the same names; change both together. */
export const PERMISSIONS_POLICY_FEATURES: readonly string[] = [
	'accelerometer',
	'ambient-light-sensor',
	'autoplay',
	'bluetooth',
	'browsing-topics',
	'camera',
	'clipboard-read',
	'display-capture',
	'encrypted-media',
	'fullscreen',
	'gamepad',
	'geolocation',
	'gyroscope',
	'hid',
	'identity-credentials-get',
	'idle-detection',
	'local-fonts',
	'magnetometer',
	'microphone',
	'midi',
	'otp-credentials',
	'payment',
	'picture-in-picture',
	'publickey-credentials-create',
	'publickey-credentials-get',
	'screen-wake-lock',
	'serial',
	'storage-access',
	'usb',
	'web-share',
	'window-management',
	'xr-spatial-tracking',
]

const PERMISSIONS_POLICY = PERMISSIONS_POLICY_FEATURES.map((feature) => `${feature}=()`).join(', ')

export type HeaderPolicy = readonly (readonly [name: string, value: string])[]

/** The named origins a contract adds to seven CSP directives: exact `https://` origins, never patterns. */
export interface CspOrigins {
	readonly connectSrc: readonly string[]
	readonly imgSrc: readonly string[]
	readonly frameAncestors: readonly string[]
	readonly scriptSrc: readonly string[]
	/** `frame-src 'self' <origins>` is emitted only when it names an origin; without it frames fall back to `default-src 'self'`. */
	readonly frameSrc: readonly string[]
	readonly styleSrc: readonly string[]
	readonly fontSrc: readonly string[]
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * An exact origin with a literal hostname: no path, no credentials and no wildcard (`new URL` accepts `*` in a
 * hostname), so it means one site and is safe inside a header value. CSP origins are `https:` only.
 */
export function isPolicyOrigin(value: string, protocols: readonly string[] = ['https:']): boolean {
	try {
		const url = new URL(value)
		return protocols.includes(url.protocol) && url.origin === value && HOSTNAME.test(url.hostname)
	} catch {
		return false
	}
}

/** The most named origins one directive may carry: the contract build and the manifest parser refuse more. */
export const MAX_CSP_ORIGINS = 16

export const NO_CSP_ORIGINS: CspOrigins = Object.freeze({
	connectSrc: [],
	imgSrc: [],
	frameAncestors: [],
	scriptSrc: [],
	frameSrc: [],
	styleSrc: [],
	fontSrc: [],
})

export function cspOrigins(csp: CspExtensions): CspOrigins {
	return {
		connectSrc: csp.connectSrc.map((source) => source.origin),
		imgSrc: csp.imgSrc.map((source) => source.origin),
		frameAncestors: csp.frameAncestors.map((source) => source.origin),
		scriptSrc: (csp.scriptSrc ?? []).map((source) => source.origin),
		frameSrc: (csp.frameSrc ?? []).map((source) => source.origin),
		styleSrc: (csp.styleSrc ?? []).map((source) => source.origin),
		fontSrc: (csp.fontSrc ?? []).map((source) => source.origin),
	}
}

/**
 * The policy for one application: the fixed CSP, extended by the contract's named origins and by the Operations
 * ingest origin the browser reports errors to.
 */
export function headerPolicy(origins: CspOrigins, operationsOrigin: string | null): HeaderPolicy {
	const connect = ["'self'", ...(operationsOrigin === null ? [] : [operationsOrigin]), ...origins.connectSrc]
	const frameAncestors = origins.frameAncestors.length === 0 ? ["'none'"] : origins.frameAncestors
	const directives = [
		"default-src 'self'",
		`script-src ${["'self'", ...origins.scriptSrc].join(' ')}`,
		`style-src ${["'self'", "'unsafe-inline'", ...origins.styleSrc].join(' ')}`,
		`img-src ${["'self'", 'data:', 'blob:', ...origins.imgSrc].join(' ')}`,
		`font-src ${["'self'", 'data:', ...origins.fontSrc].join(' ')}`,
		`connect-src ${connect.join(' ')}`,
		"form-action 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		`frame-ancestors ${frameAncestors.join(' ')}`,
		// Without it frames fall back to `default-src 'self'`; a declared origin only extends that, so `'self'` stays.
		...(origins.frameSrc.length === 0 ? [] : [`frame-src ${["'self'", ...origins.frameSrc].join(' ')}`]),
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

/** The browser-facing scheme of a manifest entry's hosts; behind a TLS-terminating balancer no header can supply it. */
export type PublicScheme = 'http' | 'https'

/** One year. No `includeSubDomains` and no `preload`: applications share parent domains. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000'

/**
 * What every answer of an application host carries for its transport: HSTS on an `https` host, nothing on `http` (the
 * local stack). Only the proxy knows the scheme, from the manifest, so the framework's in-process policy has none.
 */
export function transportPolicy(scheme: PublicScheme): HeaderPolicy {
	return scheme === 'https' ? [['Strict-Transport-Security', STRICT_TRANSPORT_SECURITY]] : []
}

/**
 * The transport headers the policy owns: an `https` entry's policy sets them, and every other answer loses the
 * application's own, so an `http` host never pins a browser to a scheme it does not serve.
 */
export const TRANSPORT_HEADERS: readonly string[] = ['Strict-Transport-Security']

/** The policy of a contract application's manifest entry, its transport header included. */
export function appHeaderPolicy(app: { readonly csp: CspOrigins; readonly operationsOrigin?: string; readonly scheme: PublicScheme }): HeaderPolicy {
	return Object.freeze([...headerPolicy(app.csp, app.operationsOrigin ?? null), ...transportPolicy(app.scheme)])
}

/** The policy of an answer that belongs to no contract application: no named origin, no ingest. */
export const BASE_HEADER_POLICY: HeaderPolicy = headerPolicy(NO_CSP_ORIGINS, null)

/** Raster formats a browser only ever renders as an image; every other download, SVG and HTML included, is an attachment. */
export const INLINE_FILE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** What every answer of a download endpoint carries in place of the policy, its errors included. */
export const FILE_TREATMENT: HeaderPolicy = Object.freeze([
	['X-Content-Type-Options', 'nosniff'],
	['Content-Security-Policy', "sandbox; default-src 'none'"],
	// A revoked user must not read a cached copy.
	['Cache-Control', 'private, no-store'],
])

/** The file treatment of a manifest entry's downloads, its transport header included. */
export function appFileTreatment(app: { readonly scheme: PublicScheme }): HeaderPolicy {
	return Object.freeze([...FILE_TREATMENT, ...transportPolicy(app.scheme)])
}

/**
 * Headers an application may not send at all: each names a reporting endpoint the policy never approved, and a
 * report-only CSP reports there whatever the enforced one says (`document-uri`, `blocked-uri`).
 */
export const REMOVED_RESPONSE_HEADERS: readonly string[] = ['Content-Security-Policy-Report-Only', 'Report-To', 'Reporting-Endpoints', 'NEL']

/** `null` and anything but one allowlisted value is an attachment; `Headers` joins repeated fields with `, `, so two never match. */
export function fileDisposition(contentType: string | null): 'inline' | 'attachment' {
	return contentType !== null && INLINE_FILE_TYPES.includes(contentType) ? 'inline' : 'attachment'
}

/** Whatever the handler or an asset server set for these names is replaced; the removed and transport headers are dropped first. */
export function applyHeaderPolicy(headers: Headers, policy: HeaderPolicy): void {
	for (const name of [...REMOVED_RESPONSE_HEADERS, ...TRANSPORT_HEADERS]) {
		headers.delete(name)
	}
	for (const [name, value] of policy) {
		headers.set(name, value)
	}
}

/**
 * The file treatment over headers a download already carries: the disposition type follows the `Content-Type`
 * exactly, and the parameters after it (the file name) are kept. The proxy passes `appFileTreatment` of its entry.
 */
export function applyFileTreatment(headers: Headers, treatment: HeaderPolicy = FILE_TREATMENT): void {
	applyHeaderPolicy(headers, treatment)
	const parameters = headers.get('Content-Disposition')?.replace(/^[^;]*/, '') ?? ''
	headers.set('Content-Disposition', `${fileDisposition(headers.get('Content-Type'))}${parameters}`)
}

/** A copy of `response` whose headers `apply` rewrote; status and body are unchanged. */
export function withResponseHeaders(response: Response, apply: (headers: Headers) => void): Response {
	const headers = new Headers(response.headers)
	apply(headers)
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
