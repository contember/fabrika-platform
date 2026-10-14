import {
	buildResourceAccessClaims,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	type EndpointRules,
	FABRIKA_HOP_HEADERS,
	formatEndpointHeader,
	type Jwks,
	PROXY_SECRET_HEADER,
	requirementDigest,
	RESOURCE_ACCESS_TOKEN_TYP,
} from '@fabrika/auth-core'
import type { DelegationRequest } from '@fabrika/proxy-core'
import { FILE_TREATMENT, headerPolicy, STRICT_TRANSPORT_SECURITY } from '@fabrika/proxy-core/headers'
import {
	contractProxyTable,
	encodeProxyManifestJson,
	type InstallationProxyEndpointRow,
	type OAuthProtectedResource,
} from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	APP,
	FakeIam,
	HOST,
	installationAppWith,
	installationRow,
	ISSUER,
	protocolRow,
	serviceRow,
	signToken,
	signUserToken,
} from '../../../proxy-core/src/__tests__/helpers'
import { createCloudflareProxyWorker } from '../proxy'
import { type CloudflareProxyEnv, createCloudflareProxyHandler } from '../proxy-worker'

/**
 * A request whose `url` is the string as written. Bun's `Request` resolves dot segments on
 * construction; a Worker may receive them unresolved, which is the case the proxy must refuse.
 */
class RawUrlRequest extends Request {
	constructor(private readonly raw: string) {
		super(raw)
	}

	override get url(): string {
		return this.raw
	}
}

const environment = (
	endpoints: InstallationProxyEndpointRow[],
	upstream: CloudflareProxyEnv['APP'] = { fetch: () => Promise.resolve(new Response('upstream')) },
): CloudflareProxyEnv => ({
	IAM: new FakeIam(),
	FABRIKA_IAM_ISSUER: ISSUER,
	FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({ apps: [installationAppWith(endpoints, [], { upstream: 'APP' })] }),
	APP: upstream,
})

