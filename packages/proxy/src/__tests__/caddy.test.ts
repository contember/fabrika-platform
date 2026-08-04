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
import { PROXY_TOKEN_HEADER, REQUEST_ID_HEADER } from '../constants'

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

	test('every app route strips the injected token header BEFORE anything else', () => {
		for (const route of routes.slice(0, 2)) {
			const first = subrouteOf(route).routes[0]?.handle[0]
			expect(first).toEqual({ handler: 'headers', request: { delete: [PROXY_TOKEN_HEADER] } })
		}
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

	test('the pattern is deterministic across manifests with the same gates', () => {
		expect(uriRedactionPattern(MANIFEST)).toBe(uriRedactionPattern(MANIFEST))
	})

	test('Caddy is told not to log credentials', () => {
		expect(buildCaddyConfig(MANIFEST, OPTIONS).apps.http.servers['proxy']?.logs?.should_log_credentials).toBe(false)
	})
})
