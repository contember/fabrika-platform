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

import type { AppGates } from '@fabrika/auth-core'
import type { ProxyManifest } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import {
	buildCaddyConfig,
	CaddyConfigError,
	type CaddyReverseProxyHandler,
	type CaddyRoute,
	type CaddySubrouteHandler,
	uriRedactionPattern,
} from '../caddy'
import { CLIENT_ADDRESS_HEADER, PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, UNTRUSTED_FORWARD_HEADERS } from '../constants'

const GATES: AppGates = { rules: [{ path: '/public/*', kind: 'public' }, { path: '/*', kind: 'human' }] }

const MANIFEST: ProxyManifest = {
	apps: [
		{ id: 'app-one', hosts: ['one.example.com'], upstream: 'one:3000', scheme: 'https', gates: GATES },
		{
			id: 'app-two',
			hosts: ['two.example.com', 'alias.example.com'],
			upstream: 'two:8080',
			scheme: 'https',
			gates: { rules: [{ path: '/*', kind: 'service' }] },
		},
	],
}

const OPTIONS = { authUpstream: '127.0.0.1:9000' }

function subrouteOf(route: CaddyRoute): CaddySubrouteHandler {
	const handler = route.handle[0]
	if (handler === undefined || handler.handler !== 'subroute') {
		throw new Error('expected a subroute')
	}
	return handler
}

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
		expect(routes[2]?.handle[0]).toEqual({ handler: 'static_response', status_code: 404, body: 'not found' })
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
				{ id: 'a', hosts: ['same.example.com'], upstream: 'a:1', scheme: 'https', gates: { rules: [] } },
				{ id: 'b', hosts: ['SAME.example.com'], upstream: 'b:1', scheme: 'https', gates: { rules: [] } },
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
			const first = subrouteOf(route).routes[0]?.handle[0]
			// The token, or a `public` path would carry a client's own to the app; the request id, which is
			// written to IAM's auth log and audit trail; and every name a client address travels under, so
			// the only one an upstream can read is the one this hop writes below. Deletes run BEFORE sets
			// within one HeaderOps (caddyhttp/headers.go ApplyTo, v2.10.2), which is why both fit in one
			// handler. The token and the request id are restored from the decision.
			expect(first).toEqual({
				handler: 'headers',
				request: {
					delete: [PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, CLIENT_ADDRESS_HEADER, ...UNTRUSTED_FORWARD_HEADERS],
					set: { [CLIENT_ADDRESS_HEADER]: ['{http.request.client_ip}'] },
				},
			})
		}
	})

	test('a caller cannot choose the client coordinate on any of the names it travels under', () => {
		// The spoofing test for THIS composition. Caddy's own `client_ip` is the only source: it is
		// resolved in PrepareRequest, before any handler runs, from the socket peer and — only for a peer
		// inside `trusted_proxies` — the client-IP header chain. So the injected value cannot be a
		// caller's, and every name a caller could have used to smuggle one is deleted first.
		const ops = subrouteOf(routes[0] as CaddyRoute).routes[0]?.handle[0]
		if (ops === undefined || ops.handler !== 'headers') throw new Error('expected a headers handler')
		for (const spoofable of [CLIENT_ADDRESS_HEADER, ...UNTRUSTED_FORWARD_HEADERS]) {
			expect(ops.request?.delete).toContain(spoofable)
		}
		expect(ops.request?.set?.[CLIENT_ADDRESS_HEADER]).toEqual(['{http.request.client_ip}'])
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
			if (route.handle[0]?.handler !== 'subroute') {
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

describe('access-log redaction', () => {
	test('the token header, Cookie and Authorization are deleted from log records', () => {
		const fields = buildCaddyConfig(MANIFEST, OPTIONS).logging.logs['default']?.encoder.fields ?? {}
		expect(fields[`request>headers>${PROXY_TOKEN_HEADER}`]).toEqual({ filter: 'delete' })
		// Not a credential — dropped because the record already carries Caddy's own `client_ip` field.
		expect(fields[`request>headers>${CLIENT_ADDRESS_HEADER}`]).toEqual({ filter: 'delete' })
		expect(fields['request>headers>Cookie']).toEqual({ filter: 'delete' })
		expect(fields['request>headers>Authorization']).toEqual({ filter: 'delete' })
	})

	test('credentials cannot survive in the logged URI', () => {
		const withQueryCredential: ProxyManifest = {
			apps: [{
				id: 'a',
				hosts: ['a.example.com'],
				upstream: 'a:1',
				scheme: 'https',
				gates: { rules: [{ path: '/s/*', kind: 'service', credential: { in: 'query', name: 'pxt' } }] },
			}],
		}
		const pattern = new RegExp(uriRedactionPattern(withQueryCredential), 'g')
		expect('/s/px_abc123?pxt=deadbeef'.replace(pattern, 'REDACTED')).toBe('/s/REDACTEDREDACTED')
		// A path that carries no credential is untouched.
		expect('/api/v1/items?page=2'.replace(pattern, 'REDACTED')).toBe('/api/v1/items?page=2')
	})

	test('the ADR-0021 handoff code is redacted on every app, declared or not', () => {
		// The code is a bare random token on a reserved path — no `px_` prefix, no gate rule to declare
		// it — so it is only ever caught by an unconditional alternative.
		const pattern = new RegExp(uriRedactionPattern(MANIFEST), 'g')
		expect('/__fabrika/auth/callback?code=deadbeef'.replace(pattern, 'REDACTED')).toBe('/__fabrika/auth/callbackREDACTED')
		expect('/__fabrika/auth/callback?code=deadbeef&x=1'.replace(pattern, 'REDACTED')).toBe('/__fabrika/auth/callbackREDACTED&x=1')
	})

	test('a Location is filtered with the same pattern, and covers the login bounce', () => {
		const fields = buildCaddyConfig(MANIFEST, OPTIONS).logging.logs['default']?.encoder.fields ?? {}
		// `resp_headers`, NOT `response>headers`: that is the log record's own field path (verified
		// against caddy 2.10.2), and a misspelled one is ignored rather than rejected.
		const filter = fields['resp_headers>Location']
		expect(filter?.filter).toBe('regexp')
		expect(filter?.regexp).toBe(uriRedactionPattern(MANIFEST))

		const pattern = new RegExp(filter?.regexp ?? '', 'g')
		// IAM's 302 to the reserved callback — the proxy fronts IAM too.
		expect('https://app.example.com/__fabrika/auth/callback?code=SECRET'.replace(pattern, 'REDACTED'))
			.not.toContain('SECRET')
		// The login bounce percent-encodes the whole original URL, credential and all, into `redirect`.
		const bounce = `https://iam.test/auth/login?app=a&redirect=${encodeURIComponent('https://app.example.com/s/x?pxt=SECRET')}`
		expect(bounce.replace(pattern, 'REDACTED')).not.toContain('SECRET')
	})

	test('the pattern is deterministic across manifests with the same gates', () => {
		expect(uriRedactionPattern(MANIFEST)).toBe(uriRedactionPattern(MANIFEST))
	})

	test('Caddy is told not to log credentials', () => {
		expect(buildCaddyConfig(MANIFEST, OPTIONS).apps.http.servers['proxy']?.logs?.should_log_credentials).toBe(false)
	})
})
