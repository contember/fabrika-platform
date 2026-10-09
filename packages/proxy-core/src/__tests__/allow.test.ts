/**
 * The allow paths, and the row semantics they depend on. The contract being pinned: an allow is a 204
 * with the verified token in the copy header, and NOTHING else produces one.
 */

import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER, REQUEST_ID_HEADER } from '../constants'
import type { InstallationProxyEndpointRow } from '../manifest'
import { createVerifyService } from '../service'
import {
	APP,
	contractAppWith,
	endpointRow,
	FakeIam,
	type FakeIamOptions,
	HOST,
	installationAppWith,
	ISSUER,
	manifestWith,
	protocolRow,
	serviceRow,
	signToken,
	signUserToken,
	verifyRequest,
} from './helpers'

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

function service(endpoints: InstallationProxyEndpointRow[], options: FakeIamOptions = {}, cache: MemoryTokenCache | null = new MemoryTokenCache()) {
	const iam = new FakeIam(options)
	return { iam, verify: createVerifyService({ manifest: manifestWith(endpoints), iam, issuer: ISSUER, cache }) }
}

describe('allow — the audience is the manifest id', () => {
	const SPA = endpointRow({ id: 'web', kind: 'spa', method: 'GET', path: '/*', callers: ['human'], requirement: { kind: 'member' }, admission: null })
	const ENVIRONMENT = { apps: [contractAppWith([SPA], [], { id: 'notes@prod' })] }

	test('an application environment <app>@<env> is minted for and verified under that id', async () => {
		const token = await signToken({ type: 'user', audience: 'notes@prod' })
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: future() } })
		const verify = createVerifyService({ manifest: ENVIRONMENT, iam, issuer: ISSUER, cache: null })
		const response = await verify(verifyRequest({ cookie: '__Host-px_session=s', app: 'notes@prod' }))
		expect(response.status).toBe(204)
		expect(iam.seenApps).toEqual(['notes@prod'])
	})

	test('a token minted for another environment of the same app is refused', async () => {
		const token = await signToken({ type: 'user', audience: 'notes@stage' })
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: future() } })
		const verify = createVerifyService({ manifest: ENVIRONMENT, iam, issuer: ISSUER, cache: null })
		const response = await verify(verifyRequest({ cookie: '__Host-px_session=s', app: 'notes@prod' }))
		expect(response.status).not.toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	})
})