describe('Cloudflare proxy Worker', () => {
	test('rejects an application Worker that can still be published on workers.dev', () => {
		const app = new Worker({ dir: '.', name: APP, main: './src/index.ts', compatibility_flags: [], bindings: {}, routes: [] })
		expect(() => createCloudflareProxyWorker({ name: 'proxy', app, appId: APP, appHost: HOST, endpoints: contractProxyTable(notesArtifact) })).toThrow(
			'must disable workers.dev',
		)
	})

	test('disables automatic invocation logs because callback URLs carry a one-time code', () => {
		const app = new Worker({
			dir: '.',
			name: APP,
			main: './src/index.ts',
			compatibility_flags: [],
			bindings: {},
			routes: [],
			workers_dev: false,
		})
		const proxy = createCloudflareProxyWorker({ name: 'proxy', app, appId: APP, appHost: HOST, endpoints: contractProxyTable(notesArtifact) })
		expect(proxy.options.observability).toEqual({ logs: { enabled: true, invocation_logs: false } })
	})

	test("an installation service's answer passes through: the header policy is a contract application's", async () => {
		const env = environment([protocolRow('/public/*')], {
			fetch: () => Promise.resolve(new Response('ok', { headers: { 'Content-Security-Policy': "script-src 'self' 'unsafe-inline'" } })),
		})
		const response = await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/public/page`))
		expect(response.headers.get('Content-Security-Policy')).toBe("script-src 'self' 'unsafe-inline'")
		expect(response.headers.get('Permissions-Policy')).toBeNull()
	})

	test('deletes every X-Fabrika-* hop header a client sends; Cloudflare sets no proxy secret', async () => {
		let seen: Request | undefined
		const env = environment(
			[protocolRow('/public/*')],
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('ok'))
				},
			},
		)
		const forged = Object.fromEntries(FABRIKA_HOP_HEADERS.map((header) => [header, 'forged']))
		const response = await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/public/page`, { headers: forged }))

		expect(response.status).toBe(200)
		for (const header of FABRIKA_HOP_HEADERS) {
			expect(seen?.headers.get(header) ?? null).not.toBe('forged')
		}
		// The service binding is the authenticated hop on Cloudflare (ADR-0022 rule 1).
		expect(seen?.headers.get(PROXY_SECRET_HEADER)).toBeNull()
	})

	test('forwards a protocol request with its method and body, but never a client token', async () => {
		let seen: Request | undefined
		const env = environment(
			[protocolRow('/public/*')],
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('streamed', { status: 201 }))
				},
			},
		)
		const response = await createCloudflareProxyHandler(env)(
			new Request(`https://${HOST}/public/stream?x=1`, {
				method: 'POST',
				body: 'payload',
				headers: {
					'X-Fabrika-Token': 'forged',
					'X-Request-Id': 'request-1',
					Cookie: '__Host-px_session=session-secret; app-cookie=kept; __Host-px_handoff_state=verifier',
				},
			}),
		)

		expect(response.status).toBe(201)
		expect(seen?.method).toBe('POST')
		expect(seen?.url).toBe(`https://${HOST}/public/stream?x=1`)
		expect(seen?.headers.get('X-Fabrika-Token')).toBeNull()
		// The proxy mints the correlation id: a client-chosen one would land in IAM's audit trail.
		const requestId = seen?.headers.get('X-Request-Id')
		expect(requestId).not.toBe('request-1')
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
		expect(seen?.headers.get('Cookie')).toBe('app-cookie=kept')
		expect(await seen?.text()).toBe('payload')
		expect(await response.text()).toBe('streamed')
	})

	// The spoofing test for THIS composition. `CF-Connecting-IP` is written by Cloudflare's edge and
	// replaces a caller's, so it is the only address here a limiter may key on; every other name a client
	// address travels under is deleted, so an upstream reading `X-Fabrika-Client-Ip` reads the edge.
	test('a caller cannot choose the client coordinate on any of the names it travels under', async () => {
		const forged = { 'X-Fabrika-Client-Ip': '203.0.113.99', 'X-Forwarded-For': '203.0.113.99' }
		const upstreamHeaders = async (headers: Record<string, string>): Promise<Headers> => {
			const seen: Request[] = []
			const env = environment([protocolRow('/*')], {
				fetch: (request: Request) => {
					seen.push(request)
					return Promise.resolve(new Response('ok'))
				},
			})
			await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/anything`, { headers }))
			const first = seen[0]
			if (first === undefined) throw new Error('the upstream was never reached')
			return first.headers
		}

		const withEdge = await upstreamHeaders({ ...forged, 'CF-Connecting-IP': '198.51.100.7' })
		expect(withEdge.get('X-Fabrika-Client-Ip')).toBe('198.51.100.7')
		// Deleted rather than passed through: an app that read one of these would key on a forgery here
		// and on a real address on the other cloud, or the other way round.
		expect(withEdge.get('X-Forwarded-For')).toBeNull()
		expect(withEdge.get('CF-Connecting-IP')).toBeNull()

		// Edge header absent (a local run, or a service-binding call): this hop cannot see the client, so
		// it injects nothing and the upstream falls back to its deployment-wide bucket. It does NOT
		// promote the caller's value.
		const withoutEdge = await upstreamHeaders(forged)
		expect(withoutEdge.get('X-Fabrika-Client-Ip')).toBeNull()
		expect(withoutEdge.get('X-Forwarded-For')).toBeNull()
	})

	test('injects only a verified token on a protected request', async () => {
		const token = await signUserToken()
		let seen: Request | undefined
		const env = environment(
			[serviceRow('/*', ['human'])],
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('ok'))
				},
			},
		)
		const configured: CloudflareProxyEnv = {
			...env,
			IAM: new FakeIam({ mintToken: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 } }),
		}
		const response = await createCloudflareProxyHandler(configured)(
			new Request(`https://${HOST}/private`, {
				headers: { Cookie: '__Host-px_session=session; app-cookie=kept', 'X-Fabrika-Token': 'forged' },
			}),
		)

		expect(response.status).toBe(200)
		expect(seen?.headers.get('X-Fabrika-Token')).toBe(token)
		expect(seen?.headers.get('Cookie')).toBe('app-cookie=kept')
	})

	test('a key is terminal: the session beside it is never consulted', async () => {
		const token = await signToken({ type: 'service' })
		let seen: Request | undefined
		const env = environment(
			[serviceRow('/*', ['human', 'machine'])],
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('ok'))
				},
			},
		)
		const configured: CloudflareProxyEnv = {
			...env,
			IAM: new FakeIam({
				mintFromKey: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 },
				mintToken: { ok: false, reason: 'no_session' },
			}),
		}
		const response = await createCloudflareProxyHandler(configured)(
			new Request(`https://${HOST}/private`, {
				headers: { Authorization: 'Bearer px_service', Cookie: '__Host-px_session=ignored' },
			}),
		)

		expect(response.status).toBe(200)
		expect(seen?.headers.get('X-Fabrika-Token')).toBe(token)
		expect(seen?.headers.get('Cookie')).toBeNull()
	})

	test('returns the shared login bounce and does not call the application', async () => {
		let calls = 0
		const env = environment(
			[serviceRow('/*', ['human'])],
			{
				fetch: () => {
					calls++
					return Promise.resolve(new Response('should not run'))
				},
			},
		)
		const response = await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/private`))

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toContain(`${ISSUER}/auth/login`)
		expect(calls).toBe(0)
	})

	test('denies an invalid machine credential and a malformed manifest before the app', async () => {
		let calls = 0
		const upstream = {
			fetch: () => {
				calls++
				return Promise.resolve(new Response('should not run'))
			},
		}
		const service = environment([serviceRow('/*', ['machine'])], upstream)
		const denied = await createCloudflareProxyHandler(service)(
			new Request(`https://${HOST}/private`, {
				headers: { Authorization: 'Bearer not-a-token' },
			}),
		)
		expect(denied.status).toBe(401)
		expect(calls).toBe(0)

		const malformed = createCloudflareProxyHandler({ ...service, FABRIKA_PROXY_MANIFEST_JSON: '{' })
		expect((await malformed(new Request(`https://${HOST}/private`))).status).toBe(503)
		expect(calls).toBe(0)
	})

	test.each([
		['a repeated slash', '//admin/users'],
		['a dot-dot segment', '/a/../admin'],
		['an encoded dot-dot segment', '/a/%2e%2e/b'],
		['an encoded slash', '/x%2Fy'],
	])('refuses %s in the raw request URL before the app, even on a protocol row', async (_name, path) => {
		let calls = 0
		const upstream = {
			fetch: () => {
				calls++
				return Promise.resolve(new Response('should not run'))
			},
		}
		const response = await createCloudflareProxyHandler(environment([protocolRow('/*')], upstream))(
			new RawUrlRequest(`https://${HOST}${path}`),
		)
		expect(response.status).toBe(400)
		expect(calls).toBe(0)
	})

	// The Bun composition refuses to boot without a usable issuer (`readProxyEnv`); this Worker does not
	// run that, so the same refusal has to exist here or the invariant holds on one provider only. An
	// absent issuer does not degrade — jose compares `iss` byte-for-byte, so it fails EVERY verification.
	test('refuses to serve without a usable issuer rather than failing every verification', async () => {
		let calls = 0
		const upstream = {
			fetch: () => {
				calls++
				return Promise.resolve(new Response('should not run'))
			},
		}
		const base = environment([protocolRow('/*')], upstream)
		for (const issuer of [undefined, '', '   ', 'not a url', 'ftp://iam.test']) {
			const handler = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_ISSUER: issuer })
			expect((await handler(new Request(`https://${HOST}/anything`))).status).toBe(503)
		}
		expect(calls).toBe(0)

		// A trailing slash is the same issuer, not a second one — jose would disagree.
		const canonical = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_ISSUER: `${ISSUER}/` })
		expect((await canonical(new Request(`https://${HOST}/anything`))).status).toBe(200)
	})
})

