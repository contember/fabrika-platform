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
 * Gates still shape the generated config in one place: the access-log redaction pattern extends its
 * fixed alternatives with the declared `query` credential locations, so a credential in a URL never
 * reaches a log file.
 */

import type { GateRule } from '@fabrika/auth-core'
import { API_KEY_PREFIX, AUTH_CODE_PARAM } from '@fabrika/auth-core'
import type { ProxyApp, ProxyManifest } from '@fabrika/proxy-contract'
import {
	APP_QUERY_PARAM,
	CLIENT_ADDRESS_HEADER,
	DEFAULT_VERIFY_PATH,
	FORWARDED_METHOD_HEADER,
	FORWARDED_URI_HEADER,
	LOGIN_REDIRECT_PARAM,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	UNTRUSTED_FORWARD_HEADERS,
} from './constants'

/**
 * Caddy's own answer to "who is the client", resolved ONCE per request in `PrepareRequest` — before
 * any handler runs — from the socket peer and, only for a peer inside `trusted_proxies`, the
 * `client_ip_headers` chain (verified against caddy v2.10.2 `caddyhttp/server.go`). Because it is
 * resolved before handlers, the ingress strip below cannot affect it.
 *
 * With no `trusted_proxies` it IS the socket peer, which behind a balancer is the balancer — every
 * client collapses into one bucket, which is exactly today's behaviour and the safe fallback.
 */
const CLIENT_IP_PLACEHOLDER = '{http.request.client_ip}'

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

/** `http.ip_sources.static` — the only `IPRangeSource` Caddy ships (`caddyhttp/ip_range.go`). */
export interface CaddyStaticIpSource {
	source: 'static'
	ranges: string[]
}

export interface CaddyServer {
	listen: string[]
	routes: CaddyRoute[]
	automatic_https?: { disable: boolean }
	logs?: { should_log_credentials: boolean }
	trusted_proxies?: CaddyStaticIpSource
	/** `1` parses the client-IP header right-to-left, stopping at the first untrusted hop. */
	trusted_proxies_strict?: number
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
	/** Health route path on `healthListen`. Default `/healthz`. */
	healthPath?: string
	/**
	 * CIDR ranges of the balancer(s) in front of this proxy, so `{http.request.client_ip}` resolves to
	 * the real client instead of the socket peer. **Empty by default, and that default is a decision:**
	 * whether the Zerops project balancer appends a forwarded address a downstream may trust is a
	 * live-account question nobody has settled, and trusting the wrong range turns the per-client limit
	 * into a caller-chosen one. Unset → every client shares the balancer's bucket, which is what
	 * happens today.
	 *
	 * Setting this has a second, documented effect: Caddy's `reverse_proxy` RETAINS a client-supplied
	 * `X-Forwarded-Host`/`-Proto` when the immediate peer is trusted (`addForwardedHeaders`, v2.10.2).
	 * The proxy already defends both — a pinned `?app=` is cross-checked against the app's declared
	 * hosts, and the login bounce takes its scheme from the manifest — but nothing else may start
	 * trusting those two.
	 */
	trustedProxies?: readonly string[]
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
	const healthPath = options.healthPath ?? '/healthz'

	assertUniqueHosts(manifest)

	const trustedProxies = (options.trustedProxies ?? []).map((range) => range.trim()).filter((range) => range !== '')
	const routes = manifest.apps.map((app) => appRoute(app, options.authUpstream))
	// Nothing falls off the end: an unmatched Host is a 404, never a pass-through to anything.
	routes.push({ handle: [{ handler: 'static_response', status_code: 404, body: 'not found' }] })

	return {
		// ADR-0022 keeps the proxy thin and stateless, and `docs/archive/08` chose redeploy over live
		// config push. With no push there is no reason to expose a mutation surface in front of every app.
		admin: { disabled: true },
		logging: {
			logs: {
				default: {
					encoder: {
						format: 'filter',
						wrap: { format: 'json' },
						fields: logFieldFilters(manifest),
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
						// Omitted entirely when no range is configured: an empty `ranges` list would still
						// register the module, and the absent key is what makes `client_ip` the socket peer.
						...(trustedProxies.length === 0
							? {}
							: { trusted_proxies: { source: 'static', ranges: trustedProxies }, trusted_proxies_strict: 1 }),
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
 *   1. `headers` — DELETE the headers a client must not be able to assert from the inbound request,
 *      then SET the one coordinate only this hop can know. Deletes run before sets within one
 *      `HeaderOps` (`caddyhttp/headers.go` `ApplyTo`, v2.10.2), so the two live in one handler.
 *
 *      Deleted: the injected TOKEN header, the REQUEST ID, the CLIENT ADDRESS, and the caller's
 *      forwarding headers. Load-bearing for the token: Caddy's `copy_headers` only sets the header
 *      when the auth response's value is non-empty, so on a `public` path (which mints no token) a
 *      client-supplied header would otherwise survive all the way to the app. The app's SDK verifies
 *      the signature, so a forged one would be rejected — but the proxy must not be the thing relying
 *      on that. The request id is the same rule one level down: it is written to IAM's `auth_log` and
 *      `audit_events`, so only the proxy may mint one. Both are put back from the auth response on a
 *      2xx, so nothing downstream loses a header.
 *
 *      Set: the client address, from Caddy's own `client_ip`. This is the whole of WU-C on this
 *      composition — the coordinate an upstream (IAM, whose public surface the platform proxy fronts)
 *      keys a per-client abuse limit on. It is written unconditionally, so a caller's value is
 *      replaced whether or not it was deleted, and it is never read back from the auth response: it
 *      describes the request as the EDGE saw it, and no inner hop gets a vote.
 *   2. `reverse_proxy` to the auth service — the `forward_auth` expansion.
 *   3. `reverse_proxy` to the app. Reached only when step 2 answered 2xx; any other status was
 *      already written to the client.
 */
function appRoute(app: ProxyApp, authUpstream: string): CaddyRoute {
	return {
		match: [{ host: app.hosts }],
		terminal: true,
		handle: [{
			handler: 'subroute',
			routes: [
				{
					handle: [{
						handler: 'headers',
						request: {
							delete: [PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, CLIENT_ADDRESS_HEADER, ...UNTRUSTED_FORWARD_HEADERS],
							set: { [CLIENT_ADDRESS_HEADER]: [CLIENT_IP_PLACEHOLDER] },
						},
					}],
				},
				{ handle: [forwardAuth(app, authUpstream)] },
				{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: app.upstream }] }] },
			],
		}],
	}
}

/**
 * The `forward_auth` directive, expanded by hand. Matches what
 * `forwardauth/caddyfile.go` produces for:
 *
 *   forward_auth <authUpstream> { uri /verify?app=<id>; copy_headers <tokenHeader> <requestIdHeader> }
 *
 * including the no-op `vars` route (reverse_proxy skips a `handle_response` entry with no routes) and
 * the `not vars ""` guard on the copy (the headers handler would otherwise write an empty value).
 */
function forwardAuth(app: ProxyApp, authUpstream: string): CaddyReverseProxyHandler {
	return {
		handler: 'reverse_proxy',
		upstreams: [{ dial: authUpstream }],
		// The route already knows which app it fronts — pin it rather than have the auth service
		// re-derive it from a header the client can influence.
		rewrite: { method: 'GET', uri: `${DEFAULT_VERIFY_PATH}?${APP_QUERY_PARAM}=${encodeURIComponent(app.id)}` },
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
				copyResponseHeader(PROXY_TOKEN_HEADER),
				copyResponseHeader(REQUEST_ID_HEADER),
			],
		}],
	}
}

