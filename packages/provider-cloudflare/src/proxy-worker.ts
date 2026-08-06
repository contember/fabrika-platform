import { parseProxyManifestJson, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-contract'
import type { IamGateway, ProxyLogger, VerifyService } from '@fabrika/proxy-core'
import {
	CLIENT_ADDRESS_HEADER,
	consoleLogger,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	MemoryTokenCache,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	stripFabrikaCookies,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/proxy-core'

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
	readonly FABRIKA_IAM_URL?: string
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
	const canonical = canonicalIssuer(env.FABRIKA_IAM_URL)
	if (!isIamGateway(env.IAM) || manifestJson === '' || canonical === null) return () => Promise.resolve(UNAVAILABLE.clone())
	const issuer = canonical

	const manifest = parseProxyManifestJson(manifestJson)
	if (manifest === null || !validManifest(manifest)) return () => Promise.resolve(UNAVAILABLE.clone())

	if (cached?.manifestJson === manifestJson && cached.iam === env.IAM && cached.issuer === issuer) {
		return cached.handler
	}

	const verify = createVerifyService({
		manifest,
		iam: env.IAM,
		issuer,
		cache: new MemoryTokenCache(),
		logger,
	})
	const handler = proxyHandler(env, manifest, verify)
	cached = { manifestJson, iam: env.IAM, issuer, handler }
	return handler
}

function proxyHandler(env: CloudflareProxyEnv, manifest: ProxyManifest, verify: VerifyService): ProxyFetch {
	return async (request) => {
		const url = new URL(request.url)
		const clientAddress = request.headers.get(CLOUDFLARE_CLIENT_ADDRESS_HEADER)
		const headers = new Headers(request.headers)
		// The same strips the generated Caddy route does: a client may assert neither the injected token,
		// nor the request id that lands in IAM's audit trail, nor the client address an upstream limits
		// on. The first two come back from the decision; the third is re-derived below from the edge.
		stripClientAsserted(headers)
		headers.set(FORWARDED_METHOD_HEADER, request.method)
		headers.set(FORWARDED_URI_HEADER, `${url.pathname}${url.search}`)
		headers.set(FORWARDED_HOST_HEADER, url.host)
		headers.set(FORWARDED_PROTO_HEADER, url.protocol === 'http:' ? 'http' : 'https')
		if (clientAddress !== null && clientAddress !== '') headers.set(CLIENT_ADDRESS_HEADER, clientAddress)

		const verification = await verify(
			new Request(`https://fabrika-proxy.internal${DEFAULT_VERIFY_PATH}`, {
				method: 'GET',
				headers,
			}),
		)
		if (!verification.ok) return verification

		const app = findApp(manifest, url)
		if (app === null) return new Response('not found', { status: 404 })
		const upstream = env[app.upstream]
		if (!isWorkerService(upstream)) return UNAVAILABLE.clone()

		// Built from the ORIGINAL headers, so it is stripped again here — the set above was applied to the
		// verify subrequest, not to this one.
		const upstreamHeaders = new Headers(request.headers)
		stripClientAsserted(upstreamHeaders)
		stripFabrikaCookies(upstreamHeaders)
		if (clientAddress !== null && clientAddress !== '') upstreamHeaders.set(CLIENT_ADDRESS_HEADER, clientAddress)
		const token = verification.headers.get(PROXY_TOKEN_HEADER)
		if (token !== null && token !== '') upstreamHeaders.set(PROXY_TOKEN_HEADER, token)
		const requestId = verification.headers.get(REQUEST_ID_HEADER)
		if (requestId !== null && requestId !== '') upstreamHeaders.set(REQUEST_ID_HEADER, requestId)

		return upstream.fetch(new Request(request, { headers: upstreamHeaders }))
	}
}

/** Delete every header only this hop may assert, so nothing downstream can read a caller's version. */
function stripClientAsserted(headers: Headers): void {
	headers.delete(PROXY_TOKEN_HEADER)
	headers.delete(REQUEST_ID_HEADER)
	headers.delete(CLIENT_ADDRESS_HEADER)
	for (const header of UNTRUSTED_FORWARD_HEADERS) headers.delete(header)
}

function findApp(manifest: ProxyManifest, url: URL): ProxyApp | null {
	const host = url.host.toLowerCase()
	const hostname = url.hostname.toLowerCase()
	return manifest.apps.find((app) => app.hosts.includes(host) || app.hosts.includes(hostname)) ?? null
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
