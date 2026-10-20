/**
 * The generated Caddy JSON. Two classes of assertion:
 *
 *  1. **Shape** — the emitted `forward_auth` expansion matches what Caddy v2.10.2's
 *     `forwardauth/caddyfile.go` produces, field for field. If it drifts, Caddy silently does
 *     something else.
 *  2. **Structure** — no route reaches an app upstream without passing through `/verify` first, and
 *     the injected token header is stripped from every inbound request. These are the properties that
 *     make the Caddy layer itself fail-closed.
 */

import { FABRIKA_HOP_HEADERS, IAM_PROXY_SECRET_VARIABLE, PROXY_SECRET_HEADER, proxySecretVariable } from '@fabrika/auth-core'
import {
	CLIENT_ADDRESS_HEADER,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	errorPage,
	type ErrorPageStatus,
	FORWARD_AUTHORIZATION_HEADER,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/proxy-core'
import type { BrandImage } from '@fabrika/proxy-core/brand'
import { appFileTreatment, appHeaderPolicy, BASE_HEADER_POLICY, FILE_TREATMENT, type HeaderPolicy, NO_CSP_ORIGINS } from '@fabrika/proxy-core/headers'
import type { ContractProxyApp, InstallationProxyApp, ProxyApp, ProxyManifest } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { endpointRow, installationAppWith, installationRow, protocolRow, serviceRow } from '../../../proxy-core/src/__tests__/helpers'
import {
	buildCaddyConfig,
	type CaddyBuildOptions,
	CaddyConfigError,
	type CaddyHeadersHandler,
	type CaddyReverseProxyHandler,
	type CaddyRoute,
	type CaddyStaticResponseHandler,
	type CaddySubrouteHandler,
	uriRedactionPattern,
} from '../caddy'

const CONSOLE = serviceRow('/*', ['human'])

const MANIFEST: ProxyManifest = {
	apps: [
		installationAppWith([protocolRow('/public/*'), CONSOLE], [], { id: 'app-one', hosts: ['one.example.com'], upstream: 'one:3000' }),
		installationAppWith([serviceRow('/*', ['machine'])], [], {
			id: 'app-two',
			hosts: ['two.example.com', 'alias.example.com'],
			upstream: 'two:8080',
		}),
	],
}

const OPTIONS = { authUpstream: '127.0.0.1:9000' }

/** A one-pixel PNG, the smallest image the brand validator admits. */
const PIXEL: BrandImage = {
	type: 'image/png',
	base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
}

function rawSubrouteOf(route: CaddyRoute): CaddySubrouteHandler {
	const handler = route.handle[0]
	if (handler === undefined || handler.handler !== 'subroute') {
		throw new Error('expected a subroute')
	}
	return handler
}

/** The app's chain after its `Connection` refusal, which every chain starts with (tested on its own below). */
function subrouteOf(route: CaddyRoute): CaddySubrouteHandler {
	const [refusal, ...routes] = rawSubrouteOf(route).routes
	if (refusal?.match?.[0]?.header_regexp?.['Connection'] === undefined) {
		throw new Error('expected the chain to start with the Connection refusal')
	}
	return { handler: 'subroute', routes }
}

function policyValues(policy: HeaderPolicy): Record<string, string[]> {
	return Object.fromEntries(policy.map(([name, value]) => [name, [value]]))
}

/**
 * What a browser's top-level navigation reads in place of `otherwise`: the host's policy on the answer, then the named
 * page of `status`, written once for the whole server.
 */
function pageOr(status: ErrorPageStatus, policy: HeaderPolicy, otherwise: CaddyStaticResponseHandler): CaddySubrouteHandler {
	const route = `fabrika-page-${status}`
	return {
		handler: 'subroute',
		routes: [
			{
				match: [{ header: { 'Sec-Fetch-Mode': ['navigate'] } }],
				handle: [
					{ handler: 'headers', response: { set: { ...policyValues(policy), 'Content-Type': ['text/html; charset=utf-8'] } } },
					{ handler: 'invoke', name: route },
				],
				terminal: true,
			},
			{ handle: [otherwise] },
		],
	}
}

/**
 * What a navigation reads in place of one of Caddy's own failures: the 503 and the 504 their own page, every other
 * status the page of an application that does not answer, printing the status.
 */
function failurePageOr(policy: HeaderPolicy, otherwise: CaddyStaticResponseHandler): CaddySubrouteHandler {
	const status = '{http.error.status_code}'
	return {
		handler: 'subroute',
		routes: [
			{
				match: [{ header: { 'Sec-Fetch-Mode': ['navigate'] } }],
				handle: [
					{ handler: 'headers', response: { set: { ...policyValues(policy), 'Content-Type': ['text/html; charset=utf-8'] } } },
					{
						handler: 'subroute',
						routes: [
							{ match: [{ vars: { [status]: ['503'] } }], handle: [{ handler: 'invoke', name: 'fabrika-page-503' }], terminal: true },
							{ match: [{ vars: { [status]: ['504'] } }], handle: [{ handler: 'invoke', name: 'fabrika-page-504' }], terminal: true },
							{ handle: [{ handler: 'invoke', name: 'fabrika-page-failure' }] },
						],
					},
				],
				terminal: true,
			},
			{ handle: [otherwise] },
		],
	}
}

/** A refusal Caddy writes itself: the page to a navigation, the fixed text to anything else. */
function refusal(status: ErrorPageStatus, text: string, policy: HeaderPolicy): CaddySubrouteHandler {
	return pageOr(status, policy, { handler: 'static_response', status_code: status, headers: policyValues(policy), body: text })
}

/** The app upstream of a step-3 route: its last handler, after any deferred response handlers that wrap it. */
function upstreamOf(route: CaddyRoute | undefined): CaddyReverseProxyHandler {
	const handler = route?.handle.at(-1)
	if (handler === undefined || handler.handler !== 'reverse_proxy') {
		throw new Error('expected a reverse_proxy')
	}
	return handler
}

const INFORMATIONAL: CaddyHeadersHandler = { handler: 'headers', response: { require: { status_code: [1] }, delete: ['*'] } }
const REMOVED = [
	'Content-Security-Policy-Report-Only',
	'Report-To',
	'Reporting-Endpoints',
	'NEL',
	'Access-Control-Allow-Origin',
	'Access-Control-Allow-Credentials',
	'Access-Control-Allow-Methods',
	'Access-Control-Allow-Headers',
	'Access-Control-Expose-Headers',
	'Access-Control-Max-Age',
]

function proxyHandler(route: CaddyRoute | undefined): CaddyReverseProxyHandler {
	const handler = route?.handle[0]
	if (handler === undefined || handler.handler !== 'reverse_proxy') {
		throw new Error('expected a reverse_proxy')
	}
	return handler
}

describe('server shape', () => {
	const config = buildCaddyConfig(MANIFEST, OPTIONS)

	test('the admin API is disabled — no live mutation surface in front of every app', () => {
		expect(config.admin.disabled).toBe(true)
	})

	test('automatic HTTPS is off: the Zerops L7 balancer terminates TLS', () => {
		expect(config.apps.http.servers['proxy']?.automatic_https?.disable).toBe(true)
		// Consequently: no ACME, no cert storage, and nothing that needs a disk.
		expect(JSON.stringify(config)).not.toContain('tls')
	})

	test('one route per app, in manifest order, plus a terminal 404', () => {
		const routes = config.apps.http.servers['proxy']?.routes ?? []
		expect(routes).toHaveLength(3)
		expect(routes[0]?.match?.[0]?.host).toEqual(['one.example.com'])
		expect(routes[1]?.match?.[0]?.host).toEqual(['two.example.com', 'alias.example.com'])
		// Nothing falls off the end into a default handler.
		expect(routes[2]?.match).toBeUndefined()
		expect(routes[2]?.handle).toEqual([refusal(404, 'not found', BASE_HEADER_POLICY)])
	})

	test("the pages are written once, as named routes, and a host's route only invokes them", () => {
		const pages = config.apps.http.servers['proxy']?.named_routes ?? {}
		expect(Object.keys(pages).sort()).toEqual(['fabrika-page-400', 'fabrika-page-404', 'fabrika-page-503', 'fabrika-page-504', 'fabrika-page-failure'])
		const statuses: (400 | 404 | 503 | 504)[] = [400, 404, 503, 504]
		for (const status of statuses) {
			expect(pages[`fabrika-page-${status}`]).toEqual({ handle: [{ handler: 'static_response', status_code: status, body: errorPage(status) }] })
		}
		expect(pages['fabrika-page-failure']).toEqual({
			handle: [{
				handler: 'static_response',
				status_code: '{http.error.status_code}',
				body: errorPage(502, { shownStatus: '{http.error.status_code}' }),
			}],
		})
		// No page body outside the named routes: a page is the size of a logo, and there are as many hosts as apps.
		const { named_routes: _pages, ...rest } = config.apps.http.servers['proxy'] ?? { listen: [], routes: [] }
		expect(JSON.stringify(rest)).not.toContain('<!doctype html>')
	})

	test("the installation's client logo is in each page once and nowhere else (ADR-0065)", () => {
		const branded = buildCaddyConfig({ ...MANIFEST, brand: { light: PIXEL } }, OPTIONS).apps.http.servers['proxy']
		const pages = branded?.named_routes ?? {}
		for (const name of ['fabrika-page-400', 'fabrika-page-404', 'fabrika-page-503', 'fabrika-page-504', 'fabrika-page-failure']) {
			expect(JSON.stringify(pages[name]).split(PIXEL.base64).length - 1).toBe(1)
		}
		expect(JSON.stringify(branded?.routes)).not.toContain(PIXEL.base64)
		expect(JSON.stringify(branded?.errors)).not.toContain(PIXEL.base64)
	})

	test('the health route is on its own listener, so it shadows no app path', () => {
		const proxy = config.apps.http.servers['proxy']
		const health = config.apps.http.servers['health']
		expect(proxy?.listen).toEqual([':8080'])
		expect(health?.listen).toEqual([':8081'])
		expect(JSON.stringify(proxy?.routes)).not.toContain('healthz')
	})

	test('no trusted proxy range by default, so client_ip stays the socket peer', () => {
		// The fallback WU-C is designed around: nobody has confirmed on a live account whether the Zerops
		// project balancer appends an address a downstream may trust, so the default configures none.
		// `client_ip` is then the balancer, every client shares one bucket, and that is today's behaviour
		// — never a caller-chosen key.
		expect(config.apps.http.servers['proxy']?.trusted_proxies).toBeUndefined()
		expect(config.apps.http.servers['proxy']?.trusted_proxies_strict).toBeUndefined()
		for (const blank of [[], ['', '  ']]) {
			expect(buildCaddyConfig(MANIFEST, { ...OPTIONS, trustedProxies: blank }).apps.http.servers['proxy']?.trusted_proxies)
				.toBeUndefined()
		}
	})

	test('a configured range emits the static IP source, in strict mode', () => {
		const trusted = buildCaddyConfig(MANIFEST, { ...OPTIONS, trustedProxies: ['10.0.0.0/8', ' fd00::/8 '] })
		expect(trusted.apps.http.servers['proxy']?.trusted_proxies).toEqual({ source: 'static', ranges: ['10.0.0.0/8', 'fd00::/8'] })
		// Strict parses the client-IP header right to left and stops at the first untrusted hop, so a
		// caller cannot prepend addresses and have one of them picked.
		expect(trusted.apps.http.servers['proxy']?.trusted_proxies_strict).toBe(1)
	})

	test('a host claimed by two apps is rejected at generation time', () => {
		const clashing: ProxyManifest = {
			apps: [
				installationAppWith([], [], { id: 'a', hosts: ['same.example.com'], upstream: 'a:1' }),
				installationAppWith([], [], { id: 'b', hosts: ['SAME.example.com'], upstream: 'b:1' }),
			],
		}
		expect(() => buildCaddyConfig(clashing, OPTIONS)).toThrow(CaddyConfigError)
	})
})

describe('the per-app chain is fail-closed by construction', () => {
	const config = buildCaddyConfig(MANIFEST, OPTIONS)
	const routes = config.apps.http.servers['proxy']?.routes ?? []

	test('every app route strips the client-assertable headers BEFORE anything else', () => {
		for (const route of routes.slice(0, 2)) {
			const strip = subrouteOf(route).routes[0]?.handle
			// The token, or a `protocol` row would carry a client's own to the app; the request id, which is
			// written to IAM's auth log and audit trail; and every name a client address travels under, so
			// the only one an upstream can read is the one this hop writes below. Within one HeaderOps a
			// named delete runs AFTER the set (caddyhttp/headers.go ApplyTo, v2.10.2), so the set is a second
			// handler. The token and the request id are restored from the decision.
			expect(strip).toEqual([
				{
					handler: 'headers',
					request: {
						delete: [
							PROXY_TOKEN_HEADER,
							CLIENT_ADDRESS_HEADER,
							ENDPOINT_HEADER,
							DELEGATION_HEADER,
							PROXY_SECRET_HEADER,
							REQUEST_ID_HEADER,
							...UNTRUSTED_FORWARD_HEADERS,
						],
					},
				},
				{ handler: 'headers', request: { set: { [CLIENT_ADDRESS_HEADER]: ['{http.vars.client_ip}'] } } },
			])
		}
	})

	test('a Connection header naming an asserted header is refused before anything else', () => {
		// reverse_proxy deletes every header Connection names after the asserted ones are set (v2.10.2
		// removeConnectionHeaders), so a client could strip the client address, the token or the endpoint.
		for (const route of routes.slice(0, 2)) {
			const first = rawSubrouteOf(route).routes[0]
			expect(first?.handle).toEqual([refusal(400, 'bad request', BASE_HEADER_POLICY)])
			expect(first?.terminal).toBe(true)
			const pattern = first?.match?.[0]?.header_regexp?.['Connection']?.pattern ?? ''
			expect(pattern.startsWith('(?i)')).toBe(true)
			const re = new RegExp(pattern.slice('(?i)'.length), 'i')
			for (const header of [...FABRIKA_HOP_HEADERS, REQUEST_ID_HEADER]) {
				expect(re.test(header)).toBe(true)
				expect(re.test(`keep-alive, ${header.toLowerCase()}`)).toBe(true)
				expect(re.test(`${header} ,Upgrade`)).toBe(true)
			}
			for (const harmless of ['keep-alive', 'Upgrade', 'close', 'X-Fabrika-Tokenized', 'x-request-identity']) {
				expect(re.test(harmless)).toBe(false)
			}
		}
	})

	test('a caller cannot choose the client coordinate on any of the names it travels under', () => {
		// The spoofing test for THIS composition. Caddy's own `client_ip` is the only source: it is
		// resolved in PrepareRequest, before any handler runs, from the socket peer and — only for a peer
		// inside `trusted_proxies` — the client-IP header chain. So the injected value cannot be a
		// caller's, and every name a caller could have used to smuggle one is deleted first.
		const [ops, set] = subrouteOf(routes[0] as CaddyRoute).routes[0]?.handle ?? []
		if (ops?.handler !== 'headers' || set?.handler !== 'headers') throw new Error('expected two headers handlers')
		for (const spoofable of [CLIENT_ADDRESS_HEADER, ...UNTRUSTED_FORWARD_HEADERS]) {
			expect(ops.request?.delete).toContain(spoofable)
		}
		// The set is never in the same HeaderOps as a delete of the same name, which would undo it.
		expect(ops.request?.set).toBeUndefined()
		expect(set.request?.delete).toBeUndefined()
		expect(set.request?.set?.[CLIENT_ADDRESS_HEADER]).toEqual(['{http.vars.client_ip}'])
		// Never copied back from the auth response either: the decision service is downstream of the edge
		// and gets no vote on who the client was.
		expect(JSON.stringify(proxyHandler(subrouteOf(routes[0] as CaddyRoute).routes[1]).handle_response))
			.not.toContain(CLIENT_ADDRESS_HEADER)
	})

	test('the app upstream is only ever reached AFTER the auth subrequest', () => {
		for (const route of routes.slice(0, 2)) {
			const steps = subrouteOf(route).routes
			expect(steps).toHaveLength(3)
			// step 1 strips, step 2 is forward_auth to the auth service, step 3 is the app.
			expect(proxyHandler(steps[1]).upstreams).toEqual([{ dial: '127.0.0.1:9000' }])
			expect(proxyHandler(steps[1]).rewrite?.uri).toContain('/verify?app=')
			expect(proxyHandler(steps[2]).rewrite).toBeUndefined()
		}
	})

	test('the app upstream receives app cookies, never Fabrika browser credentials', () => {
		const upstream = proxyHandler(subrouteOf(routes[0] as CaddyRoute).routes[2])
		const replacements = upstream.headers?.request?.replace?.['Cookie'] ?? []
		let cookie = '__Host-px_session=session; app-cookie=kept; __Host-px_handoff_state=verifier; theme=dark'
		for (const replacement of replacements) {
			cookie = cookie.replace(new RegExp(replacement.search_regexp, 'g'), replacement.replace)
		}
		expect(cookie).toBe('app-cookie=kept; theme=dark')
	})

	test('no reverse_proxy anywhere dials an app upstream outside such a chain', () => {
		const upstreams = MANIFEST.apps.map((app) => app.upstream)
		let found = 0
		for (const route of routes) {
			// Only an app's route matches a host; the unmatched-host 404 is a subroute too, and dials nothing.
			if (route.match?.[0]?.host === undefined) {
				expect(JSON.stringify(route)).not.toContain('reverse_proxy')
				continue
			}
			const steps = subrouteOf(route).routes
			const last = proxyHandler(steps[steps.length - 1])
			expect(upstreams).toContain(last.upstreams[0]?.dial ?? '')
			expect(steps.findIndex((step) => step.handle[0]?.handler === 'reverse_proxy')).toBe(1)
			found++
		}
		expect(found).toBe(MANIFEST.apps.length)
	})

	test('the app id is pinned in the auth URI, never inferred from a client header', () => {
		expect(proxyHandler(subrouteOf(routes[0] as CaddyRoute).routes[1]).rewrite?.uri).toBe('/verify?app=app-one')
		expect(proxyHandler(subrouteOf(routes[1] as CaddyRoute).routes[1]).rewrite?.uri).toBe('/verify?app=app-two')
	})
})

describe('IAM login cookie ownership', () => {
	const owner = { issuer: 'https://iam.example.com', upstream: 'iam:3000' }
	const iam: ProxyApp = installationAppWith([protocolRow('/*')], [], { id: 'identity-service', hosts: ['iam.example.com'], upstream: 'iam:3000' })

	function upstreamCookie(app: ProxyApp, cookie: string, iamSessionOwner?: CaddyBuildOptions['iamSessionOwner']): string {
		const config = buildCaddyConfig({ apps: [app] }, { ...OPTIONS, ...(iamSessionOwner === undefined ? {} : { iamSessionOwner }) })
		const route = config.apps.http.servers['proxy']?.routes[0]
		if (route === undefined) throw new Error('expected an app route')
		const upstream = proxyHandler(subrouteOf(route).routes[2])
		for (const replacement of upstream.headers?.request?.replace?.['Cookie'] ?? []) {
			cookie = cookie.replace(new RegExp(replacement.search_regexp, 'g'), replacement.replace)
		}
		return cookie
	}

	test.each([
		'__Host-px_session=login; app-cookie=kept; __Host-px_handoff_state=verifier',
		'__Host-px_handoff_state=verifier; __Host-px_session=login; app-cookie=kept',
		'__Host-px_unknown=secret; __Host-px_session=login; __Host-px_session_extra=secret; app-cookie=kept',
		'__Host-px_session_extra=secret; __Host-px_session=login; app-cookie=kept; __Host-px_=secret',
	])('only the exact login cookie and application cookies reach the owner: %s', (cookie) => {
		expect(upstreamCookie(iam, cookie, owner)).toBe('__Host-px_session=login; app-cookie=kept')
	})

	test("IAM's OIDC flight cookie reaches the owner: its name is outside the stripped prefix", () => {
		expect(upstreamCookie(iam, '__Host-fabrika_oidc=flight; __Host-px_session=login; __Host-px_handoff_state=verifier; theme=dark', owner))
			.toBe('__Host-fabrika_oidc=flight; __Host-px_session=login; theme=dark')
	})

	test('retains separators when the login cookie follows an application cookie', () => {
		expect(upstreamCookie(iam, 'app-cookie=kept;\t__Host-px_session=login; __Host-px_handoff_state=verifier; theme=dark', owner))
			.toBe('app-cookie=kept;\t__Host-px_session=login; theme=dark')
	})

	test('strips every Fabrika cookie when no owner was configured', () => {
		expect(upstreamCookie(iam, '__Host-px_session=login; app-cookie=kept; __Host-px_handoff_state=verifier')).toBe('app-cookie=kept')
	})

	const nonOwners: { name: string; app: ProxyApp }[] = [
		{ name: 'a public app named iam at another host', app: { ...iam, id: 'iam', hosts: ['other.example.com'] } },
		{ name: 'the IAM host routed to another private upstream', app: { ...iam, id: 'iam', upstream: 'other:3000' } },
		{ name: 'the IAM host with an additional alias', app: { ...iam, hosts: ['iam.example.com', 'alias.example.com'] } },
		{ name: 'the IAM host under the wrong scheme', app: { ...iam, scheme: 'http' } },
	]
	for (const { name, app } of nonOwners) {
		test(`does not preserve a login cookie for ${name}`, () => {
			expect(upstreamCookie(app, '__Host-px_session=login; app-cookie=kept; __Host-px_handoff_state=verifier', owner)).toBe('app-cookie=kept')
		})
	}

	function upstreamSet(app: ProxyApp, iamSessionOwner?: CaddyBuildOptions['iamSessionOwner']) {
		const config = buildCaddyConfig({ apps: [app] }, { ...OPTIONS, ...(iamSessionOwner === undefined ? {} : { iamSessionOwner }) })
		const route = config.apps.http.servers['proxy']?.routes[0]
		if (route === undefined) throw new Error('expected an app route')
		return proxyHandler(subrouteOf(route).routes[2]).headers?.request?.set
	}

	test('the owner route proves the proxy sent it, with the secret read from IAM_PROXY_SECRET_VARIABLE', () => {
		expect(upstreamSet(iam, owner)).toEqual({ [PROXY_SECRET_HEADER]: [`{env.${IAM_PROXY_SECRET_VARIABLE}}`] })
	})

	test('no secret reaches IAM without a configured owner, or any installation service that is not the owner', () => {
		expect(upstreamSet(iam)).toBeUndefined()
		for (const { app } of nonOwners) {
			expect(upstreamSet(app, owner)).toBeUndefined()
		}
	})

	test('accepts the local HTTP issuer with a non-default port', () => {
		const localOwner = { issuer: 'http://iam.fabrika.localhost:18080/', upstream: 'iam:18080' }
		expect(upstreamCookie({ ...iam, hosts: ['iam.fabrika.localhost'], scheme: 'http', upstream: 'iam:18080' }, '__Host-px_session=login', localOwner))
			.toBe('__Host-px_session=login')
	})

	test.each([
		'',
		'iam.example.com',
		'ftp://iam.example.com',
		'https://user:password@iam.example.com',
		'https://iam.example.com/auth',
		'https://iam.example.com?query=value',
		'https://iam.example.com#fragment',
		' https://iam.example.com',
		'https://*.example.com',
	])('rejects an invalid owner issuer: %s', (issuer) => {
		expect(() => buildCaddyConfig({ apps: [iam] }, { ...OPTIONS, iamSessionOwner: { ...owner, issuer } })).toThrow(CaddyConfigError)
	})

	test.each([
		'',
		'iam',
		'iam:0',
		'iam:65536',
		'iam:NaN',
		'iam:3000/path',
		'user@iam:3000',
		' iam:3000',
		'iam:3000 ',
		'https://iam:3000',
		'[::::]:3000',
	])('rejects an invalid owner upstream: %s', (upstream) => {
		expect(() => buildCaddyConfig({ apps: [iam] }, { ...OPTIONS, iamSessionOwner: { ...owner, upstream } })).toThrow(CaddyConfigError)
	})
})

describe("IAM's known-device cookie", () => {
	const owner = { issuer: 'https://iam.example.com', upstream: 'iam:3000' }
	const iam: ProxyApp = installationAppWith([protocolRow('/*')], [], { id: 'identity-service', hosts: ['iam.example.com'], upstream: 'iam:3000' })

	test('reaches IAM on its session-owning route beside the login cookie', () => {
		const config = buildCaddyConfig({ apps: [iam] }, { ...OPTIONS, iamSessionOwner: owner })
		const route = config.apps.http.servers['proxy']?.routes[0]
		if (route === undefined) throw new Error('expected an app route')
		const upstream = proxyHandler(subrouteOf(route).routes[2])
		let cookie = '__Host-px_session=login; __Host-fabrika_device=device; __Host-px_handoff_state=verifier'
		for (const replacement of upstream.headers?.request?.replace?.['Cookie'] ?? []) {
			cookie = cookie.replace(new RegExp(replacement.search_regexp, 'g'), replacement.replace)
		}
		expect(cookie).toBe('__Host-px_session=login; __Host-fabrika_device=device')
	})
})

describe('the forward_auth expansion matches Caddy v2.10.2', () => {
	const config = buildCaddyConfig(MANIFEST, OPTIONS)
	const auth = proxyHandler(subrouteOf((config.apps.http.servers['proxy']?.routes ?? [])[0] as CaddyRoute).routes[1])

	test('the subrequest is rewritten to GET, which also drops the body', () => {
		expect(auth.rewrite?.method).toBe('GET')
	})

	test('the original method and URI ride in X-Forwarded-* headers', () => {
		expect(auth.headers?.request?.set).toEqual({
			'X-Forwarded-Method': ['{http.request.method}'],
			'X-Forwarded-Uri': ['{http.request.uri}'],
		})
	})

	test('only a 2xx continues; everything else is returned to the client verbatim', () => {
		expect(auth.handle_response?.[0]?.match?.status_code).toEqual([2])
		// A single handle_response entry, matching 2xx. Caddy's default for the rest is to copy the
		// auth response to the client — which is what makes the 302-to-login work with no special case.
		expect(auth.handle_response).toHaveLength(1)
	})

	test('the 2xx branch carries the no-op vars route Caddy requires', () => {
		// reverse_proxy skips a handle_response entry with no routes, which would drop the copy.
		expect(auth.handle_response?.[0]?.routes?.[0]?.handle[0]).toEqual({ handler: 'vars' })
	})

	test('the token copy is guarded by a non-empty check on the placeholder', () => {
		const copy = auth.handle_response?.[0]?.routes?.[1]
		const placeholder = `{http.reverse_proxy.header.${PROXY_TOKEN_HEADER}}`
		expect(copy?.match).toEqual([{ not: [{ vars: { [placeholder]: [''] } }] }])
		expect(copy?.handle[0]).toEqual({
			handler: 'headers',
			request: { set: { [PROXY_TOKEN_HEADER]: [placeholder] } },
		})
	})

	test('the normalized request id is copied onto the upstream request', () => {
		const copy = auth.handle_response?.[0]?.routes?.[2]
		const placeholder = `{http.reverse_proxy.header.${REQUEST_ID_HEADER}}`
		expect(copy?.match).toEqual([{ not: [{ vars: { [placeholder]: [''] } }] }])
		expect(copy?.handle[0]).toEqual({
			handler: 'headers',
			request: { set: { [REQUEST_ID_HEADER]: [placeholder] } },
		})
	})
})

describe('a contract app — the endpoint table', () => {
	const contract: ContractProxyApp = {
		id: 'notes@prod',
		hosts: ['notes.example.com'],
		upstream: 'notes:3000',
		scheme: 'https',
		endpoints: [],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
		csp: NO_CSP_ORIGINS,
	}
	const defined = <T>(value: T | undefined): T => {
		if (value === undefined) throw new Error('missing fixture')
		return value
	}
	const [contractRoute, installationRoute] = buildCaddyConfig({ apps: [contract, defined(MANIFEST.apps[0])] }, OPTIONS).apps.http.servers['proxy']
		?.routes ?? []
	const steps = subrouteOf(defined(contractRoute)).routes
	const auth = proxyHandler(steps[1])
	const copies = auth.handle_response?.[0]?.routes ?? []
	const placeholder = (header: string) => `{http.reverse_proxy.header.${header}}`

	test('a client-sent X-Fabrika-Endpoint or X-Fabrika-Delegation is deleted before the auth service runs', () => {
		const first = steps[0]?.handle[0]
		if (first?.handler !== 'headers') throw new Error('expected a headers handler')
		expect(first.request?.delete).toContain(ENDPOINT_HEADER)
		expect(first.request?.delete).toContain(DELEGATION_HEADER)
	})

	test('the endpoint and the delegation grant are copied back only from a 2xx, and only when set', () => {
		for (const header of [ENDPOINT_HEADER, DELEGATION_HEADER]) {
			expect(copies).toContainEqual({
				match: [{ not: [{ vars: { [placeholder(header)]: [''] } }] }],
				handle: [{ handler: 'headers', request: { set: { [header]: [placeholder(header)] } } }],
			})
		}
	})

	test('an allow without a token — an anonymous endpoint — forwards no Authorization header, unless the decision forwards it', () => {
		expect(copies[1]).toEqual({
			match: [{ vars: { [placeholder(PROXY_TOKEN_HEADER)]: [''] }, not: [{ vars: { [placeholder(FORWARD_AUTHORIZATION_HEADER)]: ['1'] } }] }],
			handle: [{ handler: 'headers', request: { delete: ['Authorization'] } }],
		})
	})

	test("an allow with a token replaces the caller's Authorization with the minted token, after the token is copied", () => {
		const replace = {
			match: [{
				not: [
					{ vars: { [placeholder(PROXY_TOKEN_HEADER)]: [''] } },
					{ vars: { [placeholder(FORWARD_AUTHORIZATION_HEADER)]: ['1'] } },
					{ vars: { '{http.request.header.Authorization}': [''] } },
				],
			}],
			handle: [{ handler: 'headers', request: { set: { Authorization: [`Bearer ${placeholder(PROXY_TOKEN_HEADER)}`] } } }],
		}
		const tokenCopy = copies.findIndex((route) => JSON.stringify(route.handle).includes(`"${PROXY_TOKEN_HEADER}"`))
		expect(tokenCopy).toBeGreaterThan(-1)
		expect(copies.indexOf(defined(copies.find((route) => Bun.deepEquals(route, replace))))).toBeGreaterThan(tokenCopy)
	})

	test('the forwarding marker is not copied onto the request the application receives', () => {
		const copied = copies.flatMap((route) => route.handle).flatMap((
			handler,
		) => (handler.handler === 'headers' ? Object.keys(handler.request?.set ?? {}) : []))
		expect(copied).not.toContain(FORWARD_AUTHORIZATION_HEADER)
	})

	test('an installation entry keeps its Authorization header: IAM reads its own bearer', () => {
		const installationCopies = proxyHandler(subrouteOf(defined(installationRoute)).routes[1]).handle_response?.[0]?.routes ?? []
		expect(JSON.stringify(installationCopies)).not.toContain('Authorization')
	})

	test('every X-Fabrika-* hop header a client sends is deleted before the auth service and the app see it', () => {
		const first = steps[0]?.handle[0]
		if (first?.handler !== 'headers') throw new Error('expected a headers handler')
		for (const header of FABRIKA_HOP_HEADERS) {
			expect(first.request?.delete).toContain(header)
		}
		// After the delete, the endpoint is set only from the auth service's answer, never from the request.
		const endpointSets = copies.flatMap((route) => route.handle).flatMap((handler) =>
			handler.handler === 'headers' ? [handler.request?.set?.[ENDPOINT_HEADER]] : []
		)
			.filter((value) => value !== undefined)
		expect(endpointSets).toEqual([[placeholder(ENDPOINT_HEADER)]])
	})

	test('the upstream hop carries the proxy secret, read from the variable of this app environment', () => {
		const upstream = upstreamOf(steps[2])
		expect(upstream.headers?.request?.set).toEqual({ [PROXY_SECRET_HEADER]: [`{env.${proxySecretVariable('notes@prod')}}`] })
		// Never a value the auth service answers with, and never copied from the client.
		expect(JSON.stringify(auth)).not.toContain(PROXY_SECRET_HEADER)
	})

	test('an installation entry gets no proxy secret: it is not a contract application', () => {
		expect(JSON.stringify(subrouteOf(defined(installationRoute)).routes.slice(1))).not.toContain(PROXY_SECRET_HEADER)
	})

	test('the secret is in no generated file: the config names only the variable', () => {
		expect(JSON.stringify(buildCaddyConfig({ apps: [contract] }, OPTIONS))).toContain(`{env.${proxySecretVariable('notes@prod')}}`)
	})
})

describe('access-log redaction', () => {
	test('the token header, Cookie and Authorization are deleted from log records', () => {
		const fields = buildCaddyConfig(MANIFEST, OPTIONS).logging.logs['default']?.encoder.fields ?? {}
		expect(fields[`request>headers>${PROXY_TOKEN_HEADER}`]).toEqual({ filter: 'delete' })
		// Not a credential — dropped because the record already carries Caddy's own `client_ip` field.
		expect(fields[`request>headers>${CLIENT_ADDRESS_HEADER}`]).toEqual({ filter: 'delete' })
		expect(fields['request>headers>Cookie']).toEqual({ filter: 'delete' })
		expect(fields['request>headers>Authorization']).toEqual({ filter: 'delete' })
		expect(fields[`request>headers>${PROXY_SECRET_HEADER}`]).toEqual({ filter: 'delete' })
	})

	test('a px_ key cannot survive in the logged URI', () => {
		const pattern = new RegExp(uriRedactionPattern(), 'g')
		expect('/s/px_abc123?page=2'.replace(pattern, 'REDACTED')).toBe('/s/REDACTED?page=2')
		// A path that carries no credential is untouched.
		expect('/api/v1/items?page=2'.replace(pattern, 'REDACTED')).toBe('/api/v1/items?page=2')
	})

	test('the ADR-0022 handoff code is redacted on every app, declared or not', () => {
		// The code is a bare random token on a reserved path — no `px_` prefix — so it is only ever caught
		// by an unconditional alternative.
		const pattern = new RegExp(uriRedactionPattern(), 'g')
		expect('/__fabrika/auth/callback?code=deadbeef'.replace(pattern, 'REDACTED')).toBe('/__fabrika/auth/callbackREDACTED')
		expect('/__fabrika/auth/callback?code=deadbeef&x=1'.replace(pattern, 'REDACTED')).toBe('/__fabrika/auth/callbackREDACTED&x=1')
	})

	test('OAuth state is redacted from request and redirect URLs on every app', () => {
		const pattern = new RegExp(uriRedactionPattern(), 'g')
		expect('/api/source/callback?state=CAPABILITY&code=CODE'.replace(pattern, 'REDACTED')).not.toContain('CAPABILITY')
		expect('https://github.com/apps/example/installations/new?state=CAPABILITY'.replace(pattern, 'REDACTED')).not.toContain('CAPABILITY')
	})

	test('a Location is filtered with the same pattern, and covers the login bounce', () => {
		const fields = buildCaddyConfig(MANIFEST, OPTIONS).logging.logs['default']?.encoder.fields ?? {}
		// `resp_headers`, NOT `response>headers`: that is the log record's own field path (verified
		// against caddy 2.10.2), and a misspelled one is ignored rather than rejected.
		const filter = fields['resp_headers>Location']
		expect(filter?.filter).toBe('regexp')
		expect(filter?.regexp).toBe(uriRedactionPattern())

		const pattern = new RegExp(filter?.regexp ?? '', 'g')
		// IAM's 302 to the reserved callback — the proxy fronts IAM too.
		expect('https://app.example.com/__fabrika/auth/callback?code=SECRET'.replace(pattern, 'REDACTED'))
			.not.toContain('SECRET')
		// The login bounce percent-encodes the whole original URL, query and all, into `redirect`.
		const bounce = `https://iam.test/auth/login?app=a&redirect=${encodeURIComponent('https://app.example.com/s/x?resume=SECRET')}`
		expect(bounce.replace(pattern, 'REDACTED')).not.toContain('SECRET')
	})

	test('Caddy is told not to log credentials', () => {
		expect(buildCaddyConfig(MANIFEST, OPTIONS).apps.http.servers['proxy']?.logs?.should_log_credentials).toBe(false)
	})
})

describe('OAuth protected resource metadata', () => {
	const resource = {
		resource: 'https://mcp.example.com/mcp',
		resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
		authorizationServers: ['https://iam.example.com'],
		scopesSupported: ['authoring'],
	}
	function appSteps(proxyApp: ProxyApp): CaddyRoute[] {
		const route = buildCaddyConfig({ apps: [proxyApp] }, OPTIONS).apps.http.servers['proxy']?.routes[0]
		if (route === undefined) throw new Error('expected an app route')
		return subrouteOf(route).routes
	}
	const placement = { id: 'mcp-app', hosts: ['mcp.example.com'], upstream: 'mcp:3000' }
	const mcp = serviceRow('/mcp', ['oauth'], { scopes: ['authoring'] })
	const app = installationAppWith([mcp, CONSOLE], [], { ...placement, oauthResources: [resource] })
	const steps = appSteps(app)

	test('the metadata path is answered by the auth service, after the strip and before forward_auth', () => {
		expect(steps).toHaveLength(4)
		expect(steps[0]?.handle[0]?.handler).toBe('headers')
		const metadata = steps[1]
		expect(metadata?.match).toEqual([{ path: ['/.well-known/oauth-protected-resource/mcp'] }])
		expect(metadata?.terminal).toBe(true)
		const handler = proxyHandler(metadata)
		expect(handler.upstreams).toEqual([{ dial: '127.0.0.1:9000' }])
		expect(handler.rewrite).toEqual({ method: 'GET', uri: '/oauth-metadata?app=mcp-app' })
		expect(handler.headers?.request?.set).toEqual({
			'X-Forwarded-Method': ['{http.request.method}'],
			'X-Forwarded-Uri': ['{http.request.uri}'],
		})
	})

	test('the metadata answer is returned as-is and never continues to the app', () => {
		expect(proxyHandler(steps[1]).handle_response).toBeUndefined()
		expect(proxyHandler(steps[2]).rewrite?.uri).toBe('/verify?app=mcp-app')
		expect(proxyHandler(steps[3]).upstreams).toEqual([{ dial: 'mcp:3000' }])
	})

	test('an app without OAuth resources gets no metadata route', () => {
		expect(appSteps(installationAppWith([CONSOLE], [], placement))).toHaveLength(3)
	})
})

describe('a contract app — the response headers', () => {
	const download = endpointRow({
		id: 'files.avatar.download',
		kind: 'download',
		method: 'GET',
		path: '/api/files.avatar/:fileId',
		callers: ['human'],
		requirement: { kind: 'member' },
		admission: null,
	})
	const contract: ContractProxyApp = {
		id: 'notes@prod',
		hosts: ['notes.example.com'],
		upstream: 'notes:3000',
		scheme: 'https',
		endpoints: [download],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
		csp: {
			connectSrc: ['https://api.maps.example'],
			imgSrc: ['https://tiles.maps.example'],
			frameAncestors: [],
			scriptSrc: [],
			frameSrc: [],
			styleSrc: [],
			fontSrc: [],
		},
		operationsOrigin: 'https://operations.example.com',
	}
	const [contractRoute, installationRoute] = buildCaddyConfig({ apps: [contract, defined(MANIFEST.apps[0])] }, OPTIONS).apps.http.servers['proxy']
		?.routes ?? []
	const policy = appHeaderPolicy(contract)
	const chain = rawSubrouteOf(defined(contractRoute)).routes
	const [downloadRoute, defaultRoute] = chain.slice(-2)

	function defined<T>(value: T | undefined): T {
		if (value === undefined) throw new Error('missing fixture')
		return value
	}

	test('every answer of the app is given the policy with set, so a weaker header the app sent is replaced', () => {
		const upstream = upstreamOf(defaultRoute)
		expect(defaultRoute?.match).toBeUndefined()
		expect(upstream.upstreams).toEqual([{ dial: 'notes:3000' }])
		// The reporting headers go too: a report-only CSP reports to its own endpoint whatever the enforced one says.
		expect(upstream.headers?.response).toEqual({ set: policyValues(policy), delete: REMOVED })
		// A 1xx answer is forwarded before those operations run, so a deferred handler clears it.
		expect(defaultRoute?.handle[0]).toEqual(INFORMATIONAL)
		const csp = upstream.headers?.response?.set?.['Content-Security-Policy']?.[0] ?? ''
		expect(csp).toContain("connect-src 'self' https://operations.example.com https://api.maps.example;")
		expect(csp).toContain("img-src 'self' data: blob: https://tiles.maps.example;")
		expect(csp).toContain("frame-ancestors 'none'")
	})

	test("the app's own refusal of a Connection nomination carries its policy too", () => {
		expect(chain[0]?.handle).toEqual([refusal(400, 'bad request', policy)])
	})

	test('a download endpoint, named by the endpoint the decision asserted, gets the file treatment instead', () => {
		expect(downloadRoute?.match).toEqual([{ header: { [ENDPOINT_HEADER]: ['files.avatar.download@*'] } }])
		expect(downloadRoute?.terminal).toBe(true)
		const [informational, inlineImages, absent, oneType, upstream] = downloadRoute?.handle ?? []
		expect(informational).toEqual(INFORMATIONAL)
		expect(inlineImages).toEqual({
			handler: 'headers',
			response: {
				require: { headers: { 'Content-Type': ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] } },
				replace: { 'Content-Disposition': [{ search_regexp: '^[^;]*', replace: 'inline' }] },
			},
		})
		expect(absent).toEqual({
			handler: 'headers',
			response: { require: { headers: { 'Content-Disposition': null } }, set: { 'Content-Disposition': ['attachment'] } },
		})
		// Repeated Content-Type fields become one joined value, which no allowlisted type equals.
		expect(oneType).toEqual({
			handler: 'headers',
			response: { require: { headers: { 'Content-Type': [] } }, set: { 'Content-Type': ['{http.response.header.Content-Type}'] } },
		})
		if (upstream?.handler !== 'reverse_proxy') throw new Error('expected the upstream')
		expect(upstream.headers?.response).toEqual({
			set: policyValues(appFileTreatment(contract)),
			delete: REMOVED,
			replace: { 'Content-Disposition': [{ search_regexp: '^[^;]*', replace: 'attachment' }] },
		})
		// The file route is the same upstream hop: the secret and the cookie strip are not lost on it.
		expect(upstream.headers?.request).toEqual(upstreamOf(defaultRoute).headers?.request)
	})

	test('an app without a download endpoint has no file route', () => {
		const plain = buildCaddyConfig({ apps: [{ ...contract, endpoints: [] }] }, OPTIONS).apps.http.servers['proxy']?.routes ?? []
		const steps = rawSubrouteOf(defined(plain[0])).routes
		expect(JSON.stringify(steps)).not.toContain('Content-Disposition')
		expect(upstreamOf(steps.at(-1)).headers?.response).toEqual({
			set: policyValues(appHeaderPolicy(contract)),
			delete: REMOVED,
		})
	})

	test('an https host carries HSTS on every answer, its downloads and its refusals included; an http host none', () => {
		const hsts = 'max-age=31536000'
		expect(upstreamOf(defaultRoute).headers?.response?.set?.['Strict-Transport-Security']).toEqual([hsts])
		const download = downloadRoute?.handle.at(-1)
		if (download?.handler !== 'reverse_proxy') throw new Error('expected the upstream')
		expect(download.headers?.response?.set?.['Strict-Transport-Security']).toEqual([hsts])
		expect(policyValues(policy)['Strict-Transport-Security']).toEqual([hsts])
		// An http entry sets none and deletes the application's own, on an answer and a download.
		const local = rawSubrouteOf(defined(buildCaddyConfig({ apps: [{ ...contract, scheme: 'http' }] }, OPTIONS).apps.http.servers['proxy']?.routes[0]))
			.routes.slice(-2)
		for (const route of local) {
			const response = upstreamOf(route).headers?.response
			expect(response?.set?.['Strict-Transport-Security']).toBeUndefined()
			expect(response?.delete).toContain('Strict-Transport-Security')
		}
		expect(upstreamOf(defaultRoute).headers?.response?.delete).not.toContain('Strict-Transport-Security')
		expect(policyValues(FILE_TREATMENT)['Strict-Transport-Security']).toBeUndefined()
	})

	test("Caddy's own failures answer with the host's policy, a download's with its file treatment, any other host's with the base", () => {
		const errors = buildCaddyConfig({ apps: [contract, defined(MANIFEST.apps[0])] }, OPTIONS).apps.http.servers['proxy']?.errors?.routes
		const failure = (headers: HeaderPolicy): CaddyStaticResponseHandler => ({
			handler: 'static_response',
			status_code: '{http.error.status_code}',
			headers: policyValues(headers),
		})
		// A navigation reads the page of an application that does not answer; a download never does, because its file
		// treatment would save the page as a file.
		const failureOrPage = (headers: HeaderPolicy) => [failurePageOr(headers, failure(headers))]
		expect(errors).toEqual([
			{
				match: [{ host: ['notes.example.com'], header: { [ENDPOINT_HEADER]: ['files.avatar.download@*'] } }],
				handle: [failure(appFileTreatment(contract))],
				terminal: true,
			},
			{ match: [{ host: ['notes.example.com'] }], handle: failureOrPage(policy), terminal: true },
			{ handle: failureOrPage(BASE_HEADER_POLICY) },
		])
	})

	test("an installation entry's answers are passed through: the policy is a contract application's", () => {
		const steps = rawSubrouteOf(defined(installationRoute)).routes
		expect(proxyHandler(steps.at(-1)).headers?.response).toBeUndefined()
		expect(JSON.stringify(steps)).not.toContain('status_code":[1]')
		expect(steps[0]?.handle).toEqual([refusal(400, 'bad request', BASE_HEADER_POLICY)])
	})
})