const RESOURCE = `https://${HOST}/mcp`
const RESOURCE_METADATA = `https://${HOST}/.well-known/oauth-protected-resource/mcp`
const OAUTH_RESOURCE: OAuthProtectedResource = {
	resource: RESOURCE,
	resourceMetadata: RESOURCE_METADATA,
	authorizationServers: [ISSUER],
	scopesSupported: ['authoring'],
}
const resourceKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const resourceJwk = await crypto.subtle.exportKey('jwk', resourceKey.publicKey)
const RESOURCE_JWKS: Jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: resourceJwk.x, y: resourceJwk.y, kid: 'oauth', alg: 'ES256', use: 'sig' }] }

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url')
}

/** A compact ES256 JWS over Web Crypto, whose P1363 signature encoding is what JWS expects. */
async function signResourceToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildResourceAccessClaims({
		iss: ISSUER,
		app: APP,
		resource: RESOURCE,
		subject: 'user-1',
		label: 'a@b.cz',
		permissions: [],
		issuedAt: now,
		expiresAt: now + 300,
		clientId: 'https://client.example.com/metadata.json',
		scopes: ['authoring'],
		grantId: 'grant-1',
		tokenId: 'token-1',
	})
	const encoder = new TextEncoder()
	const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: 'oauth', typ: RESOURCE_ACCESS_TOKEN_TYP })))
	const input = `${header}.${base64url(encoder.encode(JSON.stringify(claims)))}`
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, resourceKey.privateKey, encoder.encode(input))
	return `${input}.${base64url(new Uint8Array(signature))}`
}

