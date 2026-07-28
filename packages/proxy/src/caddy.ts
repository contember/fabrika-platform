/**
 * Caddy configuration generation, emitted as **JSON** — Caddy's native format, and the one the admin
 * API would consume. A Caddyfile would have to be parsed by Caddy before it meant anything; JSON is
 * what it means.
 *
 * ── Why gate rules are NOT compiled into Caddy routes ─────────────────────────────────────────────
 *
 * The obvious design is one Caddy route per gate rule, relying on Caddy's first-match-wins route
 * evaluation to reproduce `AppGates`' first-match-wins precedence. It was checked against Caddy
 * v2.10.2's source rather than assumed, and it does not hold. Three independent reasons:
 *
 *  1. **Fall-through is not expressible.** A `service` rule whose credential is ABSENT falls through
 *     to the next matching rule; a `human` rule falls through when the session is missing OR invalid.
 *     "Invalid" is only knowable after an IAM exchange and a signature check. A Caddy matcher runs
 *     before any of that, so the fall-through arm of the gate semantics has no encoding.
 *  2. **`path` is case-insensitive.** `MatchPath.Match` lower-cases both the pattern and the request
 *     path ("we do case-insensitive matching to mitigate security issues"). `AppGates`' glob is
 *     case-sensitive. `/Admin/*` would gate a different set of requests in the two engines.
 *  3. **`*` stops at `/`.** For a pattern with an interior wildcard Caddy falls back to Go's
 *     `path.Match`, whose `*` does not cross a path separator; the SDK's glob compiles `*` to `.*`,
 *     which does. A pattern of `/api/` + `*` + `/x` matches `/api/a/b/x` in one engine and not in the
 *     other. Caddy also
 *     normalizes the path (merging `//`) before matching; the SDK matches the raw pathname.
 *
 * Any of these mismatches turns a route split into a silent widening or narrowing of an authorization
 * rule — the failure mode with the worst blast radius available here. So the mapping is deliberately
 * trivial: **every request goes to `/verify`**, and gate evaluation happens once, in TypeScript,
 * exactly as ADR-0008 divides the work (Caddy owns HTTP correctness, the auth service owns auth).
 * Gate ORDER is preserved verbatim in the manifest the auth service reads.
 *
 * Gates still shape the generated config in one place: the access-log redaction pattern is built from
 * the declared `query` credential locations, so a credential in a URL never reaches a log file.
 */

import type { GateRule } from '@fabrika/auth-core'
import { API_KEY_PREFIX } from '@fabrika/auth-core'
import { APP_QUERY_PARAM, DEFAULT_VERIFY_PATH, FORWARDED_METHOD_HEADER, FORWARDED_URI_HEADER, PROXY_TOKEN_HEADER } from './constants'
import type { ProxyApp, ProxyManifest } from './manifest'

// ── The subset of Caddy's JSON schema we emit (field names verified against v2.10.2) ──────────────

export interface CaddyHeaderOps {
	set?: Record<string, string[]>
	delete?: string[]
}

export interface CaddyHeadersHandler {
	handler: 'headers'
	request?: CaddyHeaderOps
}

export interface CaddyStaticResponseHandler {
	handler: 'static_response'
	status_code: number
	body?: string
}

export interface CaddyVarsHandler {
	handler: 'vars'
}

export interface CaddySubrouteHandler {
	handler: 'subroute'
	routes: CaddyRoute[]
}

export interface CaddyResponseHandler {
	match?: { status_code?: number[] }
	routes?: CaddyRoute[]
}

export interface CaddyReverseProxyHandler {
	handler: 'reverse_proxy'
	upstreams: { dial: string }[]
	rewrite?: { method?: string; uri?: string }
	headers?: { request?: CaddyHeaderOps }
	handle_response?: CaddyResponseHandler[]
}

export type CaddyHandler =
	| CaddyHeadersHandler
	| CaddyReverseProxyHandler
	| CaddyStaticResponseHandler
	| CaddySubrouteHandler
	| CaddyVarsHandler

/** A matcher set. Only the matchers we emit are typed; matchers within a set are AND-ed. */
export interface CaddyMatcherSet {
	host?: string[]
	path?: string[]
	not?: CaddyMatcherSet[]
	vars?: Record<string, string[]>
}

export interface CaddyRoute {
	match?: CaddyMatcherSet[]
	handle: CaddyHandler[]
	terminal?: boolean
}

