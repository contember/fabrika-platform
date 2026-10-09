/**
 * The truth table of an installation entry (ADR-0022 "Installation entries"): the five forms only an installation
 * service may use, decided by the same pass as an application's table. Deny rows first; a missing row is a bypass.
 */

import {
	type BodyAdmission,
	ENDPOINT_HEADER,
	formatEndpointHeader,
	type MintTokenResult,
	type PermissionEntry,
	type TokenPrincipalType,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import { BASE_HEADER_POLICY } from '../headers'
import { OAUTH_METADATA_VERIFY_PATH } from '../oauth'
import { createVerifyService, type VerifyService } from '../service'
import {
	APP,
	FakeIam,
	type FakeIamOptions,
	installationAppWith,
	installationRow,
	ISSUER,
	OAUTH_RESOURCE,
	RESOURCE,
	RESOURCE_METADATA,
	signResourceToken,
	signToken,
	verifyRequest,
	type VerifyRequestOptions,
} from './helpers'

const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

const MCP = installationRow({
	id: 'mcp',
	kind: 'service',
	method: '*',
	path: '/mcp',
	callers: ['oauth'],
	requirement: { kind: 'authenticated' },
	admission: null,
	oauth: { scopes: ['mcp:read'] },
})
const RPC = installationRow({
	id: 'rpc',
	kind: 'service',
	method: 'POST',
	path: '/api/rpc',
	callers: ['human', 'machine'],
	requirement: { kind: 'authenticated' },
	admission: JSON_BODY,
	oauth: null,
})
const CONSOLE = installationRow({
	id: 'console',
	kind: 'service',
	method: 'GET',
	path: '/*',
	callers: ['human'],
	requirement: { kind: 'authenticated' },
	admission: null,
	oauth: null,
})
const ADMIN = installationRow({
	id: 'admin',
	kind: 'protocol',
	method: '*',
	path: '/admin/*',
	callers: [],
	requirement: null,
	admission: null,
	oauth: null,
})
const HEALTH = installationRow({
	id: 'health',
	kind: 'health',
	method: 'GET',
	path: '/healthz',
	callers: [],
	requirement: null,
	admission: null,
	oauth: null,
})

const ENTRY = installationAppWith([MCP, RPC, CONSOLE, ADMIN, HEALTH], ['/api'], { oauthResources: [OAUTH_RESOURCE] })

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds
const SESSION = '__Host-px_session=s'
const JSON_POST: VerifyRequestOptions = {
	method: 'POST',
	path: '/api/rpc',
	headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
}

async function minted(
	type: TokenPrincipalType | undefined,
	permissions: PermissionEntry[] = [],
	workload?: string,
): Promise<Extract<MintTokenResult, { ok: true }>> {
	const token = await signToken({ ...(type === undefined ? {} : { type }), ...(workload === undefined ? {} : { workload }), permissions })
	return { ok: true, token, expiresAt: future() }
}

function service(options: FakeIamOptions): { iam: FakeIam; verify: VerifyService } {
	const iam = new FakeIam(options)
	const verify = createVerifyService({ manifest: { apps: [ENTRY] }, iam, issuer: ISSUER, cache: new MemoryTokenCache() })
	return { iam, verify }
}

function expectDenied(response: Response, status: number): void {
	expect(response.status).toBe(status)
	expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	expect(response.headers.get(ENDPOINT_HEADER)).toBeNull()
	expect(response.headers.get('Location')).toBeNull()
}

const challenge = (response: Response): string | null => response.headers.get('WWW-Authenticate')

describe('caller oauth — a row that admits only OAuth resource tokens', () => {
	test('a px_ key is a 403 caller_kind, never an OAuth token', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/mcp', bearer: 'px_machine' })), 403)
		const { verify: asUser } = service({ mintFromKey: await minted('user') })
		expectDenied(await asUser(verifyRequest({ method: 'POST', path: '/mcp', bearer: 'px_user' })), 403)
	})

	test('no bearer is a 401 with the resource metadata challenge and no error code', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp' }))
		expectDenied(response, 401)
		expect(challenge(response)).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`)
	})

	test('another Authorization scheme is answered like no bearer', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp', headers: { Authorization: 'Basic dTpw' } }))
		expectDenied(response, 401)
		expect(challenge(response)).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`)
	})

	test('a session cookie is ignored and never bounced to login', async () => {
		const { iam, verify } = service({ mintToken: await minted('user') })
		const response = await verify(verifyRequest({ method: 'GET', path: '/mcp', cookie: SESSION, headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expectDenied(response, 401)
		expect(challenge(response)).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test.each([
		['another resource', { resource: 'https://app.example.com/other' }],
		['another app', { app: 'another-app' }],
		['an expired token', { ttlSeconds: -60 }],
	])('a token for %s is a 401 invalid_token with the challenge', async (_name, options) => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp', bearer: await signResourceToken(options) }))
		expectDenied(response, 401)
		expect(challenge(response)).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`)
	})

	test('a token without every scope of the row is a 403 insufficient_scope naming the scopes', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp', bearer: await signResourceToken({ scopes: ['mcp:write'] }) }))
		expectDenied(response, 403)
		expect(challenge(response)).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}", error="insufficient_scope", scope="mcp:read"`)
	})

	test('an unreachable key set is a 503, never a challenge', async () => {
		const { verify } = service({ jwksUnreachable: true })
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp', bearer: await signResourceToken() }))
		expectDenied(response, 503)
		expect(challenge(response)).toBeNull()
	})

	test.each(['GET', 'POST', 'DELETE'])('a resource token with the scopes is admitted on %s, with no IAM call', async (method) => {
		const { iam, verify } = service({})
		const token = await signResourceToken()
		const response = await verify(verifyRequest({ method, path: '/mcp', bearer: token }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(response.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(MCP.id, MCP.digest))
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})

	test('a resource token is no caller on a row that does not admit oauth', async () => {
		const { iam, verify } = service({})
		expectDenied(await verify(verifyRequest({ ...JSON_POST, bearer: await signResourceToken() })), 401)
		expect(iam.mintFromKeyCalls).toBe(0)
	})
})

describe('requirement authenticated', () => {
	test('refuses a share-link key and a workload key: the caller kind must be listed', async () => {
		const { verify: link } = service({ mintFromKey: await minted(undefined) })
		expectDenied(await link(verifyRequest({ ...JSON_POST, bearer: 'px_link' })), 403)
		const { verify: job } = service({ mintFromKey: await minted('job', [], 'nightly') })
		expectDenied(await job(verifyRequest({ ...JSON_POST, bearer: 'px_job' })), 403)
	})

	test('a key with no permission is admitted when its caller kind is listed', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		const response = await verify(verifyRequest({ ...JSON_POST, bearer: 'px_machine' }))
		expect(response.status).toBe(204)
		expect(response.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(RPC.id, RPC.digest))
	})

	test('a session with no permission is admitted, and a cross-site session write is still a 403', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		expect((await verify(verifyRequest({ ...JSON_POST, cookie: SESSION }))).status).toBe(204)
		const crossSite = { ...JSON_POST, cookie: SESSION, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' } }
		expectDenied(await verify(verifyRequest(crossSite)), 403)
	})

	test('admission still applies: the row admits only its media type', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, bearer: 'px_machine', headers: { 'Content-Type': 'text/plain' } })), 400)
	})

	test("the console's shell admits a user key without a session: the recorded bounded exception", async () => {
		const { verify } = service({ mintFromKey: await minted('user') })
		expect((await verify(verifyRequest({ path: '/settings', bearer: 'px_user' }))).status).toBe(204)
		const { verify: machine } = service({ mintFromKey: await minted('service') })
		expectDenied(await machine(verifyRequest({ path: '/settings', bearer: 'px_machine' })), 403)
	})

	test('the console bounces a navigation without a session to login', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ path: '/settings', headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')?.startsWith(`${ISSUER}/auth/login?app=${APP}`)).toBe(true)
	})
})

