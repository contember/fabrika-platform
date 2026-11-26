/**
 * An agent's device grant at an application environment (ADR-0090; ADR-0022 rule 3, steps 3 and 5). On a row that lists
 * `agent`, a bearer that is not a `px_` key is the agent's resource token of this host: verified locally, then exchanged
 * at IAM for the person's application token, which the scope's kinds then bound. Everywhere else it stays what it was.
 */

import {
	AGENT_CLIENT_ID,
	type AgentActClaims,
	type BodyAdmission,
	type MintFromGrantResult,
	narrowToValue,
	OAUTH_CLI_CLIENT_ID,
	parseAgentScope,
	SESSION_COOKIE,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { cacheKey, grantCacheCredential, MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import { formatOAuthBearerChallenge, type OAuthBearerChallenge, type ProxyEndpointRow } from '../manifest'
import { AGENT_METADATA_PATH, OAUTH_METADATA_VERIFY_PATH } from '../oauth'
import { createVerifyService } from '../service'
import {
	anonymousRow,
	APP,
	contractAppWith,
	endpointRow,
	FakeGrants,
	FakeIam,
	foreignPrivateKey,
	HOST,
	ISSUER,
	PERMS,
	type ResourceSignOptions,
	signResourceToken,
	signToken,
	signUserToken,
	verifyRequest,
	type VerifyRequestOptions,
} from './helpers'

const RESOURCE = `https://${HOST}`
const METADATA = `${RESOURCE}${AGENT_METADATA_PATH}`
const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: 1024 }

const LIST = endpointRow({
	id: 'api.notes.list',
	kind: 'query',
	method: 'POST',
	path: '/api/notes.list',
	callers: ['human', 'agent'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const CREATE = endpointRow({
	id: 'api.notes.create',
	kind: 'mutation',
	method: 'POST',
	path: '/api/notes.create',
	callers: ['human', 'agent'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const SHELL = endpointRow({
	id: 'app',
	kind: 'spa',
	method: 'GET',
	path: '/app',
	callers: ['human', 'agent'],
	requirement: { kind: 'member' },
	admission: null,
})
const ADMIN = endpointRow({
	id: 'api.admin.list',
	kind: 'query',
	method: 'POST',
	path: '/api/admin.list',
	callers: ['human', 'machine'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const MACHINE_ONLY = endpointRow({
	id: 'machine.export',
	kind: 'query',
	method: 'POST',
	path: '/machine/export',
	callers: ['machine', 'agent'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})

const ROWS: ProxyEndpointRow[] = [LIST, CREATE, SHELL, ADMIN, MACHINE_ONLY]
/** An application's own public row at the metadata path. */
const WELL_KNOWN = anonymousRow({ id: 'well-known', kind: 'public', method: 'GET', path: AGENT_METADATA_PATH, admission: null })

const JSON_POST = (path: string, bearer?: string): VerifyRequestOptions => ({
	method: 'POST',
	path,
	headers: { 'Content-Type': 'application/json' },
	...(bearer === undefined ? {} : { bearer }),
})

function act(token: string): AgentActClaims {
	const scope = parseAgentScope(token)
	if (scope === null) throw new Error(`not a scope token: ${token}`)
	return { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope, label: 'my agent' }
}

/** What IAM's exchange answers: the person's application token carrying `act`. */
async function exchanged(scope = 'read', options: { act?: AgentActClaims | null } = {}): Promise<MintFromGrantResult> {
	const claim = options.act === undefined ? act(scope) : options.act
	const token = await signToken({ type: 'user', ...(claim === null ? {} : { act: claim }) })
	return { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 }
}

/** The agent's resource token of this host, as IAM's device flow issues it for `agent-cli`. */
function agentToken(options: ResourceSignOptions = {}): Promise<string> {
	return signResourceToken({ resource: RESOURCE, clientId: AGENT_CLIENT_ID, scopes: ['read'], permissions: [], ...options })
}

function service(grants: FakeGrants, options: { rows?: ProxyEndpointRow[]; iam?: FakeIam; cache?: MemoryTokenCache } = {}) {
	const iam = options.iam ?? new FakeIam()
	return createVerifyService({
		manifest: { apps: [contractAppWith(options.rows ?? ROWS)] },
		iam,
		revocations: iam,
		issuer: ISSUER,
		cache: options.cache ?? new MemoryTokenCache(),
		grants,
	})
}

function expectChallenge(response: Response, status: number, parameters: Omit<OAuthBearerChallenge, 'resource_metadata'> = {}): void {
	expect(response.status).toBe(status)
	expect(response.headers.get('WWW-Authenticate')).toBe(formatOAuthBearerChallenge({ resource_metadata: METADATA, ...parameters }))
	expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	expect(response.headers.get('location')).toBeNull()
	expect(response.headers.get('set-cookie')).toBeNull()
}

describe('the exchange on a row that lists agent', () => {
	test("a resource token of this host is verified locally, exchanged once, and the person's token is injected", async () => {
		const answer = await exchanged()
		const grants = new FakeGrants(answer)
		const iam = new FakeIam()
		const verify = service(grants, { iam })
		const token = await agentToken()
		const response = await verify(
			verifyRequest({ ...JSON_POST('/api/notes.list', token), headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-1' } }),
		)
		expect(response.status).toBe(204)
		expect(answer.ok && response.headers.get(PROXY_TOKEN_HEADER) === answer.token).toBe(true)
		expect(grants.seen).toHaveLength(1)
		expect(grants.seen[0]).toMatchObject({ app: APP, resource: RESOURCE, token })
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})

	test('the exchanged token is cached under the digest of the resource token until 30 s before it expires', async () => {
		const grants = new FakeGrants(await exchanged())
		const cache = new MemoryTokenCache()
		const verify = service(grants, { cache })
		const token = await agentToken()
		for (let i = 0; i < 3; i++) {
			expect((await verify(verifyRequest(JSON_POST('/api/notes.list', token)))).status).toBe(204)
		}
		expect(grants.seen).toHaveLength(1)
		expect(cache.get(cacheKey(APP, 'grant', await grantCacheCredential(token)))).toBeDefined()
		expect(cache.get(cacheKey(APP, 'grant', token))).toBeUndefined()

		// An answer that expires within the refresh skew is used for its request and then exchanged again.
		const near = await signToken({ type: 'user', act: act('read'), ttlSeconds: 20 })
		const short = new FakeGrants({ ok: true, token: near, expiresAt: Math.floor(Date.now() / 1000) + 20 })
		const again = service(short)
		for (let i = 0; i < 2; i++) {
			expect((await again(verifyRequest(JSON_POST('/api/notes.list', token)))).status).toBe(204)
		}
		expect(short.seen).toHaveLength(2)
	})

	test('a cached exchange is not served once the revocation feed lists the person: the next request exchanges again', async () => {
		const grants = new FakeGrants(await exchanged())
		const now = Math.floor(Date.now() / 1000)
		const iam = new FakeIam({ revocations: { ok: true, now, complete: true, subjects: [{ subject: 'user-1', at: now }] } })
		const verify = service(grants, { iam })
		const token = await agentToken()
		for (let i = 0; i < 2; i++) {
			expect((await verify(verifyRequest(JSON_POST('/api/notes.list', token)))).status).toBe(204)
		}
		expect(grants.seen).toHaveLength(2)
		expect(iam.revocationsCalls).toBe(1)
	})

	test('a refused exchange is a 401 with the challenge, never a session fallback', async () => {
		for (const reason of ['invalid_grant', 'write_refused'] as const) {
			const grants = new FakeGrants({ ok: false, reason })
			const iam = new FakeIam({ mintToken: { ok: true, token: await signUserToken(), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
			const response = await service(grants, { iam })(
				verifyRequest({ ...JSON_POST('/api/notes.list', await agentToken()), cookie: `${SESSION_COOKIE}=session` }),
			)
			expectChallenge(response, 401, { error: 'invalid_token' })
			expect(grants.seen).toHaveLength(1)
			expect(iam.mintTokenCalls).toBe(0)
		}
	})

	test('an exchange that answers a token without act, or for another person or grant, is refused and not cached', async () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 300
		const answers: MintFromGrantResult[] = [
			await exchanged('read', { act: null }),
			{ ok: true, token: await signToken({ type: 'user', subject: 'user-2', act: act('read') }), expiresAt },
			{ ok: true, token: await signToken({ type: 'user', act: { ...act('read'), grant: 'grant-2' } }), expiresAt },
		]
		for (const answer of answers) {
			const grants = new FakeGrants(answer)
			const verify = service(grants)
			const token = await agentToken()
			for (let i = 0; i < 2; i++) {
				expectChallenge(await verify(verifyRequest(JSON_POST('/api/notes.list', token))), 401, { error: 'invalid_token' })
			}
			expect(grants.seen).toHaveLength(2)
		}
	})

	test('the cached exchange never outlives the resource token it was exchanged for', async () => {
		const grants = new FakeGrants(await exchanged())
		const verify = service(grants)
		const token = await agentToken({ ttlSeconds: 25 })
		for (let i = 0; i < 2; i++) {
			expect((await verify(verifyRequest(JSON_POST('/api/notes.list', token)))).status).toBe(204)
		}
		// IAM's answer lives 300 s, the resource token 25 s: inside the refresh skew, so each request exchanges again.
		expect(grants.seen).toHaveLength(2)
	})

	test('an exchange IAM cannot answer is 503, and an IAM that refuses the token as too large is 403', async () => {
		const unavailable = createVerifyService({ manifest: { apps: [contractAppWith(ROWS)] }, iam: new FakeIam(), issuer: ISSUER, grants: null })
		expect((await unavailable(verifyRequest(JSON_POST('/api/notes.list', await agentToken())))).status).toBe(503)
		const large = new FakeGrants({ ok: false, reason: 'token_too_large' })
		expectChallenge(await service(large)(verifyRequest(JSON_POST('/api/notes.list', await agentToken()))), 403)
	})
})

describe('local verification, before any IAM call', () => {
	const refused: Record<string, ResourceSignOptions> = {
		'a token for another host': { resource: 'https://other.example.com' },
		"a token for this host's path": { resource: `${RESOURCE}/mcp` },
		'a token for another application': { app: 'other-app' },
		'the console client': { clientId: OAUTH_CLI_CLIENT_ID },
		'an MCP client': { clientId: 'https://client.example.com/metadata.json' },
		'a foreign key': { key: foreignPrivateKey },
		'an expired token': { ttlSeconds: -1 },
		'no typ header': { typ: null },
	}
	for (const [name, options] of Object.entries(refused)) {
		test(`${name} is a 401 invalid_token challenge with no exchange`, async () => {
			const grants = new FakeGrants(await exchanged())
			expectChallenge(await service(grants)(verifyRequest(JSON_POST('/api/notes.list', await agentToken(options)))), 401, { error: 'invalid_token' })
			expect(grants.seen).toHaveLength(0)
		})
	}

	test("a native application token, the person's own, is no resource token", async () => {
		const grants = new FakeGrants(await exchanged())
		expectChallenge(await service(grants)(verifyRequest(JSON_POST('/api/notes.list', await signUserToken()))), 401, { error: 'invalid_token' })
		expect(grants.seen).toHaveLength(0)
	})

	test('another Authorization scheme is a 401 challenge without an error code', async () => {
		const grants = new FakeGrants(await exchanged())
		const response = await service(grants)(
			verifyRequest({ ...JSON_POST('/api/notes.list'), headers: { 'Content-Type': 'application/json', Authorization: 'Basic x' } }),
		)
		expectChallenge(response, 401)
		expect(grants.seen).toHaveLength(0)
	})
})

describe('a row that does not list agent', () => {
	test('a resource token stays invalid_key with no IAM call and no challenge', async () => {
		const grants = new FakeGrants(await exchanged())
		const iam = new FakeIam()
		const response = await service(grants, { iam })(verifyRequest(JSON_POST('/api/admin.list', await agentToken())))
		expect(response.status).toBe(401)
		expect(response.headers.get('WWW-Authenticate')).toBeNull()
		expect(grants.seen).toHaveLength(0)
		expect(iam.mintFromKeyCalls + iam.mintTokenCalls).toBe(0)
	})

	test('an application that lists agent nowhere never exchanges and publishes no metadata', async () => {
		const grants = new FakeGrants(await exchanged())
		const verify = service(grants, { rows: [ADMIN] })
		expect((await verify(verifyRequest(JSON_POST('/api/admin.list', await agentToken())))).status).toBe(401)
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: AGENT_METADATA_PATH }))).status).toBe(404)
		expect(grants.seen).toHaveLength(0)
	})
})

describe('the caller and the scope (ADR-0022 rule 3, step 5)', () => {
	test('a read grant reaches a query, and is 403 scope with an insufficient_scope challenge on a mutation', async () => {
		const verify = service(new FakeGrants(await exchanged('read')))
		const token = await agentToken()
		expect((await verify(verifyRequest(JSON_POST('/api/notes.list', token)))).status).toBe(204)
		expectChallenge(await verify(verifyRequest(JSON_POST('/api/notes.create', token))), 403, { error: 'insufficient_scope', scope: 'write' })
	})

	test('the insufficient_scope challenge keeps the narrowing the person approved', async () => {
		const within = { type: 'project', value: 'a' }
		const token = await signToken({ type: 'user', act: act('read:project=a'), permissions: narrowToValue(PERMS, within) })
		const verify = service(new FakeGrants({ ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 }))
		const response = await verify(verifyRequest(JSON_POST('/api/notes.create', await agentToken())))
		expectChallenge(response, 403, { error: 'insufficient_scope', scope: 'write:project=a' })
	})

	test('a write grant reaches the mutation, and a narrowed one is read by its mode', async () => {
		expect((await service(new FakeGrants(await exchanged('write')))(verifyRequest(JSON_POST('/api/notes.create', await agentToken())))).status).toBe(
			204,
		)
		const narrowed = await signToken({
			type: 'user',
			act: act('read:project=a'),
			permissions: [{ action: 'demo.read', scope: { type: 'project', value: 'a' }, source: 'grant' }],
		})
		const grants = new FakeGrants({ ok: true, token: narrowed, expiresAt: Math.floor(Date.now() / 1000) + 300 })
		const verify = service(grants)
		expect((await verify(verifyRequest(JSON_POST('/api/notes.list', await agentToken())))).status).toBe(204)
		expect((await verify(verifyRequest(JSON_POST('/api/notes.create', await agentToken())))).status).toBe(403)
	})

	test('no scope admits an SPA: 403 scope with a plain challenge', async () => {
		const response = await service(new FakeGrants(await exchanged('write')))(verifyRequest({ path: '/app', bearer: await agentToken() }))
		expectChallenge(response, 403)
	})

	test('a person without a session on a row only machines and agents call is a 401 challenge, not a login', async () => {
		const response = await service(new FakeGrants(await exchanged()))(
			verifyRequest({ ...JSON_POST('/machine/export'), headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'navigate' } }),
		)
		expectChallenge(response, 401)
	})

	test('a refused px_ key on a row that lists agent carries the challenge too', async () => {
		const iam = new FakeIam({ mintFromKey: { ok: false, reason: 'invalid_key' } })
		expectChallenge(await service(new FakeGrants(), { iam })(verifyRequest(JSON_POST('/api/notes.list', 'px_unknown'))), 401, {
			error: 'invalid_token',
		})
		expect(iam.mintFromKeyCalls).toBe(1)
	})

	test('a session still reaches a row that lists human beside agent', async () => {
		const iam = new FakeIam({ mintToken: { ok: true, token: await signUserToken(), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const response = await service(new FakeGrants(), { iam })(verifyRequest({
			...JSON_POST('/api/notes.list'),
			cookie: `${SESSION_COOKIE}=session`,
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
		}))
		expect(response.status).toBe(204)
	})

	test('an origin that forms no resource (http off loopback) serves no agent, and a session still reaches the row', async () => {
		const grants = new FakeGrants(await exchanged())
		const iam = new FakeIam({ mintToken: { ok: true, token: await signUserToken(), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const verify = createVerifyService({
			manifest: { apps: [contractAppWith(ROWS, [], { scheme: 'http' })] },
			iam,
			revocations: iam,
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
			grants,
		})
		const refused = await verify(verifyRequest(JSON_POST('/api/notes.list', await agentToken())))
		expect(refused.status).toBe(401)
		expect(refused.headers.get('WWW-Authenticate')).toBeNull()
		expect(grants.seen).toHaveLength(0)
		const session = await verify(verifyRequest({
			...JSON_POST('/api/notes.list'),
			cookie: `${SESSION_COOKIE}=session`,
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
		}))
		expect(session.status).toBe(204)
	})
})

describe('the protected-resource metadata (RFC 9728)', () => {
	test('an application that lists agent publishes its origin, IAM and the two scopes', async () => {
		const response = await service(new FakeGrants())(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: AGENT_METADATA_PATH }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			resource: RESOURCE,
			authorization_servers: [ISSUER],
			scopes_supported: ['read', 'write'],
			bearer_methods_supported: ['header'],
		})
	})

	test('another casing of the path is 404 at the metadata endpoint, and the path is never the application’s', async () => {
		const verify = service(new FakeGrants())
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: AGENT_METADATA_PATH.toUpperCase() }))).status).toBe(404)
		expect((await service(new FakeGrants(), { rows: [...ROWS, WELL_KNOWN] })(verifyRequest({ path: AGENT_METADATA_PATH }))).status).toBe(404)
	})

	test('an application that lists agent nowhere serves the path from its own rows, as before', async () => {
		expect((await service(new FakeGrants(), { rows: [ADMIN, WELL_KNOWN] })(verifyRequest({ path: AGENT_METADATA_PATH }))).status).toBe(204)
	})
})