describe('an installation entry — the hop of an installation service', () => {
	const resource = {
		resource: 'https://console.example.com/mcp',
		resourceMetadata: 'https://console.example.com/.well-known/oauth-protected-resource/mcp',
		authorizationServers: ['https://iam.example.com'],
		scopesSupported: ['authoring'],
	}
	const entry: InstallationProxyApp = {
		id: 'vozka',
		hosts: ['console.example.com'],
		upstream: 'control:3000',
		scheme: 'https',
		installation: true,
		endpoints: [
			installationRow({ id: 'admin', kind: 'protocol', method: '*', path: '/admin/*', callers: [], requirement: null, admission: null, oauth: null }),
		],
		reservedPrefixes: [],
		oauthResources: [resource],
	}
	const route = buildCaddyConfig({ apps: [entry] }, OPTIONS).apps.http.servers['proxy']?.routes[0]
	if (route === undefined) throw new Error('expected an app route')
	const raw = rawSubrouteOf(route).routes
	const steps = subrouteOf(route).routes
	const placeholder = (header: string) => `{http.reverse_proxy.header.${header}}`

	test('keeps the Authorization header on every allow: the service reads its own credential on a protocol row', () => {
		const auth = proxyHandler(steps[2])
		expect(auth.rewrite?.uri).toBe('/verify?app=vozka')
		expect(JSON.stringify(auth.handle_response)).not.toContain('Authorization')
	})

	test('copies the endpoint the decision selected, from a 2xx only and only when set', () => {
		expect(proxyHandler(steps[2]).handle_response?.[0]?.routes).toContainEqual({
			match: [{ not: [{ vars: { [placeholder(ENDPOINT_HEADER)]: [''] } }] }],
			handle: [{ handler: 'headers', request: { set: { [ENDPOINT_HEADER]: [placeholder(ENDPOINT_HEADER)] } } }],
		})
		const first = steps[0]?.handle[0]
		if (first?.handler !== 'headers') throw new Error('expected a headers handler')
		expect(first.request?.delete).toContain(ENDPOINT_HEADER)
	})

	test('sets no proxy secret and no response policy; its own refusal carries the base policy', () => {
		const upstream = upstreamOf(steps.at(-1))
		expect(upstream.upstreams).toEqual([{ dial: 'control:3000' }])
		expect(upstream.headers?.response).toBeUndefined()
		expect(upstream.headers?.request?.set).toBeUndefined()
		expect(JSON.stringify(steps.slice(1))).not.toContain(PROXY_SECRET_HEADER)
		expect(JSON.stringify(raw)).not.toContain('status_code":[1]')
		expect(raw[0]?.handle).toEqual([refusal(400, 'bad request', BASE_HEADER_POLICY)])
	})

	test('answers its RFC 9728 metadata path at the auth service before forward_auth', () => {
		expect(steps[1]?.match).toEqual([{ path: ['/.well-known/oauth-protected-resource/mcp'] }])
		expect(proxyHandler(steps[1]).rewrite).toEqual({ method: 'GET', uri: '/oauth-metadata?app=vozka' })
		expect(proxyHandler(steps[1]).handle_response).toBeUndefined()
	})
})
