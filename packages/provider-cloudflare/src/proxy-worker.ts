import { answersFile, type EndpointCache, FABRIKA_HOP_HEADERS, parseEndpointHeader, rawRequestTarget } from '@fabrika/auth-core'
import type { DelegationIssuer, IamGateway, ProxyLogger, VerifyService } from '@fabrika/proxy-core'
import {
	CLIENT_ADDRESS_HEADER,
	consoleLogger,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	FORWARD_AUTHORIZATION_HEADER,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	MemoryTokenCache,
	OAUTH_METADATA_VERIFY_PATH,
	PREFLIGHT_HEADER,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	stripFabrikaCookies,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/proxy-core'
import {
	appFileTreatment,
	appHeaderPolicy,
	applyAnswerCache,
	applyCrossOriginHeaders,
	applyFileTreatment,
	applyHeaderPolicy,
	crossOriginHeaders,
	type HeaderPolicy,
	withResponseHeaders,
} from '@fabrika/proxy-core/headers'
import { type ContractProxyApp, isApplicationEntry, parseProxyManifestJson, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'

/**
 * Cloudflare's managed client address — this composition's answer to "who is the client".
 *
 * The edge writes it on every request it forwards and replaces a caller-supplied one, which is what
 * makes it usable as a limiter key and is why a Worker has no need of `X-Forwarded-For`. It stays a
 * LOCAL constant rather than moving into `@fabrika/auth-core`: it is a fact about one provider's edge,
 * and the shared kernel must not name a provider (ADR-0011).
 *
 * Absent — a `wrangler dev`-style local run, or a request arriving over a service binding rather than
 * the edge — means this hop cannot see the client, so nothing is injected and the upstream falls back
 * to its deployment-wide bucket.
 */
const CLOUDFLARE_CLIENT_ADDRESS_HEADER = 'CF-Connecting-IP'

export interface CloudflareProxyEnv {
	readonly IAM?: unknown
	readonly FABRIKA_PROXY_MANIFEST_JSON?: string
	readonly FABRIKA_IAM_ISSUER?: string
	readonly [binding: string]: unknown
}

interface WorkerService {
	fetch(request: Request): Promise<Response>
}

type ProxyFetch = (request: Request) => Promise<Response>

const UNAVAILABLE = new Response('proxy unavailable', {
	status: 503,
	headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
})

let cached: {
	readonly manifestJson: string
	readonly iam: IamGateway
	readonly issuer: string
	readonly handler: ProxyFetch
} | undefined

/**
 * The issuer in the form the token's `iss` is compared against — `new URL(...).origin`, http(s) only.
 * Null when it is unusable, which must refuse to serve rather than boot: jose compares `iss`
 * byte-for-byte, so an absent or unparseable issuer does not degrade, it fails EVERY verification as
 * if the token were forged. The Bun composition gets this from `readProxyEnv`, which this Worker does
 * not run — the check has to exist on both or the invariant only holds on one provider.
 */
function canonicalIssuer(raw: string | undefined): string | null {
	if (raw === undefined || raw.trim() === '') return null
	try {
		const url = new URL(raw.trim())
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
	} catch {
		return null
	}
}

/** Factory exported for Lopata and unit tests; production uses the default Worker fetch below. */
export function createCloudflareProxyHandler(env: CloudflareProxyEnv, logger: ProxyLogger = consoleLogger): ProxyFetch {
	const manifestJson = env.FABRIKA_PROXY_MANIFEST_JSON ?? ''
	const parsed = manifestJson === '' ? null : parseProxyManifestJson(manifestJson)
	const manifest = parsed !== null && validManifest(parsed) ? parsed : null
	const canonical = canonicalIssuer(env.FABRIKA_IAM_ISSUER)
	if (!isIamGateway(env.IAM) || manifest === null || canonical === null) return unavailable(manifest)
	const issuer = canonical

	if (cached?.manifestJson === manifestJson && cached.iam === env.IAM && cached.issuer === issuer) {
		return cached.handler
	}

	const verify = createVerifyService({
		manifest,
		iam: env.IAM,
		issuer,
		cache: new MemoryTokenCache(),
		logger,
		// Until IAM's binding serves `requestDelegation`, no delegation grant is obtained here.
		delegations: isDelegationIssuer(env.IAM) ? env.IAM : null,
	})
	const handler = proxyHandler(env, manifest, verify)
	cached = { manifestJson, iam: env.IAM, issuer, handler }
	return handler
}

/**
 * The fixed 503 of a Worker that cannot serve. A host the manifest still names as an application gets that
 * application's treatment, its transport header included; without a usable manifest no host is known.
 */
function unavailable(manifest: ProxyManifest | null): ProxyFetch {
	return (request) => {
		const app = manifest === null ? null : findApp(manifest, new URL(request.url))
		const answer = UNAVAILABLE.clone()
		return Promise.resolve(
			app === null || !isApplicationEntry(app) ? answer : withResponseHeaders(answer, contractAnswerHeaders(app)(null, answer.status)),
		)
	}
}

function proxyHandler(env: CloudflareProxyEnv, manifest: ProxyManifest, verify: VerifyService): ProxyFetch {
	const answerHeaders = new Map<string, AnswerHeaders>()
	for (const app of manifest.apps) {
		if (isApplicationEntry(app)) answerHeaders.set(app.id, contractAnswerHeaders(app))
	}
	return async (request) => {
		const url = new URL(request.url)
		const app = findApp(manifest, url)
		const isMetadata = app !== null && isOAuthMetadataPath(app, url)
		const clientAddress = request.headers.get(CLOUDFLARE_CLIENT_ADDRESS_HEADER)
		const headers = new Headers(request.headers)
		// The same strips the generated Caddy route does: a client may assert neither the injected token,
		// nor the request id that lands in IAM's audit trail, nor the client address an upstream limits
		// on. The first two come back from the decision; the third is re-derived below from the edge.
		stripClientAsserted(headers)
		headers.set(FORWARDED_METHOD_HEADER, request.method)
		// The RAW target, so the decision's canonical-path check sees what the upstream will receive:
		// `url.pathname` has already had its dot segments resolved.
		const target = rawRequestTarget(request.url)
		headers.set(FORWARDED_URI_HEADER, `${target.pathname}${target.search}`)
		headers.set(FORWARDED_HOST_HEADER, url.host)
		headers.set(FORWARDED_PROTO_HEADER, url.protocol === 'http:' ? 'http' : 'https')
		if (clientAddress !== null && clientAddress !== '') headers.set(CLIENT_ADDRESS_HEADER, clientAddress)

		const verification = await verify(
			new Request(`https://fabrika-proxy.internal${isMetadata ? OAUTH_METADATA_VERIFY_PATH : DEFAULT_VERIFY_PATH}`, {
				method: 'GET',
				headers,
			}),
		)
		if (!verification.ok || isMetadata) return verification
		// An admitted preflight: the decision's 2xx is the whole answer, and the application never sees the request.
		if (verification.headers.get(PREFLIGHT_HEADER) === '1') return withResponseHeaders(verification, (headers) => headers.delete(PREFLIGHT_HEADER))

		if (app === null) return new Response('not found', { status: 404 })
		const treatment = answerHeaders.get(app.id)
		const upstream = env[app.upstream]
		if (!isWorkerService(upstream)) {
			const unavailable = UNAVAILABLE.clone()
			return treatment === undefined
				? unavailable
				: withResponseHeaders(unavailable, treatment(verification.headers.get(ENDPOINT_HEADER), unavailable.status))
		}

		// Built from the ORIGINAL headers, so it is stripped again here — the set above was applied to the
		// verify subrequest, not to this one.
		const upstreamHeaders = new Headers(request.headers)
		stripClientAsserted(upstreamHeaders)
		stripFabrikaCookies(upstreamHeaders)
		if (clientAddress !== null && clientAddress !== '') upstreamHeaders.set(CLIENT_ADDRESS_HEADER, clientAddress)
		for (const header of PROXY_ASSERTED_HEADERS) {
			const value = verification.headers.get(header)
			if (value !== null && value !== '') upstreamHeaders.set(header, value)
		}
		// An anonymous endpoint mints no token, and the proxy forwards no key it read nothing from (ADR-0022 rule 3), except
		// the credential of a webhook row the decision marked to pass on.
		const forwards = verification.headers.get(FORWARD_AUTHORIZATION_HEADER) === '1'
		if (isApplicationEntry(app) && !upstreamHeaders.has(PROXY_TOKEN_HEADER) && !forwards) upstreamHeaders.delete('Authorization')

		let answer: Response
		try {
			answer = await upstream.fetch(new Request(request, { headers: upstreamHeaders }))
		} catch {
			// Nothing of the error is answered or logged: it can carry the upstream request, a token header included.
			answer = new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
		}
		if (treatment === undefined) return answer
		// The treatment deleted the application's own `Access-Control-*`; only the origin the decision admitted is set.
		const allowOrigin = verification.headers.get(ALLOW_ORIGIN_HEADER)
		return withResponseHeaders(answer, (headers) => {
			treatment(verification.headers.get(ENDPOINT_HEADER), answer.status)(headers)
			if (allowOrigin !== null) applyCrossOriginHeaders(headers, crossOriginHeaders(allowOrigin))
		})
	}
}

const ALLOW_ORIGIN_HEADER = 'Access-Control-Allow-Origin'

/**
 * What a contract application's answer is given, replacing whatever the application set (ADR-0022): the file
 * treatment for the download endpoint the decision asserted, the policy otherwise. The decision's own answers carry
 * them already.
 */
type AnswerHeaders = (endpoint: string | null, status: number) => (headers: Headers) => void

function contractAnswerHeaders(app: ContractProxyApp): AnswerHeaders {
	const policy: HeaderPolicy = appHeaderPolicy(app)
	const fileTreatment: HeaderPolicy = appFileTreatment(app)
	const downloads = new Set(app.endpoints.filter(answersFile).map((row) => row.id))
	const cached = new Map<string, EndpointCache>()
	for (const row of app.endpoints) {
		if ('cache' in row && row.cache !== undefined) cached.set(row.id, row.cache)
	}
	return (endpoint, status) => {
		const id = endpoint === null ? null : (parseEndpointHeader(endpoint)?.id ?? null)
		return (headers) => {
			if (id !== null && downloads.has(id)) applyFileTreatment(headers, fileTreatment)
			else applyHeaderPolicy(headers, policy)
			const cache = id === null ? undefined : cached.get(id)
			if (cache !== undefined) applyAnswerCache(headers, { cache }, status)
		}
	}
}

/** What only the decision may assert to the app; each is copied from an allow, the way Caddy's `copy_headers` does. */
const PROXY_ASSERTED_HEADERS = [PROXY_TOKEN_HEADER, REQUEST_ID_HEADER, ENDPOINT_HEADER, DELEGATION_HEADER]

/** Delete every header only this hop may assert, so nothing downstream can read a caller's version. */
function stripClientAsserted(headers: Headers): void {
	for (const header of FABRIKA_HOP_HEADERS) headers.delete(header)
	headers.delete(REQUEST_ID_HEADER)
	for (const header of UNTRUSTED_FORWARD_HEADERS) headers.delete(header)
}

function findApp(manifest: ProxyManifest, url: URL): ProxyApp | null {
	const host = url.host.toLowerCase()
	const hostname = url.hostname.toLowerCase()
	return manifest.apps.find((app) => app.hosts.includes(host) || app.hosts.includes(hostname)) ?? null
}

/**
 * Mirrors the generated Caddy metadata route, whose `path` matcher ignores case: such a request is
 * answered by the metadata endpoint, which compares exactly and 404s a mismatch, and never reaches the endpoint table.
 */
function isOAuthMetadataPath(app: ProxyApp, url: URL): boolean {
	if (isApplicationEntry(app)) return false
	const path = url.pathname.toLowerCase()
	return app.oauthResources?.some((resource) => new URL(resource.resourceMetadata).pathname.toLowerCase() === path) ?? false
}

function validManifest(manifest: ProxyManifest): boolean {
	const hosts = new Set<string>()
	for (const app of manifest.apps) {
		if (app.upstream === '' || app.hosts.length === 0) return false
		for (const host of app.hosts) {
			if (hosts.has(host)) return false
			hosts.add(host)
		}
	}
	return manifest.apps.length > 0
}

function isIamGateway(value: unknown): value is IamGateway {
	return isObject(value)
		&& typeof value['mintToken'] === 'function'
		&& typeof value['mintFromKey'] === 'function'
		&& typeof value['exchangeAuthCode'] === 'function'
		&& typeof value['getJwks'] === 'function'
}

function isDelegationIssuer(value: unknown): value is DelegationIssuer {
	return isObject(value) && typeof value['requestDelegation'] === 'function'
}

function isWorkerService(value: unknown): value is WorkerService {
	return isObject(value) && typeof value['fetch'] === 'function'
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

export default {
	fetch(request: Request, env: CloudflareProxyEnv): Promise<Response> {
		return createCloudflareProxyHandler(env)(request)
	},
}