describe('kind protocol', () => {
	test('reads no credential, mints no token and names its endpoint, whatever the method', async () => {
		const { iam, verify } = service({ mintFromKey: await minted('service'), mintToken: await minted('user') })
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const response = await verify(verifyRequest({ method, path: '/admin/apps/notes/schema', bearer: 'px_provisioning', cookie: SESSION }))
			expect(response.status).toBe(204)
			expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
			expect(response.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(ADMIN.id, ADMIN.digest))
		}
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})
})

describe('selection with method *', () => {
	test('the * row on /mcp outranks the console wildcard for every method, so /mcp never bounces', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ path: '/mcp', headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expectDenied(response, 401)
		expect(challenge(response)).not.toBeNull()
	})

	test('a method no row serves, and an unknown path under a reserved prefix, are 403', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		expectDenied(await verify(verifyRequest({ method: 'DELETE', path: '/settings', cookie: SESSION })), 403)
		expectDenied(await verify(verifyRequest({ path: '/api/other', cookie: SESSION })), 403)
	})
})

describe('the proxy answers of an installation entry', () => {
	test('a denial carries the base policy, not an application policy', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ method: 'POST', path: '/mcp' }))
		const [name, value] = BASE_HEADER_POLICY.find(([header]) => header === 'Content-Security-Policy') ?? ['', '']
		expect(response.headers.get(name)).toBe(value)
	})

	test("the entry's RFC 9728 metadata is answered by the proxy", async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: '/.well-known/oauth-protected-resource/mcp' }))
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ resource: RESOURCE, scopes_supported: ['mcp:read', 'mcp:write'] })
	})
})
