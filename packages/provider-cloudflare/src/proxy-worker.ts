import type { IamGateway, ProxyLogger, VerifyService } from '@fabrika/proxy'
import {
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
} from '@fabrika/proxy'
import { parseProxyManifestJson, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-contract'

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

/** Factory exported for Lopata and unit tests; production uses the default Worker fetch below. */
export function createCloudflareProxyHandler(env: CloudflareProxyEnv, logger: ProxyLogger = consoleLogger): ProxyFetch {
	const manifestJson = env.FABRIKA_PROXY_MANIFEST_JSON ?? ''
	const issuer = env.FABRIKA_IAM_URL ?? ''
	if (!isIamGateway(env.IAM) || manifestJson === '') return () => Promise.resolve(UNAVAILABLE.clone())

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
		const headers = new Headers(request.headers)
		// The same two strips the generated Caddy route does: a client may assert neither the injected
		// token nor the request id that lands in IAM's audit trail. Both come back from the decision.
		headers.delete(PROXY_TOKEN_HEADER)
		headers.delete(REQUEST_ID_HEADER)
		headers.set(FORWARDED_METHOD_HEADER, request.method)
		headers.set(FORWARDED_URI_HEADER, `${url.pathname}${url.search}`)
		headers.set(FORWARDED_HOST_HEADER, url.host)
		headers.set(FORWARDED_PROTO_HEADER, url.protocol === 'http:' ? 'http' : 'https')

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

		const upstreamHeaders = new Headers(request.headers)
		upstreamHeaders.delete(PROXY_TOKEN_HEADER)
		const token = verification.headers.get(PROXY_TOKEN_HEADER)
		if (token !== null && token !== '') upstreamHeaders.set(PROXY_TOKEN_HEADER, token)
		const requestId = verification.headers.get(REQUEST_ID_HEADER)
		if (requestId !== null && requestId !== '') upstreamHeaders.set(REQUEST_ID_HEADER, requestId)

		return upstream.fetch(new Request(request, { headers: upstreamHeaders }))
	}
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