export interface CaddyServer {
	listen: string[]
	routes: CaddyRoute[]
	automatic_https?: { disable: boolean }
	logs?: { should_log_credentials: boolean }
}

export interface CaddyLogFilter {
	filter: string
	regexp?: string
	value?: string
}

export interface CaddyConfig {
	admin: { disabled: boolean }
	logging: {
		logs: Record<string, {
			encoder: { format: string; wrap?: { format: string }; fields?: Record<string, CaddyLogFilter> }
			level?: string
		}>
	}
	apps: { http: { servers: Record<string, CaddyServer> } }
}

// ── Generation ─────────────────────────────────────────────────────────────────

export interface CaddyBuildOptions {
	/** Where the auth service listens, e.g. `127.0.0.1:9000`. Loopback: it must never be routable. */
	authUpstream: string
	/** Public listener. The Zerops L7 balancer terminates TLS, so this is plain HTTP. */
	listen?: string[]
	/** Internal listener carrying only the health route, so no health path shadows an app path. */
	healthListen?: string[]
	/** Must equal the auth service's `verifyPath`. Default `/verify`. */
	verifyPath?: string
	/** Header the token is copied upstream in. Must equal the auth service's `tokenHeader`. */
	tokenHeader?: string
	/** Health route path on `healthListen`. Default `/healthz`. */
	healthPath?: string
}

/** Thrown when a manifest cannot be turned into a config that routes deterministically. */
export class CaddyConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CaddyConfigError'
	}
}

export function buildCaddyConfig(manifest: ProxyManifest, options: CaddyBuildOptions): CaddyConfig {
	const listen = options.listen ?? [':8080']
	const healthListen = options.healthListen ?? [':8081']
	const verifyPath = options.verifyPath ?? DEFAULT_VERIFY_PATH
	const tokenHeader = options.tokenHeader ?? PROXY_TOKEN_HEADER
	const healthPath = options.healthPath ?? '/healthz'

	assertUniqueHosts(manifest)

	const routes = manifest.apps.map((app) => appRoute(app, options.authUpstream, verifyPath, tokenHeader))
	// Nothing falls off the end: an unmatched Host is a 404, never a pass-through to anything.
	routes.push({ handle: [{ handler: 'static_response', status_code: 404, body: 'not found' }] })

	return {
		// ADR-0008 keeps the proxy thin and stateless, and `docs/backlog/08` chose redeploy over live
		// config push. With no push there is no reason to expose a mutation surface in front of every app.
		admin: { disabled: true },
		logging: {
			logs: {
				default: {
					encoder: {
						format: 'filter',
						wrap: { format: 'json' },
						fields: logFieldFilters(manifest, tokenHeader),
					},
				},
			},
		},
		apps: {
			http: {
				servers: {
					proxy: {
						listen,
						// The project's L7 balancer terminates TLS, so Caddy needs no ACME, no cert
						// storage and no disk (docs/reference/zerops-platform.md).
						automatic_https: { disable: true },
						logs: { should_log_credentials: false },
						routes,
					},
					// The liveness probe lives on its OWN listener, which is never published. Putting it on
					// the public listener would mean one path per proxy that shadows an app's path and
					// answers 200 without consulting the gates.
					health: {
						listen: healthListen,
						automatic_https: { disable: true },
						routes: [
							{ match: [{ path: [healthPath] }], handle: [{ handler: 'static_response', status_code: 200, body: 'ok' }] },
							{ handle: [{ handler: 'static_response', status_code: 404 }] },
						],
					},
				},
			},
		},
	}
}

/**
 * One app = one host-matched, terminal route whose subroute is a fixed three-step chain:
 *
 *   1. `headers` — DELETE the token header from the inbound request. Load-bearing: Caddy's
 *      `copy_headers` only sets the header when the auth response's value is non-empty, so on a
 *      `public` path (which mints no token) a client-supplied header would otherwise survive all the
 *      way to the app. The app's SDK verifies the signature, so a forged one would be rejected — but
 *      the proxy must not be the thing relying on that.
 *   2. `reverse_proxy` to the auth service — the `forward_auth` expansion.
 *   3. `reverse_proxy` to the app. Reached only when step 2 answered 2xx; any other status was
 *      already written to the client.
 */
