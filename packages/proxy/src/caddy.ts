/**
 * Caddy configuration generation, emitted as **JSON** — Caddy's native format, and the one the admin
 * API would consume. A Caddyfile would have to be parsed by Caddy before it meant anything; JSON is
 * what it means.
 *
 * ── Why endpoint tables are NOT compiled into Caddy routes ───────────────────────────────────────
 *
 * The obvious design is one Caddy route per endpoint row. It does not hold against Caddy v2.10.2's
 * source: `MatchPath.Match` lower-cases both the pattern and the request path, an interior `*` falls
 * back to Go's `path.Match`, which does not cross a path separator, and Caddy merges `//` before
 * matching, while `planEndpoint` reads the raw, case-sensitive path and selects the most specific row.
 * Any mismatch turns a route split into a silent widening or narrowing of an authorization rule. So
 * the mapping is deliberately trivial: **every request goes to `/verify`**, and the endpoint is
 * planned once, in TypeScript, exactly as ADR-0022 divides the work (Caddy owns HTTP correctness, the
 * auth service owns auth).
 */

import {
	API_KEY_PREFIX,
	AUTH_CODE_PARAM,
	FABRIKA_COOKIE_PREFIX,
	FABRIKA_HOP_HEADERS,
	PROXY_SECRET_HEADER,
	proxySecretVariable,
	SESSION_COOKIE,
} from '@fabrika/auth-core'
import {
	APP_QUERY_PARAM,
	CLIENT_ADDRESS_HEADER,
	DEFAULT_VERIFY_PATH,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_URI_HEADER,
	LOGIN_REDIRECT_PARAM,
	OAUTH_METADATA_VERIFY_PATH,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/proxy-core'
import {
	appHeaderPolicy,
	BASE_HEADER_POLICY,
	FILE_TREATMENT,
	type HeaderPolicy,
	INLINE_FILE_TYPES,
	REMOVED_RESPONSE_HEADERS,
} from '@fabrika/proxy-core/headers'
import { type ContractProxyApp, isApplicationEntry, isProxyHost, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'

/**
 * Caddy's own answer to "who is the client", resolved ONCE per request in `PrepareRequest` — before
 * any handler runs — from the socket peer and, only for a peer inside `trusted_proxies`, the
 * `client_ip_headers` chain (verified against caddy v2.10.2 `caddyhttp/server.go`). Because it is
 * resolved before handlers, the ingress strip below cannot affect it.
 *
 * With no `trusted_proxies` it IS the socket peer, which behind a balancer is the balancer — every
 * client collapses into one bucket, which is exactly today's behaviour and the safe fallback. It is a
 * request VAR (`ClientIPVarKey`); `{http.request.client_ip}` is no placeholder and is sent literally.
 */
const CLIENT_IP_PLACEHOLDER = '{http.vars.client_ip}'

// ── The subset of Caddy's JSON schema we emit (field names verified against v2.10.2) ──────────────

export interface CaddyHeaderOps {
	set?: Record<string, string[]>
	delete?: string[]
	replace?: Record<string, CaddyHeaderReplacement[]>
}

export interface CaddyHeaderReplacement {
	search_regexp: string
	replace: string
}

/** `RespHeaderOps`: with `require` the operations wait until the response is written and run only when it matches. */
export interface CaddyResponseHeaderOps extends CaddyHeaderOps {
	/** A `null` header value matches only when that header is absent (`matchHeaders`, v2.10.2). */
	/** A one-digit `status_code` matches its class: `1` is every informational answer. */
	require?: { status_code?: number[]; headers?: Record<string, string[] | null> }
}

export interface CaddyHeadersHandler {
	handler: 'headers'
	request?: CaddyHeaderOps
	response?: CaddyResponseHeaderOps
}

export interface CaddyStaticResponseHandler {
	handler: 'static_response'
	status_code: number
	headers?: Record<string, string[]>
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
	/** `response` runs on the upstream's headers before they are copied to the client, so a `set` replaces its value. */
	headers?: { request?: CaddyHeaderOps; response?: CaddyHeaderOps }
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
	/** Exact values; a trailing `*` matches a prefix. */
	header?: Record<string, string[]>
	header_regexp?: Record<string, { pattern: string }>
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
	/** Trusted composition coordinate; only IAM's own route may receive its login cookie. */
	iamSessionOwner?: { issuer: string; upstream: string }
	/** Public listener. The Zerops L7 balancer terminates TLS, so this is plain HTTP. */
	listen?: string[]
	/** Internal listener carrying only the health route, so no health path shadows an app path. */
	healthListen?: string[]
	/** Health route path on `healthListen`. Default `/healthz`. */
	healthPath?: string
	/**
	 * CIDR ranges of the balancer(s) in front of this proxy, so `{http.vars.client_ip}` resolves to
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

function readIamSessionOwner(owner: CaddyBuildOptions['iamSessionOwner']) {
	if (owner === undefined) return undefined
	let issuer: URL
	try {
		issuer = new URL(owner.issuer)
	} catch {
		throw new CaddyConfigError('IAM session owner issuer must be an HTTP(S) origin')
	}
	if (
		owner.issuer !== owner.issuer.trim()
		|| (issuer.protocol !== 'http:' && issuer.protocol !== 'https:')
		|| issuer.username !== '' || issuer.password !== ''
		|| issuer.pathname !== '/' || issuer.search !== '' || issuer.hash !== ''
		|| !isProxyHost(issuer.hostname)
	) {
		throw new CaddyConfigError('IAM session owner issuer must be an HTTP(S) origin with a proxy hostname')
	}
	const upstream = /^([^:/\s]+|\[[0-9a-fA-F:]+\]):([0-9]+)$/.exec(owner.upstream)
	const hostname = upstream?.[1]
	const port = Number(upstream?.[2])
	if (hostname === undefined || (!hostname.startsWith('[') && !isProxyHost(hostname)) || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new CaddyConfigError('IAM session owner upstream must be a host:port dial address')
	}
	try {
		new URL(`http://${owner.upstream}`)
	} catch {
		throw new CaddyConfigError('IAM session owner upstream must be a host:port dial address')
	}
	return { hostname: issuer.hostname, scheme: issuer.protocol.slice(0, -1), upstream: owner.upstream }
}

export function buildCaddyConfig(manifest: ProxyManifest, options: CaddyBuildOptions): CaddyConfig {
	const listen = options.listen ?? [':8080']
	const healthListen = options.healthListen ?? [':8081']
	const healthPath = options.healthPath ?? '/healthz'

	assertUniqueHosts(manifest)
	const iamOwner = readIamSessionOwner(options.iamSessionOwner)

	const trustedProxies = (options.trustedProxies ?? []).map((range) => range.trim()).filter((range) => range !== '')
	const routes = manifest.apps.map((app) => {
		const ownsIamSession = iamOwner !== undefined
			&& app.hosts.length === 1
			&& app.hosts[0] === iamOwner.hostname
			&& app.scheme === iamOwner.scheme
			&& app.upstream === iamOwner.upstream
		return appRoute(app, options.authUpstream, ownsIamSession)
	})
	// Nothing falls off the end: an unmatched Host is a 404, never a pass-through to anything.
	routes.push({ handle: [{ handler: 'static_response', status_code: 404, headers: headerValues(BASE_HEADER_POLICY), body: 'not found' }] })

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
						fields: logFieldFilters(),
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
					// answers 200 without consulting the endpoint table.
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
 *   1. Refuse with 400 a `Connection` header that names a header this hop asserts
 *      (`connectionNominationPattern`). Then `headers` twice — DELETE the headers a client must not be
 *      able to assert from the inbound request, then SET the one coordinate only this hop can know. They
 *      are two handlers because within one `HeaderOps` a named delete runs AFTER the set
 *      (`caddyhttp/headers.go` `ApplyTo`, v2.10.2) and would delete the value just set.
 *
 *      Deleted: every `X-Fabrika-*` hop header (`FABRIKA_HOP_HEADERS` — the TOKEN, the CLIENT ADDRESS,
 *      the endpoint, the delegation grant, the proxy secret), the REQUEST ID, and the caller's
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
 *   2. `reverse_proxy` to the auth service — the `forward_auth` expansion. Before it, one terminal route
 *      per `oauthResources` entry sends its RFC 9728 metadata path to the auth service's metadata
 *      endpoint and returns that answer as-is, so the app never sees it. Caddy's `path` matcher is
 *      case-insensitive; the auth service compares host and raw path exactly and 404s anything else.
 *   3. `reverse_proxy` to the app. Reached only when step 2 answered 2xx; it strips every
 *      `__Host-px_*` cookie on that upstream hop, except IAM's login cookie on its owning route. For a
 *      contract app it sets the proxy secret from the variable `proxySecretVariable(app.id)`, read at
 *      request time through `{env.…}`, so the secret is in no generated file (ADR-0022 rule 5). An unset
 *      variable sends an empty secret, which the application refuses. A contract app's answer then gets
 *      the header policy, replacing whatever the app set; a download endpoint's gets the file treatment
 *      instead (`contractUpstream`).
 *
 * A contract app's own refusal in step 1 carries its policy too; step 2's denials carry the one
 * `@fabrika/proxy-core` set, because Caddy returns a non-2xx auth answer to the client as-is.
 */
function appRoute(app: ProxyApp, authUpstream: string, ownsIamSession: boolean): CaddyRoute {
	const fabrikaCookiePattern = `(?:^|;[ \\t]*)${escapeRe2(FABRIKA_COOKIE_PREFIX)}[^=;]*=[^;]*`
	// RE2 has no lookahead: the first alternative retains the exact login cookie, including its separator.
	const cookiePattern = ownsIamSession
		? `((?:^|;[ \\t]*)${escapeRe2(SESSION_COOKIE)}=[^;]*)|${fabrikaCookiePattern}`
		: fabrikaCookiePattern
	const upstream = (response?: CaddyHeaderOps): CaddyReverseProxyHandler => ({
		handler: 'reverse_proxy',
		upstreams: [{ dial: app.upstream }],
		headers: {
			request: {
				...(isApplicationEntry(app) ? { set: { [PROXY_SECRET_HEADER]: [`{env.${proxySecretVariable(app.id)}}`] } } : {}),
				replace: {
					Cookie: [
						{
							search_regexp: cookiePattern,
							replace: ownsIamSession ? '$1' : '',
						},
						{ search_regexp: '^[; \\t]+', replace: '' },
					],
				},
			},
			...(response === undefined ? {} : { response }),
		},
	})
	const policy = isApplicationEntry(app) ? appHeaderPolicy(app) : BASE_HEADER_POLICY
	return {
		match: [{ host: app.hosts }],
		terminal: true,
		handle: [{
			handler: 'subroute',
			routes: [
				{
					match: [{ header_regexp: { Connection: { pattern: connectionNominationPattern() } } }],
					handle: [{ handler: 'static_response', status_code: 400, headers: headerValues(policy), body: 'bad request' }],
					terminal: true,
				},
				{
					// Two handlers: within one `HeaderOps` Caddy runs a named delete AFTER the set.
					handle: [
						{ handler: 'headers', request: { delete: [...FABRIKA_HOP_HEADERS, REQUEST_ID_HEADER, ...UNTRUSTED_FORWARD_HEADERS] } },
						{ handler: 'headers', request: { set: { [CLIENT_ADDRESS_HEADER]: [CLIENT_IP_PLACEHOLDER] } } },
					],
				},
				...(isApplicationEntry(app) ? [] : (app.oauthResources ?? [])).map((resource): CaddyRoute => ({
					match: [{ path: [new URL(resource.resourceMetadata).pathname] }],
					handle: [authRequest(app, authUpstream, OAUTH_METADATA_VERIFY_PATH)],
					terminal: true,
				})),
				{ handle: [forwardAuth(app, authUpstream)] },
				...(isApplicationEntry(app) ? contractUpstream(app, policy, upstream) : [{ handle: [upstream()] }]),
			],
		}],
	}
}

/** A header policy as Caddy's `set` and `static_response` headers: one value per name, replacing any other. */
function headerValues(policy: HeaderPolicy): Record<string, string[]> {
	return Object.fromEntries(policy.map(([name, value]) => [name, [value]]))
}

const DISPOSITION_TYPE = '^[^;]*'

/**
 * A 1xx answer, such as `103 Early Hints`, leaves with no header at all. `reverse_proxy` forwards it before its own
 * response operations run (`Got1xxResponse`, v2.10.2), so only a deferred handler around the upstream reaches it.
 */
const INFORMATIONAL_WITHOUT_HEADERS: CaddyHeadersHandler = { handler: 'headers', response: { require: { status_code: [1] }, delete: ['*'] } }

/**
 * Step 3 of a contract app. A download endpoint is recognised by the `X-Fabrika-Endpoint` the decision asserted
 * (step 1 deleted the client's), so no path is matched here. Its answer gets the file treatment: the upstream's
 * disposition type becomes `attachment` with its parameters kept, an absent one is added, and only an inert image
 * `Content-Type` turns it back to `inline`. Repeated `Content-Type` fields are first joined into one value, which no
 * allowlisted type equals, because Caddy's matcher accepts a field when ANY of its values matches. The deferred
 * handlers wrap the upstream, so the later one in the list runs first.
 */
function contractUpstream(
	app: ContractProxyApp,
	policy: HeaderPolicy,
	upstream: (response: CaddyHeaderOps) => CaddyReverseProxyHandler,
): CaddyRoute[] {
	const downloads = app.endpoints.filter((row) => row.kind === 'download').map((row) => `${row.id}@*`)
	const download: CaddyRoute = {
		match: [{ header: { [ENDPOINT_HEADER]: downloads } }],
		terminal: true,
		handle: [
			INFORMATIONAL_WITHOUT_HEADERS,
			{
				handler: 'headers',
				response: {
					require: { headers: { 'Content-Type': [...INLINE_FILE_TYPES] } },
					replace: { 'Content-Disposition': [{ search_regexp: DISPOSITION_TYPE, replace: 'inline' }] },
				},
			},
			{ handler: 'headers', response: { require: { headers: { 'Content-Disposition': null } }, set: { 'Content-Disposition': ['attachment'] } } },
			{
				handler: 'headers',
				response: { require: { headers: { 'Content-Type': [] } }, set: { 'Content-Type': ['{http.response.header.Content-Type}'] } },
			},
			upstream({
				set: headerValues(FILE_TREATMENT),
				delete: [...REMOVED_RESPONSE_HEADERS],
				replace: { 'Content-Disposition': [{ search_regexp: DISPOSITION_TYPE, replace: 'attachment' }] },
			}),
		],
	}
	const answer: CaddyRoute = {
		handle: [INFORMATIONAL_WITHOUT_HEADERS, upstream({ set: headerValues(policy), delete: [...REMOVED_RESPONSE_HEADERS] })],
	}
	return [...(downloads.length === 0 ? [] : [download]), answer]
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
		...authRequest(app, authUpstream, DEFAULT_VERIFY_PATH),
		handle_response: [{
			match: { status_code: [2] },
			routes: [
				{ handle: [{ handler: 'vars' }] },
				...(isApplicationEntry(app) ? [withoutCredentialUnlessMinted()] : []),
				...PROXY_ASSERTED_HEADERS.map(copyResponseHeader),
			],
		}],
	}
}

/**
 * A `Connection` value naming a header the proxy asserts. `reverse_proxy` deletes every header `Connection` names
 * (`removeConnectionHeaders`, v2.10.2) after the asserted ones are already set and before its own header operations,
 * so a client could otherwise strip the client address, the token or the endpoint on the way upstream.
 */
function connectionNominationPattern(): string {
	const names = [...FABRIKA_HOP_HEADERS, REQUEST_ID_HEADER].map(escapeRe2).join('|')
	return `(?i)(?:^|,)[ \\t]*(?:${names})[ \\t]*(?:,|$)`
}

/**
 * The headers the auth service asserts to the app, copied back from a 2xx auth response after step 1 deleted the
 * client's own. A gate app never gets the endpoint or the delegation header.
 */
const PROXY_ASSERTED_HEADERS = [PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, ENDPOINT_HEADER, DELEGATION_HEADER]

/**
 * A contract app's anonymous endpoint mints no token, and the proxy forwards no `px_` key it read nothing from
 * (ADR-0022 rule 3). An allow without a token is exactly that case, so the key header goes; the session cookie
 * is stripped on every upstream hop anyway.
 */
function withoutCredentialUnlessMinted(): CaddyRoute {
	return {
		match: [{ vars: { [`{http.reverse_proxy.header.${PROXY_TOKEN_HEADER}}`]: [''] } }],
		handle: [{ handler: 'headers', request: { delete: ['Authorization'] } }],
	}
}

/** A subrequest to the auth service describing the original request; without `handle_response` its answer is the response. */
function authRequest(app: ProxyApp, authUpstream: string, path: string): CaddyReverseProxyHandler {
	return {
		handler: 'reverse_proxy',
		upstreams: [{ dial: authUpstream }],
		// The route already knows which app it fronts — pin it rather than have the auth service
		// re-derive it from a header the client can influence.
		rewrite: { method: 'GET', uri: `${path}?${APP_QUERY_PARAM}=${encodeURIComponent(app.id)}` },
		headers: {
			request: {
				set: {
					[FORWARDED_METHOD_HEADER]: ['{http.request.method}'],
					[FORWARDED_URI_HEADER]: ['{http.request.uri}'],
				},
			},
		},
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
 * credential: a share-link `px_` token in the path, or the ADR-0022
 * handoff code. The URI and `Location` share one pattern, because a credential is the same string
 * wherever it appears.
 *
 * The field paths are the LOG RECORD's, not the config's: request fields nest under `request>…` but
 * response headers are a top-level `resp_headers` object. Verified against a running caddy 2.10.2 —
 * a misspelled path is silently ignored, which is exactly how a redaction quietly stops happening.
 */
function logFieldFilters(): Record<string, CaddyLogFilter> {
	const pattern = uriRedactionPattern()
	return {
		[`request>headers>${PROXY_TOKEN_HEADER}`]: { filter: 'delete' },
		// A single-use grant, but a credential until IAM spends it.
		[`request>headers>${DELEGATION_HEADER}`]: { filter: 'delete' },
		// The proxy sets it only on the upstream hop, which is not logged; a client's guess is dropped too.
		[`request>headers>${PROXY_SECRET_HEADER}`]: { filter: 'delete' },
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
 *   - the ADR-0022 handoff `?code=…`. UNCONDITIONAL: the reserved callback exists on every app host,
 *     the code is a bare `randomToken(32)` with no `px_` prefix, and it is not a declared credential,
 *     so nothing else in this file would ever contribute it;
 *   - `?state=…`, an OAuth capability that must never reach request or redirect logs;
 *   - `?redirect=…`, the login bounce's return URL. It is not itself a credential, it is a carrier:
 *     the whole original URL is percent-encoded into it, so a `px_` token in it is still caught.
 *
 * Every entry reads a key only as a bearer, never from the URL, so the pattern depends on no manifest.
 */
export function uriRedactionPattern(): string {
	return [
		`${API_KEY_PREFIX}[A-Za-z0-9_.\\-]+`,
		`[?&]${escapeRe2(AUTH_CODE_PARAM)}=[^&]*`,
		`[?&]state=[^&]*`,
		`[?&]${escapeRe2(LOGIN_REDIRECT_PARAM)}=[^&]*`,
	].join('|')
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