describe('Cloudflare proxy Worker — OAuth resources', () => {
	function oauthEnvironment(upstream: { fetch: (request: Request) => Promise<Response> }): CloudflareProxyEnv {
		return {
			IAM: new FakeIam({ jwks: RESOURCE_JWKS }),
			FABRIKA_IAM_ISSUER: ISSUER,
			FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({
				apps: [{
					id: APP,
					hosts: [HOST],
					upstream: 'APP',
					scheme: 'https',
					installation: true,
					endpoints: [serviceRow('/mcp', ['oauth'], { scopes: ['authoring'] }), protocolRow('/*')],
					reservedPrefixes: [],
					oauthResources: [OAUTH_RESOURCE],
				}],
			}),
			APP: upstream,
		}
	}

	test('serves the protected resource metadata itself, without calling the application', async () => {
		const upstream = new RecordingUpstream()
		const response = await createCloudflareProxyHandler(oauthEnvironment(upstream))(new Request(RESOURCE_METADATA))
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(JSON.stringify({
			resource: RESOURCE,
			authorization_servers: [ISSUER],
			scopes_supported: ['authoring'],
			bearer_methods_supported: ['header'],
		}))
		expect(upstream.calls).toBe(0)
	})

	test('a case variant of the metadata path ends at the metadata endpoint with 404, like the Caddy route', async () => {
		const upstream = new RecordingUpstream()
		const handler = createCloudflareProxyHandler(oauthEnvironment(upstream))
		const variant = RESOURCE_METADATA.replace('/mcp', '/MCP')
		const response = await handler(new Request(variant))
		expect(response.status).toBe(404)
		expect(upstream.calls).toBe(0)
		// The same request off the metadata path reaches the protocol catch-all, proving the 404 is not the row's.
		expect((await handler(new Request(`https://${HOST}/.well-known/other`))).status).toBe(200)
		expect(upstream.calls).toBe(1)
	})

	test('answers a missing bearer with the shared 401 challenge, never a login bounce', async () => {
		const upstream = new RecordingUpstream()
		const response = await createCloudflareProxyHandler(oauthEnvironment(upstream))(
			new Request(RESOURCE, { method: 'POST', headers: { Cookie: '__Host-px_session=session' } }),
		)
		expect(response.status).toBe(401)
		expect(response.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`)
		expect(response.headers.get('location')).toBeNull()
		expect(upstream.calls).toBe(0)
	})

	test('injects a verified resource token and strips a forged one', async () => {
		const token = await signResourceToken()
		const upstream = new RecordingUpstream()
		const response = await createCloudflareProxyHandler(oauthEnvironment(upstream))(
			new Request(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Fabrika-Token': 'forged' } }),
		)
		expect(response.status).toBe(200)
		expect(upstream.seen?.headers.get('X-Fabrika-Token')).toBe(token)
	})
})

describe('Cloudflare proxy Worker — an installation entry', () => {
	const admin = installationRow({
		id: 'admin',
		kind: 'protocol',
		method: '*',
		path: '/admin/*',
		callers: [],
		requirement: null,
		admission: null,
		oauth: null,
	})
	const mcp = installationRow({
		id: 'mcp',
		kind: 'service',
		method: '*',
		path: '/mcp',
		callers: ['oauth'],
		requirement: { kind: 'authenticated' },
		admission: null,
		oauth: { scopes: ['authoring'] },
	})
	const SERVICE_CSP = "default-src 'self'; form-action https://return.example"
	function installationEnvironment(upstream: { fetch: (request: Request) => Promise<Response> }): CloudflareProxyEnv {
		return {
			IAM: new FakeIam({ jwks: RESOURCE_JWKS }),
			FABRIKA_IAM_ISSUER: ISSUER,
			FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({
				apps: [{
					id: APP,
					hosts: [HOST],
					upstream: 'APP',
					scheme: 'https',
					installation: true,
					endpoints: [admin, mcp],
					reservedPrefixes: [],
					oauthResources: [OAUTH_RESOURCE],
				}],
			}),
			APP: upstream,
		}
	}

	test('a protocol row reaches the service with its own Authorization and the endpoint, and no token', async () => {
		const upstream = new RecordingUpstream()
		const response = await createCloudflareProxyHandler(installationEnvironment(upstream))(
			new Request(`https://${HOST}/admin/apps/notes/schema`, {
				method: 'PUT',
				headers: { Authorization: 'Bearer px_provisioning', [ENDPOINT_HEADER]: 'forged' },
			}),
		)
		expect(response.status).toBe(200)
		expect(upstream.seen?.headers.get('Authorization')).toBe('Bearer px_provisioning')
		expect(upstream.seen?.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(admin.id, admin.digest))
		expect(upstream.seen?.headers.get('X-Fabrika-Token')).toBeNull()
		expect(upstream.seen?.headers.get(PROXY_SECRET_HEADER)).toBeNull()
	})

	test("the service's own policy passes through untouched", async () => {
		const env = installationEnvironment({ fetch: () => Promise.resolve(new Response('ok', { headers: { 'Content-Security-Policy': SERVICE_CSP } })) })
		const response = await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/admin/apps`))
		expect(response.headers.get('Content-Security-Policy')).toBe(SERVICE_CSP)
		expect(response.headers.get('Permissions-Policy')).toBeNull()
	})

	test('serves its RFC 9728 metadata, and an oauth row answers a missing bearer with the challenge', async () => {
		const upstream = new RecordingUpstream()
		const handler = createCloudflareProxyHandler(installationEnvironment(upstream))
		expect((await handler(new Request(RESOURCE_METADATA))).status).toBe(200)
		const response = await handler(new Request(RESOURCE, { method: 'DELETE', headers: { Cookie: '__Host-px_session=session' } }))
		expect(response.status).toBe(401)
		expect(response.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`)
		expect(upstream.calls).toBe(0)
	})

	test('an oauth row injects the verified resource token and keeps the bearer', async () => {
		const token = await signResourceToken()
		const upstream = new RecordingUpstream()
		const response = await createCloudflareProxyHandler(installationEnvironment(upstream))(
			new Request(RESOURCE, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }),
		)
		expect(response.status).toBe(200)
		expect(upstream.seen?.headers.get('X-Fabrika-Token')).toBe(token)
		expect(upstream.seen?.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(mcp.id, mcp.digest))
		expect(upstream.seen?.headers.get('Authorization')).toBe(`Bearer ${token}`)
	})
})

