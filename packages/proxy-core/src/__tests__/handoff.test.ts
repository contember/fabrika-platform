// The proxy half of the session handoff (ADR-0021, ADR-0023).
//
// This is the ONLY path on which the proxy sets a cookie, so the tests are as much about what it
// does NOT do — set one on a failed redemption, trust the request for the destination, reach the
// upstream — as about the happy path.

import type { AppGates } from '@fabrika/auth-core'
import { AUTH_CALLBACK_PATH, HANDOFF_COOKIE_PREFIX, SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createVerifyService } from '../service'
import { FakeIam, manifestWith, verifyRequest } from './helpers'

const HUMAN: AppGates = { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] }

const ISSUER = 'https://iam.test'
const RETURN_URL = 'https://app.example.com/dashboard'
const STATE = 'state-state-state1'
const VERIFIER = 'browser-held-verifier'

function service(iam: FakeIam, scheme: 'http' | 'https' = 'https') {
	return createVerifyService({ manifest: manifestWith(HUMAN, { scheme }), iam, issuer: ISSUER })
}

function callback(code: string | null, options: { state?: string | null; verifier?: string | null } = {}): Request {
	const state = options.state === undefined ? STATE : options.state
	const verifier = options.verifier === undefined ? VERIFIER : options.verifier
	const query = new URLSearchParams()
	if (code !== null) query.set('code', code)
	if (state !== null) query.set('state', state)
	return verifyRequest({
		path: `${AUTH_CALLBACK_PATH}${query.size === 0 ? '' : `?${query.toString()}`}`,
		...(state === null || verifier === null ? {} : { cookie: `${HANDOFF_COOKIE_PREFIX}${state}=${verifier}` }),
	})
}

/** Read one named `Set-Cookie` as value plus its flag set. */
function cookie(response: Response, name = SESSION_COOKIE): { value: string; attributes: string[] } | null {
	const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`)) ?? null
	if (header === null) return null
	const [pair = '', ...rest] = header.split('; ')
	return { value: pair.slice(pair.indexOf('=') + 1), attributes: rest }
}

describe('the handoff callback', () => {
	test('redeems the code, sets the app session host-only, and returns to where IAM said', async () => {
		const iam = new FakeIam({ exchangeAuthCode: { ok: true, session: 'app-session-value', returnUrl: RETURN_URL, expiresAt: nowPlus(3600) } })
		const response = await service(iam)(callback('the-code'))

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(RETURN_URL)
		expect(iam.seenCodes).toEqual(['the-code'])
		expect(iam.seenVerifiers).toEqual([VERIFIER])

		const set = cookie(response)
		expect(set?.value).toBe('app-session-value')
		expect(set?.attributes).toContain('HttpOnly')
		expect(set?.attributes).toContain('Secure')
		expect(set?.attributes).toContain('SameSite=Lax')
		expect(set?.attributes).toContain('Path=/')
		// Host-only is the whole point: no `Domain`, so no sibling host can read it.
		expect(set?.attributes.some((a) => a.toLowerCase().startsWith('domain='))).toBe(false)
		expect(cookie(response, `${HANDOFF_COOKIE_PREFIX}${STATE}`)?.attributes).toContain('Max-Age=0')
	})

	test('the destination comes from IAM, never from the request', async () => {
		const iam = new FakeIam({ exchangeAuthCode: { ok: true, session: 's', returnUrl: RETURN_URL, expiresAt: nowPlus(60) } })
		const response = await service(iam)(
			verifyRequest({
				path: `${AUTH_CALLBACK_PATH}?code=c&state=${STATE}&redirect=${encodeURIComponent('https://evil.test/')}`,
				cookie: `${HANDOFF_COOKIE_PREFIX}${STATE}=${VERIFIER}`,
			}),
		)
		expect(response.headers.get('location')).toBe(RETURN_URL)
	})

	test('keeps Secure even when the manifest says plain http — `__Host-` requires it (ADR-0023)', async () => {
		// It used to be dropped for local development. `SESSION_COOKIE` now carries the `__Host-` prefix,
		// which a browser honours only WITH `Secure`, so dropping it would produce a cookie nothing
		// stores. Local development is unaffected: browsers treat `*.localhost` as potentially
		// trustworthy and accept a `Secure` cookie there over plain HTTP.
		const iam = new FakeIam({ exchangeAuthCode: { ok: true, session: 's', returnUrl: 'http://app.localhost/x', expiresAt: nowPlus(60) } })
		const response = await service(iam, 'http')(callback('c'))
		expect(cookie(response)?.attributes).toContain('Secure')
	})

	test('a refused code denies, clears the handoff cookie, and sets no session', async () => {
		for (const reason of ['invalid_code', 'expired_code', 'wrong_app', 'invalid_verifier', 'disabled'] as const) {
			const response = await service(new FakeIam({ exchangeAuthCode: { ok: false, reason } }))(callback('c'))
			expect(response.status).toBe(403)
			expect(cookie(response)).toBeNull()
			expect(cookie(response, `${HANDOFF_COOKIE_PREFIX}${STATE}`)?.attributes).toContain('Max-Age=0')
		}
	})

	test('a callback with no code is refused without consulting IAM', async () => {
		const iam = new FakeIam({})
		const response = await service(iam)(callback(null, { state: null }))
		expect(response.status).toBe(403)
		expect(iam.exchangeCalls).toBe(0)
	})

	test('a callback without the browser-held verifier is refused before IAM', async () => {
		const iam = new FakeIam({ exchangeAuthCode: { ok: true, session: 'wrong', returnUrl: RETURN_URL, expiresAt: nowPlus(60) } })
		const response = await service(iam)(callback('attacker-code', { verifier: null }))
		expect(response.status).toBe(403)
		expect(iam.exchangeCalls).toBe(0)
		expect(cookie(response)).toBeNull()
	})

	test('an unreachable IAM is 503, not a deny that looks like a bad code', async () => {
		const response = await service(new FakeIam({ unreachable: true }))(callback('c'))
		expect(response.status).toBe(503)
		expect(cookie(response)).toBeNull()
		expect(cookie(response, `${HANDOFF_COOKIE_PREFIX}${STATE}`)?.attributes).toContain('Max-Age=0')
	})

	test('the callback is answered by the proxy and never becomes an allow', async () => {
		// A 2xx would let Caddy forward the request — with the code in the query — to the application.
		const iam = new FakeIam({ exchangeAuthCode: { ok: true, session: 's', returnUrl: RETURN_URL, expiresAt: nowPlus(60) } })
		const response = await service(iam)(callback('c'))
		expect(response.status).toBeGreaterThanOrEqual(300)
	})

	test('only a login bounce or callback sets a proxy cookie', async () => {
		const iam = new FakeIam({ mintToken: { ok: true, token: 'tok', expiresAt: nowPlus(300) } })
		for (const path of ['/healthz']) {
			const response = await service(iam)(verifyRequest({ path }))
			expect(response.headers.get('set-cookie')).toBeNull()
		}
		for (const path of ['/dashboard', '/__fabrika/auth/callbackx', '/__fabrika/auth']) {
			const response = await service(iam)(verifyRequest({ path }))
			expect(response.headers.getSetCookie().some((value) => value.startsWith(HANDOFF_COOKIE_PREFIX))).toBe(true)
		}
	})
})

function nowPlus(seconds: number): number {
	return Math.floor(Date.now() / 1000) + seconds
}