describe('allow — protocol', () => {
	test('a protocol path passes with NO token header and no IAM contact', async () => {
		const { iam, verify } = service([protocolRow('/public/*'), serviceRow('/*', ['human'])])
		const response = await verify(verifyRequest({ path: '/public/health' }))
		expect(response.status).toBe(204)
		// No header at all: Caddy's copy is guarded by a non-empty check, and the generated config has
		// already deleted any client-supplied one, so the app sees no token — which is correct.
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('a client-supplied token header is never echoed back as the injected one', async () => {
		const forged = await signToken({ type: 'user' }) // even a VALID token must not be reflected
		const { verify } = service([protocolRow('/*')])
		const response = await verify(verifyRequest({ path: '/x', headers: { [PROXY_TOKEN_HEADER]: forged } }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	})

	test('the normalized request id is returned for Caddy to copy upstream', async () => {
		const { verify } = service([protocolRow('/*')])
		const response = await verify(verifyRequest({ headers: { [REQUEST_ID_HEADER]: 'request-1' } }))
		expect(response.headers.get(REQUEST_ID_HEADER)).toBe('request-1')
	})
})

describe('allow — human', () => {
	test('a session cookie is exchanged once and the minted token is injected', async () => {
		const token = await signUserToken()
		const { iam, verify } = service([serviceRow('/*', ['human'])], {
			mintToken: { ok: true, token, expiresAt: future() },
		})
		const response = await verify(verifyRequest({ cookie: '__Host-px_session=sess-abc' }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(iam.seenSessions).toEqual(['sess-abc'])
	})
})

describe('allow — machine', () => {
	test('a px_ key is exchanged, then served from cache', async () => {
		const token = await signToken({ type: 'service' })
		const { iam, verify } = service([serviceRow('/*', ['machine'])], {
			mintFromKey: { ok: true, token, expiresAt: future() },
		})
		expect((await verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		expect((await verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(1)
	})
})

describe('one row, one credential', () => {
	const EITHER = [serviceRow('/*', ['human', 'machine'])]

	test('a px_ key is used and the session beside it is never consulted', async () => {
		const token = await signToken({ type: 'service' })
		const { iam, verify } = service(EITHER, {
			mintFromKey: { ok: true, token, expiresAt: future() },
			mintToken: { ok: true, token: await signUserToken(), expiresAt: future() },
		})
		expect((await verify(verifyRequest({ bearer: 'px_ci', cookie: '__Host-px_session=s' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(1)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('with no key, the session is used when human is a caller', async () => {
		const token = await signUserToken()
		const { iam, verify } = service(EITHER, { mintToken: { ok: true, token, expiresAt: future() } })
		expect((await verify(verifyRequest({ cookie: '__Host-px_session=s' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(0)
		expect(iam.mintTokenCalls).toBe(1)
	})

	test('an EMPTY Authorization header is absent, so the session is used', async () => {
		const token = await signUserToken()
		const { iam, verify } = service(EITHER, { mintToken: { ok: true, token, expiresAt: future() } })
		expect((await verify(verifyRequest({ headers: { Authorization: '   ' }, cookie: '__Host-px_session=s' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(0)
		expect(iam.mintTokenCalls).toBe(1)
	})

	test('a path no row serves is denied', async () => {
		const { verify } = service([protocolRow('/a/*'), protocolRow('/b/*')])
		expect((await verify(verifyRequest({ path: '/a/x' }))).status).toBe(204)
		expect((await verify(verifyRequest({ path: '/b/x' }))).status).toBe(204)
		expect((await verify(verifyRequest({ path: '/c/x' }))).status).toBe(403)
	})

	test('a path is anchored and case-sensitive, matching the shared planner', async () => {
		const { verify } = service([protocolRow('/Admin/*')])
		expect((await verify(verifyRequest({ path: '/Admin/users' }))).status).toBe(204)
		// Caddy's own path matcher would treat these as the same. Ours does not — which is precisely
		// why endpoint tables are NOT compiled into Caddy routes.
		expect((await verify(verifyRequest({ path: '/admin/users' }))).status).toBe(403)
		expect((await verify(verifyRequest({ path: '/x/Admin/users' }))).status).toBe(403)
	})

	test('a trailing `*` crosses path separators, matching the shared planner', async () => {
		const { verify } = service([protocolRow('/api/*')])
		// Go's `path.Match`, which Caddy falls back to, stops `*` at a `/`. Ours does not.
		expect((await verify(verifyRequest({ path: '/api/a/b/items' }))).status).toBe(204)
	})
})

describe('app selection', () => {
	test('the pinned ?app= wins, so a spoofed Host cannot pick another app', async () => {
		const token = await signUserToken(3600)
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: future(3600) } })
		const verify = createVerifyService({
			manifest: {
				apps: [
					installationAppWith([serviceRow('/*', ['human'])], [], { upstream: 'a:3000' }),
					installationAppWith([protocolRow('/*')], [], { id: 'open-app', hosts: ['open.example.com'], upstream: 'b:3000' }),
				],
			},
			iam,
			issuer: ISSUER,
		})
		// The pin decides, so the open app's protocol row is never reached...
		expect((await verify(verifyRequest({ app: APP, host: HOST, cookie: '__Host-px_session=session' }))).status).toBe(204)
		expect((await verify(verifyRequest({ app: APP, host: HOST }))).status).toBe(302)
		// ...and claiming a host the pinned app does not declare is refused outright, so the forwarded
		// host can never end up building a URL for an origin the manifest never mentioned.
		expect((await verify(verifyRequest({ app: APP, host: 'open.example.com', cookie: '__Host-px_session=session' }))).status).toBe(403)
	})

	test('a pinned app still matches its own host case- and port-insensitively', async () => {
		const { verify } = service([protocolRow('/*')])
		expect((await verify(verifyRequest({ app: APP, host: 'APP.example.com:8443' }))).status).toBe(204)
	})

	test('host lookup is the fallback and is case- and port-insensitive', async () => {
		const { verify } = service([protocolRow('/*')])
		expect((await verify(verifyRequest({ app: null, host: 'APP.example.com:8443' }))).status).toBe(204)
	})
})
