// The differential harness: one request, decided by the proxy under a service's frozen gates and under its service
// contract, observed as what reaches the service — the verdict, the credential whose token is injected, the row the
// proxy names — and paired with the handler each side runs.

import { matchRoutes, type Route, route } from '@fabrika/app'
import { type AppGates, type MintFromKeyResult, parseEndpointHeader, SESSION_COOKIE } from '@fabrika/auth-core'
import { createVerifyService, ENDPOINT_HEADER, MemoryTokenCache, PROXY_TOKEN_HEADER, type VerifyService } from '@fabrika/proxy-core'
import { type InstallationProxyTable, type OAuthProtectedResource, parseProxyManifest, type ProxyApp } from '@fabrika/proxy-core/manifest'
import {
	APP,
	CapturingLogger,
	FakeIam,
	HOST,
	ISSUER,
	signResourceToken,
	signToken,
	verifyRequest,
} from '../../../../proxy-core/src/__tests__/helpers'
import type { FrozenRoute } from './frozen'

export const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

export type Credential =
	| 'none'
	| 'session'
	| 'user-key'
	| 'machine-key'
	| 'link-key'
	| 'job-key'
	| 'webhook-key'
	| 'app-key'
	| 'invalid-key'
	| 'oauth'
	| 'session+user-key'
	| 'session+machine-key'

export const CREDENTIALS: readonly Credential[] = [
	'none',
	'session',
	'user-key',
	'machine-key',
	'link-key',
	'job-key',
	'webhook-key',
	'app-key',
	'invalid-key',
	'oauth',
	'session+user-key',
	'session+machine-key',
]

/** What reaches the service: `source` is the credential whose token the proxy injects, `row` the row it names. */
export interface Observation {
	readonly outcome: 'allow' | 'login' | 'deny'
	readonly status: number
	readonly source: 'none' | 'session' | 'key' | 'oauth'
	readonly row: string | null
	/** The proxy's logged reason for a refusal; `null` on an allow. */
	readonly reason: string | null
}

export interface Probe {
	readonly method: string
	readonly path: string
	readonly credential: Credential
	/** `same-origin`: a well-formed client request; the other two exercise admission. */
	readonly headers: 'same-origin' | 'cross-site' | 'no-content-type'
}

const MCP_SCOPE = 'authoring'
export const MCP_RESOURCE: OAuthProtectedResource = {
	resource: `https://${HOST}/mcp`,
	resourceMetadata: `https://${HOST}/.well-known/oauth-protected-resource/mcp`,
	authorizationServers: [ISSUER],
	scopesSupported: [MCP_SCOPE],
}
export const PUBLIC_ORIGIN = `https://${HOST}`

const future = () => Math.floor(Date.now() / 1000) + 300
const SESSION_TOKEN = await signToken({ type: 'user', subject: 'session-user' })
const OAUTH_TOKEN = await signResourceToken({ resource: MCP_RESOURCE.resource, scopes: [MCP_SCOPE] })
const KEY_TOKENS: Readonly<Record<string, string>> = {
	'user-key': await signToken({ type: 'user', subject: 'key-user' }),
	'machine-key': await signToken({ type: 'service', subject: 'machine' }),
	'link-key': await signToken({ subject: 'link' }),
	'job-key': await signToken({ type: 'job', workload: 'nightly' }),
	'webhook-key': await signToken({ type: 'webhook', workload: 'github' }),
	'app-key': await signToken({ type: 'app', workload: 'other-app' }),
}

function keyOf(credential: Credential): string | null {
	const key = credential.replace('session+', '')
	return key === 'none' || key === 'session' || key === 'oauth' ? null : key
}

function minted(credential: Credential): MintFromKeyResult | undefined {
	const key = keyOf(credential)
	if (key === null) return undefined
	const token = KEY_TOKENS[key]
	return token === undefined ? { ok: false, reason: 'invalid_key' } : { ok: true, token, expiresAt: future() }
}

function sourceOf(token: string | null): Observation['source'] {
	if (token === null) return 'none'
	if (token === SESSION_TOKEN) return 'session'
	if (token === OAUTH_TOKEN) return 'oauth'
	if (Object.values(KEY_TOKENS).includes(token)) return 'key'
	throw new Error('the proxy injected a token no credential of this harness minted')
}

/** A gate entry and the matching installation entry, at the same id and host, each parsed as a proxy would. */
export function entries(gates: AppGates, table: InstallationProxyTable, oauth: boolean): { gates: ProxyApp; table: ProxyApp } {
	const placement = { id: APP, hosts: [HOST], upstream: 'service:3000', scheme: 'https', ...(oauth ? { oauthResources: [MCP_RESOURCE] } : {}) }
	return { gates: parsedEntry({ ...placement, gates }), table: parsedEntry({ ...placement, ...table }) }
}