class RecordingUpstream {
	calls = 0
	seen: Request | undefined

	fetch = (request: Request): Promise<Response> => {
		this.calls++
		this.seen = request
		return Promise.resolve(new Response('ok'))
	}
}

describe('Cloudflare proxy Worker — a contract app', () => {
	const health = {
		id: 'health',
		kind: 'health',
		method: 'GET',
		path: '/healthz',
		callers: [],
		requirement: null,
		admission: null,
		delegation: null,
	} satisfies
		& EndpointRules
		& {
			id: string
		}
	const me = {
		id: 'api.me',
		kind: 'query',
		method: 'POST',
		path: '/api/me',
		callers: ['human', 'machine'],
		requirement: { kind: 'member' },
		admission: { contentTypes: ['application/json'], maxBytes: null },
		delegation: null,
	} satisfies EndpointRules & { id: string }
	const invite = {
		...me,
		id: 'api.workspaces.invite',
		path: '/api/workspaces.invite',
		callers: ['human'],
		requirement: { kind: 'action', action: 'notes.admin', access: { form: 'in', dimension: 'workspace', from: 'workspaceId' } },
		delegation: 'members',
	} satisfies EndpointRules & { id: string }
	const download = {
		...me,
		id: 'files.avatar.download',
		kind: 'download',
		method: 'GET',
		path: '/api/files.avatar/:fileId',
		admission: null,
	} satisfies EndpointRules & { id: string }
	const csp = { connectSrc: ['https://api.maps.example'], imgSrc: [], frameAncestors: [], scriptSrc: [], frameSrc: [], styleSrc: [], fontSrc: [] }
	/** The application's own headers per path: a weaker policy than the proxy's, and downloads it labels itself. */
	const answers: Record<string, Record<string, string>> = {
		'/api/me': { 'Content-Security-Policy': 'default-src *', 'Cache-Control': 'public, max-age=60', 'X-App': 'kept' },
		'/api/files.avatar/drawing': { 'Content-Type': 'image/svg+xml', 'Content-Disposition': "inline; filename*=UTF-8''a.svg" },
		'/api/files.avatar/photo': { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment' },
	}
	const contractEnvironment = (iam: FakeIam, seen: Request[], scheme: 'http' | 'https' = 'https'): CloudflareProxyEnv => ({
		IAM: iam,
		FABRIKA_IAM_ISSUER: ISSUER,
		FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({
			apps: [{
				id: APP,
				hosts: [HOST],
				upstream: 'APP',
				scheme,
				endpoints: [
					{ ...health, digest: requirementDigest(health) },
					{ ...me, digest: requirementDigest(me) },
					{ ...invite, digest: requirementDigest(invite) },
					{ ...download, digest: requirementDigest(download) },
				],
				reservedPrefixes: ['/api'],
				snapshot: `sha256:${'0'.repeat(64)}`,
				csp,
				operationsOrigin: 'https://operations.example.com',
			}],
		}),
		APP: {
			fetch: (request: Request) => {
				seen.push(request)
				return Promise.resolve(new Response('ok', { headers: answers[new URL(request.url).pathname] ?? {} }))
			},
		},
	})
	const keyIam = async () =>
		new FakeIam({ mintFromKey: { ok: true, token: await signToken({ type: 'service' }), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
	const POLICY = headerPolicy(csp, 'https://operations.example.com')

	test('an application that sets a weaker policy still answers the proxy policy', async () => {
		const response = await createCloudflareProxyHandler(contractEnvironment(await keyIam(), []))(
			new Request(`https://${HOST}/api/me`, {
				method: 'POST',
				body: '{}',
				headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' },
			}),
		)
		expect(response.status).toBe(200)
		for (const [name, value] of POLICY) {
			expect(response.headers.get(name)).toBe(value)
		}
		expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self' https://operations.example.com https://api.maps.example;")
		expect(response.headers.get('X-App')).toBe('kept')
		expect(await response.text()).toBe('ok')
	})

	test('a download endpoint gets the file treatment: only an inert image stays inline', async () => {
		const handler = createCloudflareProxyHandler(contractEnvironment(await keyIam(), []))
		const cases: [path: string, disposition: string][] = [
			['/api/files.avatar/drawing', "attachment; filename*=UTF-8''a.svg"],
			['/api/files.avatar/photo', 'inline'],
		]
		for (const [path, disposition] of cases) {
			const response = await handler(new Request(`https://${HOST}${path}`, { headers: { Authorization: 'Bearer px_key' } }))
			expect(response.status).toBe(200)
			expect(response.headers.get('Content-Disposition')).toBe(disposition)
			for (const [name, value] of FILE_TREATMENT) {
				expect(response.headers.get(name)).toBe(value)
			}
			expect(response.headers.get('Permissions-Policy')).toBeNull()
		}
	})

	test('an application binding that throws is a fixed 502 with the treatment of the endpoint the decision selected', async () => {
		const failing = (iam: FakeIam): CloudflareProxyEnv => ({
			...contractEnvironment(iam, []),
			APP: { fetch: () => Promise.reject(new Error('upstream exploded with secret-detail')) },
		})
		const handler = createCloudflareProxyHandler(failing(await keyIam()))
		const answer = await handler(
			new Request(`https://${HOST}/api/me`, {
				method: 'POST',
				body: '{}',
				headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' },
			}),
		)
		expect(answer.status).toBe(502)
		expect(await answer.text()).toBe('bad gateway')
		for (const [name, value] of POLICY) {
			expect(answer.headers.get(name)).toBe(value)
		}
		const download = await handler(new Request(`https://${HOST}/api/files.avatar/photo`, { headers: { Authorization: 'Bearer px_key' } }))
		expect(download.status).toBe(502)
		expect(await download.text()).not.toContain('secret-detail')
		for (const [name, value] of FILE_TREATMENT) {
			expect(download.headers.get(name)).toBe(value)
		}
		expect(download.headers.get('Content-Disposition')).toBe('attachment')
	})

	test('the reporting headers an application sends are dropped, on an answer and a download', async () => {
		const reporting = {
			'Content-Security-Policy-Report-Only': "default-src 'none'; report-uri https://collector.example/csp",
			'Report-To': '{"group":"x","max_age":60,"endpoints":[{"url":"https://collector.example/r"}]}',
			'Reporting-Endpoints': 'x="https://collector.example/r"',
			NEL: '{"report_to":"x","max_age":60}',
		}
		const env: CloudflareProxyEnv = {
			...contractEnvironment(await keyIam(), []),
			APP: { fetch: () => Promise.resolve(new Response('ok', { headers: reporting })) },
		}
		const handler = createCloudflareProxyHandler(env)
		const answers = [
			await handler(
				new Request(`https://${HOST}/api/me`, {
					method: 'POST',
					body: '{}',
					headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' },
				}),
			),
			await handler(new Request(`https://${HOST}/api/files.avatar/photo`, { headers: { Authorization: 'Bearer px_key' } })),
		]
		for (const answer of answers) {
			expect(answer.status).toBe(200)
			for (const name of Object.keys(reporting)) {
				expect(answer.headers.get(name)).toBeNull()
			}
		}
	})

	test('every answer of an https host carries HSTS: the application, a download, a failed binding, a denial', async () => {
		const keyed = { headers: { Authorization: 'Bearer px_key' } }
		const call = (path: string) =>
			new Request(`https://${HOST}${path}`, { method: 'POST', body: '{}', headers: { ...keyed.headers, 'Content-Type': 'application/json' } })
		const handler = createCloudflareProxyHandler(contractEnvironment(await keyIam(), []))
		const unbound = createCloudflareProxyHandler({ ...contractEnvironment(await keyIam(), []), APP: undefined })
		const failing = createCloudflareProxyHandler({ ...contractEnvironment(await keyIam(), []), APP: { fetch: () => Promise.reject(new Error('x')) } })
		const answers = [
			await handler(call('/api/me')),
			await handler(new Request(`https://${HOST}/api/files.avatar/photo`, keyed)),
			await unbound(call('/api/me')),
			await failing(new Request(`https://${HOST}/api/files.avatar/photo`, keyed)),
			await createCloudflareProxyHandler(contractEnvironment(new FakeIam(), []))(new Request(`https://${HOST}/api/unknown`)),
		]
		expect(answers.map((answer) => answer.status)).toEqual([200, 200, 503, 502, 403])
		for (const answer of answers) {
			expect(answer.headers.get('Strict-Transport-Security')).toBe(STRICT_TRANSPORT_SECURITY)
		}
		expect(answers[1]?.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
	})

	test("an http host gets no HSTS, and the application's own is dropped on an answer and a download", async () => {
		const pinning: CloudflareProxyEnv = {
			...contractEnvironment(await keyIam(), [], 'http'),
			APP: { fetch: () => Promise.resolve(new Response('ok', { headers: { 'Strict-Transport-Security': 'max-age=999; includeSubDomains' } })) },
		}
		const handler = createCloudflareProxyHandler(pinning)
		const answers = [
			await handler(
				new Request(`http://${HOST}/api/me`, {
					method: 'POST',
					body: '{}',
					headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' },
				}),
			),
			await handler(new Request(`http://${HOST}/api/files.avatar/photo`, { headers: { Authorization: 'Bearer px_key' } })),
		]
		for (const answer of answers) {
			expect(answer.status).toBe(200)
			expect(answer.headers.get('Strict-Transport-Security')).toBeNull()
		}
	})

	test("a Worker that cannot serve answers its fixed 503 with the named application's treatment", async () => {
		const withoutIam = createCloudflareProxyHandler({ ...contractEnvironment(new FakeIam(), []), IAM: undefined })
		const withoutIssuer = createCloudflareProxyHandler({ ...contractEnvironment(new FakeIam(), []), FABRIKA_IAM_ISSUER: '' })
		for (const handler of [withoutIam, withoutIssuer]) {
			const answer = await handler(new Request(`https://${HOST}/api/me`))
			expect(answer.status).toBe(503)
			expect(await answer.text()).toBe('proxy unavailable')
			expect(answer.headers.get('Strict-Transport-Security')).toBe(STRICT_TRANSPORT_SECURITY)
			expect(answer.headers.get('Content-Security-Policy')).toBe(POLICY[0]?.[1] ?? '')
		}
		const unknownHost = await withoutIam(new Request('https://elsewhere.example/'))
		expect(unknownHost.status).toBe(503)
		expect(unknownHost.headers.get('Strict-Transport-Security')).toBeNull()
		const noManifest = await createCloudflareProxyHandler({ ...contractEnvironment(new FakeIam(), []), FABRIKA_PROXY_MANIFEST_JSON: '' })(
			new Request(`https://${HOST}/api/me`),
		)
		expect(noManifest.status).toBe(503)
		expect(noManifest.headers.get('Strict-Transport-Security')).toBeNull()
	})

	test("the decision's own denial carries the application's policy", async () => {
		const response = await createCloudflareProxyHandler(contractEnvironment(new FakeIam(), []))(new Request(`https://${HOST}/api/unknown`))
		expect(response.status).toBe(403)
		expect(response.headers.get('Content-Security-Policy')).toBe(POLICY[0]?.[1] ?? '')
	})

	test('an anonymous endpoint reaches the app with its endpoint header and without the key or a client-sent endpoint', async () => {
		const seen: Request[] = []
		const iam = new FakeIam()
		const response = await createCloudflareProxyHandler(contractEnvironment(iam, seen))(
			new Request(`https://${HOST}/healthz`, {
				headers: { Authorization: 'Bearer px_key', [ENDPOINT_HEADER]: 'api.me@forged', [DELEGATION_HEADER]: 'forged' },
			}),
		)
		expect(response.status).toBe(200)
		expect(seen[0]?.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(health.id, requirementDigest(health)))
		expect(seen[0]?.headers.get('Authorization')).toBeNull()
		expect(seen[0]?.headers.get(DELEGATION_HEADER)).toBeNull()
		expect(seen[0]?.headers.get('X-Fabrika-Token')).toBeNull()
		expect(iam.mintFromKeyCalls).toBe(0)
	})

	test('a key request reaches the app with the token, the endpoint, and its own Authorization header', async () => {
		const seen: Request[] = []
		const iam = new FakeIam({ mintFromKey: { ok: true, token: await signToken({ type: 'service' }), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const response = await createCloudflareProxyHandler(contractEnvironment(iam, seen))(
			new Request(`https://${HOST}/api/me`, {
				method: 'POST',
				body: '{}',
				headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json', [ENDPOINT_HEADER]: 'forged' },
			}),
		)
		expect(response.status).toBe(200)
		expect(seen[0]?.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(me.id, requirementDigest(me)))
		expect(seen[0]?.headers.get('X-Fabrika-Token')).not.toBeNull()
		expect(seen[0]?.headers.get('Authorization')).toBe('Bearer px_key')
	})

	test("a membership endpoint gets its grant from the IAM binding's requestDelegation and forwards it", async () => {
		class DelegatingIam extends FakeIam {
			readonly delegations: DelegationRequest[] = []
			requestDelegation(input: DelegationRequest): Promise<{ ok: true; grant: string; expiresAt: number }> {
				this.delegations.push(input)
				return Promise.resolve({ ok: true, grant: 'grant-1', expiresAt: Math.floor(Date.now() / 1000) + 120 })
			}
		}
		const seen: Request[] = []
		const iam = new DelegatingIam({
			mintFromKey: {
				ok: true,
				token: await signToken({ type: 'user', permissions: [{ action: 'notes.admin', scope: null, source: 'grant' }] }),
				expiresAt: Math.floor(Date.now() / 1000) + 300,
			},
		})
		const response = await createCloudflareProxyHandler(contractEnvironment(iam, seen))(
			new Request(`https://${HOST}/api/workspaces.invite`, {
				method: 'POST',
				body: '{}',
				headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json', [DELEGATION_HEADER]: 'forged' },
			}),
		)
		expect(response.status).toBe(200)
		expect(iam.delegations.map((input) => input.endpoint)).toEqual([invite.id])
		expect(seen[0]?.headers.get(DELEGATION_HEADER)).toBe('grant-1')
	})

	test('no endpoint is a 403 that never reaches the app', async () => {
		const seen: Request[] = []
		const response = await createCloudflareProxyHandler(contractEnvironment(new FakeIam(), seen))(new Request(`https://${HOST}/api/unknown`))
		expect(response.status).toBe(403)
		expect(seen).toEqual([])
	})
})