function appRoute(app: ProxyApp, authUpstream: string, verifyPath: string, tokenHeader: string): CaddyRoute {
	return {
		match: [{ host: app.hosts }],
		terminal: true,
		handle: [{
			handler: 'subroute',
			routes: [
				{ handle: [{ handler: 'headers', request: { delete: [tokenHeader] } }] },
				{ handle: [forwardAuth(app, authUpstream, verifyPath, tokenHeader)] },
				{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: app.upstream }] }] },
			],
		}],
	}
}

/**
 * The `forward_auth` directive, expanded by hand. Matches what
 * `forwardauth/caddyfile.go` produces for:
 *
 *   forward_auth <authUpstream> { uri <verifyPath>?app=<id>; copy_headers <tokenHeader> }
 *
 * including the no-op `vars` route (reverse_proxy skips a `handle_response` entry with no routes) and
 * the `not vars ""` guard on the copy (the headers handler would otherwise write an empty value).
 */
function forwardAuth(app: ProxyApp, authUpstream: string, verifyPath: string, tokenHeader: string): CaddyReverseProxyHandler {
	const placeholder = `{http.reverse_proxy.header.${tokenHeader}}`
	return {
		handler: 'reverse_proxy',
		upstreams: [{ dial: authUpstream }],
		// The route already knows which app it fronts — pin it rather than have the auth service
		// re-derive it from a header the client can influence.
		rewrite: { method: 'GET', uri: `${verifyPath}?${APP_QUERY_PARAM}=${encodeURIComponent(app.id)}` },
		headers: {
			request: {
				set: {
					[FORWARDED_METHOD_HEADER]: ['{http.request.method}'],
					[FORWARDED_URI_HEADER]: ['{http.request.uri}'],
				},
			},
		},
		handle_response: [{
			match: { status_code: [2] },
			routes: [
				{ handle: [{ handler: 'vars' }] },
				{
					match: [{ not: [{ vars: { [placeholder]: [''] } }] }],
					handle: [{ handler: 'headers', request: { set: { [tokenHeader]: [placeholder] } } }],
				},
			],
		}],
	}
}

/**
 * Access-log redaction. `should_log_credentials: false` already keeps `Cookie` / `Set-Cookie` /
 * `Authorization` out, but the injected token header is not in Caddy's credentials list and the
 * request URI is logged verbatim — and a URI can carry a share-link `px_` token in the path or a
 * declared `query` credential.
 */
function logFieldFilters(manifest: ProxyManifest, tokenHeader: string): Record<string, CaddyLogFilter> {
	return {
		[`request>headers>${tokenHeader}`]: { filter: 'delete' },
		'request>headers>Cookie': { filter: 'delete' },
		'request>headers>Authorization': { filter: 'delete' },
		'response>headers>Set-Cookie': { filter: 'delete' },
		'request>uri': { filter: 'regexp', regexp: uriRedactionPattern(manifest), value: 'REDACTED' },
	}
}

/**
 * An RE2 alternation covering every way a credential can appear in a URI: an opaque `px_` token
 * anywhere (share links ride in the path), plus `?<name>=…` for each `query` credential location any
 * app declares. Deterministic: names are de-duplicated and sorted, so the config is stable across runs.
 */
export function uriRedactionPattern(manifest: ProxyManifest): string {
	const names = new Set<string>()
	for (const app of manifest.apps) {
		for (const rule of app.gates.rules) {
			const name = queryCredentialName(rule)
			if (name !== null) {
				names.add(name)
			}
		}
	}
	const alternatives = [`${API_KEY_PREFIX}[A-Za-z0-9_.\\-]+`]
	for (const name of [...names].sort()) {
		alternatives.push(`[?&]${escapeRe2(name)}=[^&]*`)
	}
	return alternatives.join('|')
}

function queryCredentialName(rule: GateRule): string | null {
	return rule.kind === 'service' && rule.credential !== undefined && rule.credential.in === 'query' ? rule.credential.name : null
}

function escapeRe2(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Two apps on one host would make Caddy's route order — not the manifest — decide which app answers. */
function assertUniqueHosts(manifest: ProxyManifest): void {
	const seen = new Map<string, string>()
	for (const app of manifest.apps) {
		for (const host of app.hosts) {
			const key = host.toLowerCase()
			const owner = seen.get(key)
			if (owner !== undefined) {
				throw new CaddyConfigError(`host '${key}' is claimed by both '${owner}' and '${app.id}'`)
			}
			seen.set(key, app.id)
		}
	}
}
