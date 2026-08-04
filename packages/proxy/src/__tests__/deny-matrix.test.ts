/**
 * THE fail-closed matrix. Every way a request can fail to be authorized, asserted to produce a
 * non-2xx — because in Caddy's `forward_auth` a 2xx is the *only* thing that lets the request through
 * to the app. A single missing row here is a bypass.
 *
 * Each test names the failure and the status it must produce.
 */

import { type AppGates, TOKEN_REFRESH_SKEW_SECONDS } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { cacheKey, MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import { createVerifyService, type VerifyService } from '../service'
import { APP, FakeIam, type FakeIamOptions, foreignPrivateKey, ISSUER, manifestWith, signToken, signUserToken, verifyRequest } from './helpers'

const HUMAN: AppGates = { rules: [{ path: '/*', kind: 'human' }] }
const SERVICE: AppGates = { rules: [{ path: '/*', kind: 'service' }] }
const PUBLIC_THEN_HUMAN: AppGates = { rules: [{ path: '/public/*', kind: 'public' }, { path: '/*', kind: 'human' }] }

function service(gates: AppGates, iam: FakeIam, cache: MemoryTokenCache | null = new MemoryTokenCache()): VerifyService {
	return createVerifyService({ manifest: manifestWith(gates), iam, issuer: ISSUER, cache })
}

function iamWith(options: FakeIamOptions): FakeIam {
	return new FakeIam(options)
}

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

/** The single assertion that matters everywhere: Caddy only continues on 2xx. */
function expectDenied(response: Response): void {
	expect(response.status).toBeGreaterThanOrEqual(300)
	expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
}

describe('deny — nothing matched', () => {
	test('a path matching NO gate rule is denied 403', async () => {
		const verify = service({ rules: [{ path: '/api/*', kind: 'service' }] }, iamWith({}))
		const response = await verify(verifyRequest({ path: '/elsewhere' }))
		expect(response.status).toBe(403)
		expectDenied(response)
	})

	test('an app with an EMPTY rule list denies everything', async () => {
		const verify = service({ rules: [] }, iamWith({}))
		expectDenied(await verify(verifyRequest({ path: '/' })))
		expectDenied(await verify(verifyRequest({ path: '/anything/at/all' })))
	})

	test('an unknown app id is denied 403 — there is no default app', async () => {
		const verify = service(HUMAN, iamWith({}))
		const response = await verify(verifyRequest({ app: 'not-in-the-manifest' }))
		expect(response.status).toBe(403)
	})

	test('an unknown Host (no pinned app) is denied 403', async () => {
		const verify = service(HUMAN, iamWith({}))
		const response = await verify(verifyRequest({ app: null, host: 'someone-elses.example.com' }))
		expect(response.status).toBe(403)
	})
})

describe('deny — the forwarded request is not describable', () => {
	test('a missing X-Forwarded-Uri denies rather than falling back to the /verify path', async () => {
		// Critical: /verify would match a `/*` public rule and let everything through.
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		const response = await verify(verifyRequest({ forwardedUri: null }))
		expect(response.status).toBe(403)
	})

	test('an X-Forwarded-Uri that is not a path is denied', async () => {
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		expectDenied(await verify(verifyRequest({ forwardedUri: 'https://evil.example/x' })))
		expectDenied(await verify(verifyRequest({ forwardedUri: 'page' })))
	})

	test('a protocol-relative //host/path cannot move the host or the login target', async () => {
		const iam = iamWith({})
		const verify = service(HUMAN, iam)
		const response = await verify(verifyRequest({ forwardedUri: '//evil.example/steal' }))
		// Either denied outright or bounced to login — but never to evil.example.
		expect(response.headers.get('location') ?? '').not.toContain('evil.example/steal')
		expect(response.status).toBeGreaterThanOrEqual(300)
	})

	test('a missing host is denied', async () => {
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		const response = await verify(verifyRequest({ forwardedHost: null, app: null }))
		expect(response.status).toBe(403)
	})

	test('a syntactically impossible host is denied', async () => {
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		expectDenied(await verify(verifyRequest({ forwardedHost: 'evil.example/../x' })))
		expectDenied(await verify(verifyRequest({ forwardedHost: 'a b' })))
	})

	test('a non-GET subrequest is refused — forward_auth always rewrites to GET', async () => {
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		const request = new Request(`http://127.0.0.1:9000/verify?app=${APP}`, { method: 'POST' })
		expect((await verify(request)).status).toBe(405)
	})

	test('a request to any path other than /verify is 404, not a decision', async () => {
		const verify = service({ rules: [{ path: '/*', kind: 'public' }] }, iamWith({}))
		expect((await verify(new Request('http://127.0.0.1:9000/'))).status).toBe(404)
	})
})

describe('deny — human gate', () => {
	test('no cookies at all → 302 to IAM login, with the original URL as the return target', async () => {
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ path: '/dashboard' }))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(
			`${ISSUER}/auth/login?app=example-app&redirect=${encodeURIComponent('https://app.example.com/dashboard')}`,
		)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		// No session cookie → the answer is knowable locally; IAM is not consulted.
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('an invalid session → 302, never a pass-through', async () => {
		const iam = iamWith({ mintToken: { ok: false, reason: 'invalid_session' } })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=zombie' }))
		expect(response.status).toBe(302)
		expect(iam.mintTokenCalls).toBe(1)
	})

	test('a disabled principal → 302', async () => {
		const iam = iamWith({ mintToken: { ok: false, reason: 'disabled' } })
		expect((await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=s' }))).status).toBe(302)
	})

	test('a malformed Cookie header is treated as no cookie, not as a match', async () => {
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session; =; ;;; px_token' }))
		expect(response.status).toBe(302)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('an empty cookie value is absent, not an empty credential', async () => {
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=; px_token=' }))
		expect(response.status).toBe(302)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('a forged px_token signed by a key IAM never published is rejected', async () => {
		const forged = await signToken({ key: foreignPrivateKey, type: 'user' })
		const iam = iamWith({}) // mintToken → no_session, so there is no second way in
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: `px_token=${forged}; px_session=s` }))
		expect(response.status).toBe(302)
	})

	test('a px_token minted for ANOTHER app is rejected (aud binding)', async () => {
		const otherApp = await signToken({ audience: 'some-other-app', type: 'user' })
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: `px_token=${otherApp}` }))
		expect(response.status).toBe(302)
	})

	test('a px_token from another issuer is rejected', async () => {
		const wrongIssuer = await signToken({ issuer: 'https://evil.example', type: 'user' })
		const response = await service(HUMAN, iamWith({}))(verifyRequest({ cookie: `px_token=${wrongIssuer}` }))
		expect(response.status).toBe(302)
	})

	test('an expired px_token does not authorize', async () => {
		const expired = await signToken({ ttlSeconds: -60, type: 'user' })
		const response = await service(HUMAN, iamWith({}))(verifyRequest({ cookie: `px_token=${expired}` }))
		expect(response.status).toBe(302)
	})

	test('a token expiring inside the refresh skew is not ridden', async () => {
		const nearlyExpired = await signToken({ ttlSeconds: TOKEN_REFRESH_SKEW_SECONDS - 5, type: 'user' })
		const iam = iamWith({}) // no session → cannot refresh → deny
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: `px_token=${nearlyExpired}` }))
		expect(response.status).toBe(302)
	})

	test('garbage in px_token is rejected without crashing', async () => {
		const response = await service(HUMAN, iamWith({}))(verifyRequest({ cookie: 'px_token=not.a.jwt' }))
		expect(response.status).toBe(302)
	})

	test('IAM mints a token we cannot verify → deny, never trust the mint', async () => {
		const unverifiable = await signToken({ key: foreignPrivateKey, type: 'user' })
		const iam = iamWith({ mintToken: { ok: true, token: unverifiable, expiresAt: future() } })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=s' }))
		expect(response.status).toBe(302)
	})
})

