// The proxy's sign-out (ADR-0067 §5): same-origin only, it clears the app session and its cached token, and sends the
// browser to IAM's release with a return on this app's own origin.

import { type MintTokenResult, SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { cacheKey, MemoryTokenCache } from '../cache'
import { AUTH_SIGNOUT_PATH } from '../constants'
import { createVerifyService } from '../service'
import { APP, contractAppWith, FakeIam, HOST, ISSUER, manifestWith, protocolRow, serviceRow, signUserToken, verifyRequest } from './helpers'

const HUMAN = [protocolRow('/healthz'), serviceRow('/*', ['human'])]
const SESSION = 'app-session-value'

function signOut(redirect: string | null, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }, method = 'GET'): Request {
	const query = redirect === null ? '' : `?redirect=${encodeURIComponent(redirect)}`
	return verifyRequest({ path: `${AUTH_SIGNOUT_PATH}${query}`, method, cookie: `${SESSION_COOKIE}=${SESSION}`, headers })
}

function sessionCookie(response: Response): string | null {
	return response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? null
}

describe('the sign-out path', () => {
	test('clears the session cookie and its cached token, and sends the browser to IAM release', async () => {
		let mint: MintTokenResult = { ok: true, token: await signUserToken(), expiresAt: Math.floor(Date.now() / 1000) + 300 }
		const iam = new FakeIam({ mintToken: () => mint })
		const cache = new MemoryTokenCache()
		const verify = createVerifyService({ manifest: manifestWith(HUMAN), iam, issuer: ISSUER, cache })

		const warm = await verify(verifyRequest({ path: '/dashboard', cookie: `${SESSION_COOKIE}=${SESSION}` }))
		expect(warm.status).toBe(204)
		expect(cache.get(cacheKey(APP, 'session', SESSION))).toBeDefined()

		const response = await verify(signOut('/kiosk?step=1'))
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/auth/terminals/release`)
		expect(location.searchParams.get('app')).toBe(APP)
		expect(location.searchParams.get('redirect')).toBe(`https://${HOST}/kiosk?step=1`)
		expect(sessionCookie(response)?.split('; ')).toEqual([`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', 'Secure'])
		expect(cache.get(cacheKey(APP, 'session', SESSION))).toBeUndefined()

		// IAM has revoked the session by now. Without the cached token, the old cookie re-mints and bounces to sign-in.
		mint = { ok: false, reason: 'invalid_session' }
		const next = await verify(verifyRequest({ path: '/dashboard', cookie: `${SESSION_COOKIE}=${SESSION}` }))
		expect(next.status).toBe(302)
		expect(new URL(next.headers.get('location') ?? '').pathname).toBe('/auth/login')
		const cookieless = await verify(verifyRequest({ path: '/dashboard' }))
		expect(new URL(cookieless.headers.get('location') ?? '').pathname).toBe('/auth/login')
	})

	test('refuses a request that is not same-origin, absent fetch metadata included', async () => {
		const variants: Record<string, string>[] = [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' }, {}]
		for (const headers of variants) {
			const cache = new MemoryTokenCache()
			cache.set(cacheKey(APP, 'session', SESSION), { token: 't', expiresAt: Math.floor(Date.now() / 1000) + 300 })
			const response = await createVerifyService({ manifest: manifestWith(HUMAN), iam: new FakeIam(), issuer: ISSUER, cache })(
				signOut('/', headers),
			)
			expect(response.status).toBe(403)
			expect(response.headers.get('location')).toBeNull()
			expect(sessionCookie(response)).toBeNull()
			expect(cache.size).toBe(1)
		}
	})

	test('refuses a return that is not a path on this origin', async () => {
		const verify = createVerifyService({ manifest: manifestWith(HUMAN), iam: new FakeIam(), issuer: ISSUER })
		for (
			const redirect of [null, '', 'kiosk', 'https://evil.test/', `https://${HOST}/`, '//evil.test/', '/\\evil.test', '/\\/evil.test', '/a b', '/a\nb']
		) {
			const response = await verify(signOut(redirect))
			expect(response.status).toBe(400)
			expect(response.headers.get('location')).toBeNull()
			expect(sessionCookie(response)).toBeNull()
		}
	})

	test('serves only GET, and never reaches the application', async () => {
		const verify = createVerifyService({ manifest: manifestWith(HUMAN), iam: new FakeIam(), issuer: ISSUER })
		const post = await verify(signOut('/', { 'Sec-Fetch-Site': 'same-origin' }, 'POST'))
		expect(post.status).toBe(403)
		expect(sessionCookie(post)).toBeNull()
		const get = await verify(signOut('/'))
		expect(get.status).toBe(302)
	})

	test('is served for a contract application, on its own origin', async () => {
		const verify = createVerifyService({ manifest: { apps: [contractAppWith([])] }, iam: new FakeIam(), issuer: ISSUER })
		const response = await verify(signOut('/'))
		expect(response.status).toBe(302)
		expect(new URL(response.headers.get('location') ?? '').searchParams.get('redirect')).toBe(`https://${HOST}/`)
		expect(sessionCookie(response)).toContain('Max-Age=0')
	})

	test('signs out a browser that holds no session', async () => {
		const verify = createVerifyService({ manifest: manifestWith(HUMAN), iam: new FakeIam(), issuer: ISSUER })
		const response = await verify(verifyRequest({ path: `${AUTH_SIGNOUT_PATH}?redirect=%2F`, headers: { 'Sec-Fetch-Site': 'same-origin' } }))
		expect(response.status).toBe(302)
		expect(sessionCookie(response)).toContain('Max-Age=0')
	})
})
