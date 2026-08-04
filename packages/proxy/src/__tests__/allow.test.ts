/**
 * The allow paths, and the gate-ordering semantics they depend on. The contract being pinned:
 * an allow is a 204 with the verified token in the copy header, and NOTHING else produces one.
 */

import type { AppGates } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER, REQUEST_ID_HEADER } from '../constants'
import { createVerifyService } from '../service'
import {
	APP,
	FakeIam,
	type FakeIamOptions,
	HOST,
	ISSUER,
	manifestWith,
	signToken,
	signUserToken,
	verifyRequest,
	type VerifyRequestOptions,
} from './helpers'

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

function service(gates: AppGates, options: FakeIamOptions = {}, cache: MemoryTokenCache | null = new MemoryTokenCache()) {
	const iam = new FakeIam(options)
	return { iam, verify: createVerifyService({ manifest: manifestWith(gates), iam, issuer: ISSUER, cache }) }
}

describe('allow — public', () => {
	test('a public path passes with NO token header and no IAM contact', async () => {
		const { iam, verify } = service({ rules: [{ path: '/public/*', kind: 'public' }, { path: '/*', kind: 'human' }] })
		const response = await verify(verifyRequest({ path: '/public/health' }))
		expect(response.status).toBe(204)
		// No header at all: Caddy's copy is guarded by a non-empty check, and the generated config has
		// already deleted any client-supplied one, so the app sees no token — which is correct.
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('a client-supplied token header is never echoed back as the injected one', async () => {
		const forged = await signToken({ type: 'user' }) // even a VALID token must not be reflected
		const { verify } = service({ rules: [{ path: '/*', kind: 'public' }] })
		const response = await verify(verifyRequest({ path: '/x', headers: { [PROXY_TOKEN_HEADER]: forged } }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	})

	test('the normalized request id is returned for Caddy to copy upstream', async () => {
		const { verify } = service({ rules: [{ path: '/*', kind: 'public' }] })
		const response = await verify(verifyRequest({ headers: { [REQUEST_ID_HEADER]: 'request-1' } }))
		expect(response.headers.get(REQUEST_ID_HEADER)).toBe('request-1')
	})
})

describe('allow — human', () => {
	test('a valid px_token cookie authorizes locally and is injected upstream', async () => {
		const token = await signUserToken(3600)
		const { iam, verify } = service({ rules: [{ path: '/*', kind: 'human' }] })
		const response = await verify(verifyRequest({ cookie: `px_token=${token}; other=ignored` }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(iam.mintTokenCalls).toBe(0) // the whole point: warm path, no round trip
	})

	test('a session cookie is exchanged once and the minted token is injected', async () => {
		const token = await signUserToken()
		const { iam, verify } = service({ rules: [{ path: '/*', kind: 'human' }] }, {
			mintToken: { ok: true, token, expiresAt: future() },
		})
		const response = await verify(verifyRequest({ cookie: 'px_session=sess-abc' }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(iam.seenSessions).toEqual(['sess-abc'])
	})
})

describe('allow — service', () => {
	test('a passthrough JWT verifies locally with no IAM exchange', async () => {
		const token = await signToken({}) // anonymous: no ptype
		const { iam, verify } = service({ rules: [{ path: '/*', kind: 'service' }] })
		const response = await verify(verifyRequest({ bearer: token }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(iam.mintFromKeyCalls).toBe(0)
	})

	test('a px_ key is exchanged, then served from cache', async () => {
		const token = await signUserToken()
		const { iam, verify } = service({ rules: [{ path: '/*', kind: 'service' }] }, {
			mintFromKey: { ok: true, token, expiresAt: future() },
		})
		expect((await verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		expect((await verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(1)
	})

	test('a credential in a declared header location is honoured', async () => {
		const token = await signUserToken()
		const { iam, verify } = service({
			rules: [{ path: '/api/v1/*', kind: 'service', credential: { in: 'header', name: 'x-opice-token' } }],
		}, { mintFromKey: { ok: true, token, expiresAt: future() } })
		const response = await verify(verifyRequest({ path: '/api/v1/ingest', headers: { 'x-opice-token': 'px_ci' } }))
		expect(response.status).toBe(204)
		expect(iam.seenKeys).toEqual(['px_ci'])
	})

	test('a credential in a declared query location is honoured', async () => {
		const token = await signToken({})
		const { verify } = service({ rules: [{ path: '/*', kind: 'service', credential: { in: 'query', name: 'pxt' } }] })
		const response = await verify(verifyRequest({ path: `/share?pxt=${token}` }))
		expect(response.status).toBe(204)
	})

	test('a credential in a declared cookie location is honoured', async () => {
		const token = await signToken({})
		const { verify } = service({ rules: [{ path: '/*', kind: 'service', credential: { in: 'cookie', name: 'shr' } }] })
		expect((await verify(verifyRequest({ cookie: `shr=${token}` }))).status).toBe(204)
	})
})

describe('gate ordering — array order is the precedence', () => {
	const SERVICE_THEN_HUMAN: AppGates = { rules: [{ path: '/*', kind: 'service' }, { path: '/*', kind: 'human' }] }

	test('a bearer wins the first (service) rule', async () => {
		const token = await signUserToken()
		const { iam, verify } = service(SERVICE_THEN_HUMAN, {
			mintFromKey: { ok: true, token, expiresAt: future() },
			mintToken: { ok: true, token, expiresAt: future() },
		})
		expect((await verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(1)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('an ABSENT service credential falls through to the human rule', async () => {
		const token = await signUserToken()
		const { iam, verify } = service(SERVICE_THEN_HUMAN, { mintToken: { ok: true, token, expiresAt: future() } })
		expect((await verify(verifyRequest({ cookie: 'px_session=s' }))).status).toBe(204)
		expect(iam.mintFromKeyCalls).toBe(0)
		expect(iam.mintTokenCalls).toBe(1)
	})

	test('EMPTY service credential values are absent and fall through', async () => {
		const token = await signUserToken()
		const options: FakeIamOptions = { mintToken: { ok: true, token, expiresAt: future() } }
		const cases: { gates: AppGates; request: VerifyRequestOptions }[] = [
			{
				gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'header', name: 'X-Service-Key' } }, { path: '/*', kind: 'human' }] },
				request: { headers: { 'X-Service-Key': '   ' }, cookie: 'px_session=s' },
			},
			{
				gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'query', name: 'key' } }, { path: '/*', kind: 'human' }] },
				request: { path: '/x?key=', cookie: 'px_session=s' },
			},
			{
				gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'cookie', name: 'key' } }, { path: '/*', kind: 'human' }] },
				request: { cookie: 'key=; px_session=s' },
			},
		]
		for (const { gates, request } of cases) {
			const { iam, verify } = service(gates, options)
			expect((await verify(verifyRequest(request))).status).toBe(204)
			expect(iam.mintFromKeyCalls).toBe(0)
			expect(iam.mintTokenCalls).toBe(1)
		}
	})

	test('an earlier public rule shadows a later human rule on the same path', async () => {
		const { iam, verify } = service({ rules: [{ path: '/*', kind: 'public' }, { path: '/*', kind: 'human' }] })
		expect((await verify(verifyRequest({ path: '/secret' }))).status).toBe(204)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('a human rule that MISSES still falls through to a later public rule', async () => {
		// Faithful to `AppGates`: only a matched-and-satisfied rule is terminal. An anonymous visitor
		// therefore lands on the public rule rather than being bounced to login.
		const { verify } = service({ rules: [{ path: '/*', kind: 'human' }, { path: '/*', kind: 'public' }] })
		expect((await verify(verifyRequest({ path: '/secret' }))).status).toBe(204)
	})

	test('reordering changes the outcome — precedence is load-bearing', async () => {
		const bad = { mintFromKey: { ok: false as const, reason: 'invalid_key' as const } }
		// service first: a PRESENT-but-invalid credential is terminal, so the public rule is never reached.
		const first = service({ rules: [{ path: '/*', kind: 'service' }, { path: '/*', kind: 'public' }] }, bad)
		expect((await first.verify(verifyRequest({ bearer: 'px_bad' }))).status).toBe(401)
		// public first: the same request is allowed, because the public rule matches and is terminal.
		const second = service({ rules: [{ path: '/*', kind: 'public' }, { path: '/*', kind: 'service' }] }, bad)
		expect((await second.verify(verifyRequest({ bearer: 'px_bad' }))).status).toBe(204)
	})

	test('a non-matching request is unaffected by any rule ordering', async () => {
		const { verify } = service({ rules: [{ path: '/a/*', kind: 'public' }, { path: '/b/*', kind: 'public' }] })
		expect((await verify(verifyRequest({ path: '/a/x' }))).status).toBe(204)
		expect((await verify(verifyRequest({ path: '/b/x' }))).status).toBe(204)
		expect((await verify(verifyRequest({ path: '/c/x' }))).status).toBe(403)
	})

	test('the glob is anchored and case-sensitive, matching the shared contract', async () => {
		const { verify } = service({ rules: [{ path: '/Admin/*', kind: 'public' }] })
		expect((await verify(verifyRequest({ path: '/Admin/users' }))).status).toBe(204)
		// Caddy's own path matcher would treat these as the same. Ours does not — which is precisely
		// why gate rules are NOT compiled into Caddy routes.
		expect((await verify(verifyRequest({ path: '/admin/users' }))).status).toBe(403)
		expect((await verify(verifyRequest({ path: '/x/Admin/users' }))).status).toBe(403)
	})

	test('`*` crosses path separators, matching the shared contract', async () => {
		const { verify } = service({ rules: [{ path: '/api/*/items', kind: 'public' }] })
		// Go's `path.Match`, which Caddy falls back to, would NOT match this. Ours does.
		expect((await verify(verifyRequest({ path: '/api/a/b/items' }))).status).toBe(204)
	})
})

describe('app selection', () => {
	test('the pinned ?app= wins, so a spoofed Host cannot pick another app', async () => {
		const token = await signUserToken(3600)
		const iam = new FakeIam({})
		const verify = createVerifyService({
			manifest: {
				apps: [
					{ id: APP, hosts: [HOST], upstream: 'a:3000', scheme: 'https', gates: { rules: [{ path: '/*', kind: 'human' }] } },
					{ id: 'open-app', hosts: ['open.example.com'], upstream: 'b:3000', scheme: 'https', gates: { rules: [{ path: '/*', kind: 'public' }] } },
				],
			},
			iam,
			issuer: ISSUER,
		})
		// Claiming the open app's host while the route pins the gated app changes nothing.
		const response = await verify(verifyRequest({ app: APP, host: 'open.example.com', cookie: `px_token=${token}` }))
		expect(response.status).toBe(204)
		const spoofed = await verify(verifyRequest({ app: APP, host: 'open.example.com' }))
		expect(spoofed.status).toBe(302)
	})

	test('host lookup is the fallback and is case- and port-insensitive', async () => {
		const { verify } = service({ rules: [{ path: '/*', kind: 'public' }] })
		expect((await verify(verifyRequest({ app: null, host: 'APP.example.com:8443' }))).status).toBe(204)
	})
})