describe('deny — a human gate admits a USER principal, not merely a valid token', () => {
	// `px_token` is client-supplied — the proxy only ever sets `px_session` — and a valid token is not
	// the same thing as a resolved user. `issueJwt` hands out an anonymous token for the app, up to 24h
	// and not revocable; `mintFromKey` signs `ptype: 'service'`. Neither is a human.
	test('an ANONYMOUS token (no ptype) in px_token does not satisfy a human gate', async () => {
		const anonymous = await signToken({}) // exactly what `issueJwt` signs for a share link
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: `px_token=${anonymous}` }))
		expect(response.status).toBe(302)
		expectDenied(response)
	})

	test('a SERVICE token in px_token does not satisfy a human gate', async () => {
		const machine = await signToken({ type: 'service' })
		const response = await service(HUMAN, iamWith({}))(verifyRequest({ cookie: `px_token=${machine}` }))
		expect(response.status).toBe(302)
	})

	test('a non-user token cannot ride in on the session tier either', async () => {
		// Even if IAM somehow answered a session exchange with a non-user token, it is not a human.
		const iam = iamWith({ mintToken: { ok: true, token: await signToken({ type: 'service' }), expiresAt: future() } })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=s' }))
		expect(response.status).toBe(302)
	})

	test('a non-user token is still a valid SERVICE credential — only the human gate refuses it', async () => {
		const anonymous = await signToken({})
		expect((await service(SERVICE, iamWith({}))(verifyRequest({ bearer: anonymous }))).status).toBe(204)
	})
})