function copyResponseHeader(header: string): CaddyRoute {
	const placeholder = `{http.reverse_proxy.header.${header}}`
	return {
		match: [{ not: [{ vars: { [placeholder]: [''] } }] }],
		handle: [{ handler: 'headers', request: { set: { [header]: [placeholder] } } }],
	}
}

/**
 * Access-log redaction. `should_log_credentials: false` already keeps `Cookie` / `Set-Cookie` /
 * `Authorization` out, but the injected token header is not in Caddy's credentials list, and the
 * request URI and the response `Location` are both logged verbatim — and either can carry a
 * credential: a share-link `px_` token in the path, a declared `query` credential, or the ADR-0021
 * handoff code. The URI and `Location` share one pattern, because a credential is the same string
 * wherever it appears.
 *
 * The field paths are the LOG RECORD's, not the config's: request fields nest under `request>…` but
 * response headers are a top-level `resp_headers` object. Verified against a running caddy 2.10.2 —
 * a misspelled path is silently ignored, which is exactly how a redaction quietly stops happening.
 */
function logFieldFilters(manifest: ProxyManifest): Record<string, CaddyLogFilter> {
	const pattern = uriRedactionPattern(manifest)
	return {
		[`request>headers>${PROXY_TOKEN_HEADER}`]: { filter: 'delete' },
		// Not a credential — dropped because Caddy's record already carries `client_ip` natively, and one
		// copy of a client address per line is enough.
		[`request>headers>${CLIENT_ADDRESS_HEADER}`]: { filter: 'delete' },
		'request>headers>Cookie': { filter: 'delete' },
		'request>headers>Authorization': { filter: 'delete' },
		'resp_headers>Set-Cookie': { filter: 'delete' },
		'request>uri': { filter: 'regexp', regexp: pattern, value: 'REDACTED' },
		// `Location` carries two credentials of its own — IAM's 302 to the reserved callback with the
		// handoff code (the platform proxy fronts IAM), and the proxy's own login bounce — and unlike
		// `Set-Cookie` it is NOT in Caddy's credentials list, so nothing else covers it.
		'resp_headers>Location': { filter: 'regexp', regexp: pattern, value: 'REDACTED' },
	}
}

/**
 * An RE2 alternation covering every way a credential can appear in a URI or a `Location`:
 *
 *   - an opaque `px_` token anywhere — share links ride in the path;
 *   - the ADR-0021 handoff `?code=…`. UNCONDITIONAL: the reserved callback exists on every app host,
 *     the code is a bare `randomToken(32)` with no `px_` prefix, and it is not a declared credential,
 *     so nothing else in this file would ever contribute it;
 *   - `?redirect=…`, the login bounce's return URL. It is not itself a credential, it is a carrier:
 *     the whole original URL is percent-encoded into it, so a declared `query` credential re-appears
 *     as `%3Fpxt%3D…` after being stripped from the logged URI;
 *   - `?<name>=…` for each `query` credential location any app declares.
 *
 * Deterministic: names are de-duplicated and sorted, so the config is stable across runs.
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
	const alternatives = [
		`${API_KEY_PREFIX}[A-Za-z0-9_.\\-]+`,
		`[?&]${escapeRe2(AUTH_CODE_PARAM)}=[^&]*`,
		`[?&]${escapeRe2(LOGIN_REDIRECT_PARAM)}=[^&]*`,
	]
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

/**
 * Two apps on one host would make Caddy's route order — not the manifest — decide which app answers.
 * `parseProxyManifest` refuses such a manifest outright; this stays for the error MESSAGE, which names
 * both claimants, and for a producer that hands us a typed manifest without parsing one.
 */
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