function parsedEntry(entry: unknown): ProxyApp {
	const parsed = parseProxyManifest({ apps: [entry] })?.apps[0]
	if (parsed === undefined) {
		throw new Error('the frozen gates or the service table do not parse as a proxy manifest')
	}
	return parsed
}

/** One verify service per credential, so its fake IAM answers for exactly that credential. */
export function decider(entry: ProxyApp): (probe: Probe) => Promise<Observation> {
	const services = new Map<Credential, VerifyService>()
	const logger = new CapturingLogger()
	for (const credential of CREDENTIALS) {
		const mintFromKey = minted(credential)
		const iam = new FakeIam({
			...(credential.startsWith('session') ? { mintToken: { ok: true, token: SESSION_TOKEN, expiresAt: future() } } : {}),
			...(mintFromKey === undefined ? {} : { mintFromKey }),
		})
		services.set(credential, createVerifyService({ manifest: { apps: [entry] }, iam, issuer: ISSUER, cache: new MemoryTokenCache(), logger }))
	}
	return async (probe) => {
		const verify = services.get(probe.credential)
		if (verify === undefined) throw new Error(`no service for ${probe.credential}`)
		const key = keyOf(probe.credential)
		const headers: Record<string, string> = probe.headers === 'no-content-type'
			? { 'Sec-Fetch-Site': 'same-origin' }
			: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': probe.headers }
		const response = await verify(verifyRequest({
			method: probe.method,
			path: probe.path,
			headers,
			...(probe.credential.startsWith('session') ? { cookie: `${SESSION_COOKIE}=s` } : {}),
			...(probe.credential === 'oauth' ? { bearer: OAUTH_TOKEN } : key === null ? {} : { bearer: `px_${key}` }),
		}))
		const endpoint = response.headers.get(ENDPOINT_HEADER)
		const reason = logger.lines.at(-1)?.fields['reason']
		return {
			outcome: response.status === 204 ? 'allow' : response.status === 302 ? 'login' : 'deny',
			status: response.status,
			source: sourceOf(response.headers.get(PROXY_TOKEN_HEADER)),
			row: endpoint === null ? null : (parseEndpointHeader(endpoint)?.id ?? null),
			reason: response.status === 204 || typeof reason !== 'string' ? null : reason,
		}
	}
}

/** Request paths that exercise every pattern: a parameter instantiated, a wildcard empty, one and two segments deep. */
export function probePaths(patterns: readonly string[], extras: readonly string[]): string[] {
	const paths = new Set<string>(extras)
	for (const pattern of patterns) {
		let variants = ['']
		const segments = pattern === '/' ? [] : pattern.slice(1).split('/')
		for (const segment of segments) {
			const options = segment.startsWith(':') ? ['p1'] : segment.startsWith('*') ? ['', 'a', 'a/b'] : [segment]
			variants = variants.flatMap((prefix) => options.map((option) => `${prefix}/${option}`))
		}
		for (const variant of variants) {
			paths.add(variant === '' ? '/' : variant)
			if (!variant.endsWith('/')) paths.add(`${variant}/`)
		}
	}
	return [...paths].sort()
}

/** Which `defineApp` route a request reaches: its pattern, or `null` when no route matches (a 404). */
export function legacyRouter(frozen: readonly FrozenRoute[]): (method: string, path: string) => string | null {
	const patterns = new Map<Route<unknown>, string>()
	const routes = frozen.map((entry) => {
		const handler = () => new Response(null)
		const built = entry.method === null
			? route.all(entry.pattern, handler)
			: entry.method === 'GET'
			? route.get(entry.pattern, handler)
			: entry.method === 'PUT'
			? route.put(entry.pattern, handler)
			: entry.method === 'PATCH'
			? route.patch(entry.pattern, handler)
			: entry.method === 'DELETE'
			? route.delete(entry.pattern, handler)
			// `route.rpc` serves POST and matches like `route.post`.
			: route.post(entry.pattern, handler)
		patterns.set(built, entry.pattern)
		return built
	})
	return (method, path) => {
		const matched = matchRoutes(routes, new Request(`https://${HOST}${path}`, { method }))
		return matched === null ? null : (patterns.get(matched.route) ?? null)
	}
}

/** What runs, in one name per behaviour: a route's pattern, or `not-found` for a route that answers a fixed 404 or none. */
export function legacyHandler(frozen: readonly FrozenRoute[], fixedNotFound: readonly string[]): (method: string, path: string) => string {
	const router = legacyRouter(frozen)
	return (method, path) => {
		const pattern = router(method, path)
		return pattern === null || fixedNotFound.includes(pattern) ? 'not-found' : pattern
	}
}