describe('deny — service gate', () => {
	test('no credential at all on a service-only gate set → 401 (no login bounce for a machine)', async () => {
		const response = await service(SERVICE, iamWith({}))(verifyRequest({ path: '/api/x' }))
		expect(response.status).toBe(401)
		expect(response.headers.get('location')).toBeNull()
	})

	test('an unknown px_ key → 401', async () => {
		const iam = iamWith({ mintFromKey: { ok: false, reason: 'invalid_key' } })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: 'px_nope' }))).status).toBe(401)
	})

	test('a disabled service principal → 403', async () => {
		const iam = iamWith({ mintFromKey: { ok: false, reason: 'disabled' } })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: 'px_dead' }))).status).toBe(403)
	})

	test('an unknown principal → 403', async () => {
		const iam = iamWith({ mintFromKey: { ok: false, reason: 'unknown_principal' } })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: 'px_ghost' }))).status).toBe(403)
	})

	test('a garbage passthrough JWT → 401 with NO IAM call', async () => {
		const iam = iamWith({})
		const response = await service(SERVICE, iam)(verifyRequest({ bearer: 'eyJnot.a.jwt' }))
		expect(response.status).toBe(401)
		expect(iam.mintFromKeyCalls).toBe(0)
	})

	test('a passthrough JWT signed by an unpublished key → 401', async () => {
		const forged = await signToken({ key: foreignPrivateKey })
		expect((await service(SERVICE, iamWith({}))(verifyRequest({ bearer: forged }))).status).toBe(401)
	})

	test('a passthrough JWT for another app → 401', async () => {
		const otherApp = await signToken({ audience: 'other-app' })
		expect((await service(SERVICE, iamWith({}))(verifyRequest({ bearer: otherApp }))).status).toBe(401)
	})

	test('a PRESENT-but-invalid credential does NOT fall through to a later human rule', async () => {
		const gates: AppGates = { rules: [{ path: '/*', kind: 'service' }, { path: '/*', kind: 'human' }] }
		const iam = iamWith({
			mintFromKey: { ok: false, reason: 'invalid_key' },
			mintToken: { ok: true, token: await signUserToken(), expiresAt: future() },
		})
		const response = await service(gates, iam)(verifyRequest({ bearer: 'px_bad', cookie: 'px_session=good' }))
		expect(response.status).toBe(401)
		expect(iam.mintTokenCalls).toBe(0) // the human rule was never reached
	})
})

describe('deny — IAM is unreachable', () => {
	test('an unreachable IAM on the human path denies with 503, never allows', async () => {
		const iam = iamWith({ unreachable: true })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=s' }))
		expect(response.status).toBe(503)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	})

	test('an unreachable IAM on the service path denies with 503', async () => {
		const iam = iamWith({ unreachable: true })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: 'px_key' }))).status).toBe(503)
	})

	test('an unfetchable JWKS denies a passthrough JWT that would otherwise verify', async () => {
		const good = await signToken({})
		const iam = iamWith({ unreachable: true })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: good }))).status).toBe(503)
	})

	test('an EMPTY key set denies everything (no keys, no verification)', async () => {
		const good = await signToken({})
		const iam = iamWith({ jwks: { keys: [] } })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: good }))).status).toBe(401)
	})

	test('a public gate still passes when IAM is down — it needs no credential', async () => {
		const iam = iamWith({ unreachable: true })
		const response = await service(PUBLIC_THEN_HUMAN, iam)(verifyRequest({ path: '/public/health' }))
		expect(response.status).toBe(204)
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})
})

