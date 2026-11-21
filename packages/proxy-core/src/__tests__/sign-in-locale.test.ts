// The language an application leaves for a browser on its own host (`LOCALE_COOKIE`) rides the sign-in bounce as IAM's
// `?locale=`, so the first sign-in page speaks it (ADR-0077). It picks words only: the decision, the return URL and the
// handoff are those of the same request without it, and a value IAM does not speak is not passed on.

import { LOCALE_COOKIE, LOCALE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createVerifyService } from '../service'
import { APP, FakeIam, HOST, ISSUER, manifestWith, protocolRow, serviceRow, signUserToken, verifyRequest } from './helpers'

const ENDPOINTS = [protocolRow('/public/*'), serviceRow('/*', ['human'])]

function verifyWith(iam = new FakeIam({})) {
	return createVerifyService({ manifest: manifestWith(ENDPOINTS), iam, issuer: ISSUER, cache: null })
}

/** The login URL of a 302's `Location` or of a 401's JSON envelope. */
async function loginUrlOf(response: Response): Promise<URL> {
	const location = response.headers.get('location')
	if (location !== null) return new URL(location)
	const body: unknown = await response.json()
	const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null
	const loginUrl = typeof error === 'object' && error !== null && 'loginUrl' in error ? error.loginUrl : null
	if (typeof loginUrl !== 'string') throw new Error('no login URL in the answer')
	return new URL(loginUrl)
}

describe('the sign-in bounce carries the application host language', () => {
	test("a navigation's 302 names the cookie's language beside the unchanged app, return and handoff", async () => {
		const verify = verifyWith()
		const plain = await verify(verifyRequest({ path: '/dashboard', cookie: 'theme=dark' }))
		const hinted = await verify(verifyRequest({ path: '/dashboard', cookie: `theme=dark; ${LOCALE_COOKIE}=uk` }))
		expect(hinted.status).toBe(plain.status)
		expect(hinted.status).toBe(302)
		const login = await loginUrlOf(hinted)
		expect(`${login.origin}${login.pathname}`).toBe(`${ISSUER}/auth/login`)
		expect(login.searchParams.get(LOCALE_PARAM)).toBe('uk')
		expect(login.searchParams.get('app')).toBe(APP)
		expect(login.searchParams.get('redirect')).toBe(`https://${HOST}/dashboard`)
		expect(login.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
		expect(login.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect([...login.searchParams.keys()].sort()).toEqual([...(await loginUrlOf(plain)).searchParams.keys(), LOCALE_PARAM].sort())
	})

	test("a fetch's 401 carries the same language in its login URL", async () => {
		const response = await verifyWith()(
			verifyRequest({ path: '/api/rpc', method: 'POST', cookie: `${LOCALE_COOKIE}=cs`, headers: { 'Sec-Fetch-Mode': 'cors' } }),
		)
		expect(response.status).toBe(401)
		expect((await loginUrlOf(response)).searchParams.get(LOCALE_PARAM)).toBe('cs')
	})

	test('an expired session bounces with the language too', async () => {
		const iam = new FakeIam({ mintToken: { ok: false, reason: 'invalid_session' } })
		const response = await verifyWith(iam)(verifyRequest({ path: '/dashboard', cookie: `${SESSION_COOKIE}=old; ${LOCALE_COOKIE}=uk` }))
		expect(response.status).toBe(302)
		expect((await loginUrlOf(response)).searchParams.get(LOCALE_PARAM)).toBe('uk')
	})

	test.each(['de', 'UK', 'uk-UA', '', 'uk%26app%3Dother', 'en,uk'])('a value IAM does not speak (%p) is not passed on', async (value) => {
		const response = await verifyWith()(verifyRequest({ path: '/dashboard', cookie: `${LOCALE_COOKIE}=${value}` }))
		expect(response.status).toBe(302)
		const login = await loginUrlOf(response)
		expect(login.searchParams.has(LOCALE_PARAM)).toBe(false)
		expect(login.searchParams.get('app')).toBe(APP)
	})

	test('it decides nothing: an open row and a signed-in browser are answered as without it', async () => {
		const iam = new FakeIam({ mintToken: { ok: true, token: await signUserToken(), expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const verify = verifyWith(iam)
		expect((await verify(verifyRequest({ path: '/public/page', cookie: `${LOCALE_COOKIE}=uk` }))).status).toBe(204)
		const signedIn = await verify(verifyRequest({ path: '/dashboard', cookie: `${SESSION_COOKIE}=s; ${LOCALE_COOKIE}=uk` }))
		expect(signedIn.status).toBe(204)
		expect(signedIn.headers.get('location')).toBeNull()
	})
})