describe('deny — "we could not check" is 503 on the human path, never a login bounce', () => {
	// A bounce would put the user in a login loop against an IAM that cannot answer, and would hide an
	// incident behind something that looks exactly like an expired session.
	test('a px_token that WOULD verify, with an unfetchable key set → 503', async () => {
		const token = await signUserToken(3600)
		const iam = iamWith({ jwksUnreachable: true })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: `px_token=${token}` }))
		expect(response.status).toBe(503)
		expect(response.headers.get('location')).toBeNull()
	})

	test('a mint that SUCCEEDS but cannot be verified because the key set is down → 503', async () => {
		const iam = iamWith({ jwksUnreachable: true, mintToken: { ok: true, token: await signUserToken(), expiresAt: future() } })
		const response = await service(HUMAN, iam)(verifyRequest({ cookie: 'px_session=s' }))
		expect(response.status).toBe(503)
		expect(response.headers.get('location')).toBeNull()
	})

	test('a cached token is KEPT when the key set is unreachable — only a proven-bad one is dropped', async () => {
		const cache = new MemoryTokenCache()
		cache.set(cacheKey(APP, 'session', 'sess-1'), { token: await signUserToken(3600), expiresAt: future(3600) })
		const iam = iamWith({ jwksUnreachable: true })
		const response = await service(HUMAN, iam, cache)(verifyRequest({ cookie: 'px_session=sess-1' }))
		expect(response.status).toBe(503)
		expect(iam.mintTokenCalls).toBe(0) // a fresh mint could not have been verified either
		expect(cache.size).toBe(1)
	})

	test('the service path already did this, and still does', async () => {
		const iam = iamWith({ jwksUnreachable: true, mintFromKey: { ok: true, token: await signUserToken(), expiresAt: future() } })
		expect((await service(SERVICE, iam)(verifyRequest({ bearer: 'px_ci' }))).status).toBe(503)
	})
})

describe('deny — the forwarded host must belong to the pinned app', () => {
	test('a pinned app claiming another host is refused, and no URL is built from that host', async () => {
		// ADR-0010 pins `?app=` because `X-Forwarded-Host` is client-controllable; the same header then
		// builds the login bounce, so it must also be checked against the app's declared hosts.
		const iam = iamWith({})
		const response = await service(HUMAN, iam)(verifyRequest({ host: 'evil.example.com' }))
		expect(response.status).toBe(403)
		expect(response.headers.get('location') ?? '').not.toContain('evil.example.com')
		expect(iam.mintTokenCalls).toBe(0)
	})
})

describe('one request, one session resolution', () => {
	test('two overlapping human rules mint at most once', async () => {
		const gates: AppGates = { rules: [{ path: '/admin/*', kind: 'human' }, { path: '/*', kind: 'human' }] }
		const iam = iamWith({ mintToken: { ok: false, reason: 'invalid_session' } })
		const response = await service(gates, iam)(verifyRequest({ path: '/admin/users', cookie: 'px_session=s' }))
		expect(response.status).toBe(302)
		// Both rules match and both miss; the verdict cannot differ, so the exchange happens once.
		expect(iam.mintTokenCalls).toBe(1)
	})
})

describe('deny — an internal fault is still a deny', () => {
	test('an IamGateway that throws a non-network error denies rather than 500ing open', async () => {
		const exploding = {
			mintToken: () => {
				throw new TypeError('boom')
			},
			mintFromKey: () => {
				throw new TypeError('boom')
			},
			exchangeAuthCode: (): never => {
				throw new TypeError('boom')
			},
			getJwks: () => Promise.reject(new TypeError('boom')),
		}
		const verify = createVerifyService({ manifest: manifestWith(HUMAN), iam: exploding, issuer: ISSUER })
		const response = await verify(verifyRequest({ cookie: 'px_session=s' }))
		expectDenied(response)
	})
})
