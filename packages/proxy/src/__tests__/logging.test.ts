/**
 * "Never log a token, a cookie value, a credential or an Authorization header."
 *
 * Proved rather than asserted: the whole decision matrix is driven with distinctively-shaped secret
 * values, and the entire captured log is searched for each of them afterwards. A future call site
 * that logs a header fails here.
 */

import type { AppGates } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { redactPath, redactUrl } from '../log'
import { createVerifyService } from '../service'
import { CapturingLogger, FakeIam, ISSUER, manifestWith, signUserToken, verifyRequest } from './helpers'

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

/** Distinctive needles; every one is a credential or a token and none may appear in a log. */
const SESSION = 'SESSIONSECRET-aaaaaaaa'
const API_KEY = 'px_KEYSECRET-bbbbbbbb'
const SHARE = 'px_SHARESECRET-cccccccc'
const QUERY_TOKEN = 'QUERYSECRET-dddddddd'

const GATES: AppGates = {
	rules: [
		{ path: '/share/*', kind: 'service', credential: { in: 'query', name: 'pxt' } },
		{ path: '/api/*', kind: 'service' },
		{ path: '/*', kind: 'human' },
	],
}

describe('no secret material reaches the log', () => {
	test('across the whole decision matrix', async () => {
		const token = await signUserToken()
		const logger = new CapturingLogger()
		const iam = new FakeIam({
			mintToken: { ok: true, token, expiresAt: future() },
			mintFromKey: { ok: true, token, expiresAt: future() },
		})
		const verify = createVerifyService({
			manifest: manifestWith(GATES),
			iam,
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
			logger,
		})

		await verify(verifyRequest({ path: '/dashboard', cookie: `__Host-px_session=${SESSION}` })) // allow (human)
		await verify(verifyRequest({ path: '/api/x', bearer: API_KEY })) // allow (service)
		await verify(verifyRequest({ path: `/share/${SHARE}?pxt=${QUERY_TOKEN}` })) // deny (bad query token)
		await verify(verifyRequest({ path: '/dashboard' })) // login bounce
		await verify(verifyRequest({ path: '/nowhere-in-the-gates', app: 'unknown-app' })) // deny
		await verify(verifyRequest({ path: '/dashboard', cookie: `__Host-px_token=${token}` })) // allow (warm)

		expect(logger.lines.length).toBeGreaterThan(0)
		const dumped = logger.dump()
		for (const secret of [SESSION, API_KEY, SHARE, QUERY_TOKEN, token]) {
			expect(dumped).not.toContain(secret)
		}
		// Nor any of the header names' values, in whole or in part.
		expect(dumped).not.toContain('Bearer')
		expect(dumped).not.toContain('__Host-px_session=')
		expect(dumped).not.toContain('__Host-px_token=')
	})

	test('the login bounce is logged without the redirect URL, in either shape', async () => {
		const logger = new CapturingLogger()
		const verify = createVerifyService({ manifest: manifestWith(GATES), iam: new FakeIam({}), issuer: ISSUER, logger })
		// The 302's Location and the 401's JSON body carry the same `?redirect=<original URL>`, so the
		// original query re-appears percent-encoded in both. Neither may reach a log line.
		await verify(verifyRequest({ path: `/secret?resume=${QUERY_TOKEN}` }))
		await verify(verifyRequest({ path: `/secret?resume=${QUERY_TOKEN}`, headers: { 'Sec-Fetch-Mode': 'cors' } }))
		expect(logger.dump()).not.toContain(QUERY_TOKEN)
		expect(logger.dump()).not.toContain(encodeURIComponent(QUERY_TOKEN))
	})

	test('an internal fault logs no error object', async () => {
		const logger = new CapturingLogger()
		const exploding = {
			mintToken: () => Promise.reject(new Error(`connect to https://iam/mint?session=${SESSION}`)),
			mintFromKey: () => Promise.reject(new Error('nope')),
			exchangeAuthCode: () => Promise.reject(new Error('nope')),
			getJwks: () => Promise.reject(new Error('nope')),
		}
		const verify = createVerifyService({ manifest: manifestWith(GATES), iam: exploding, issuer: ISSUER, logger })
		const response = await verify(verifyRequest({ path: '/x', cookie: `__Host-px_session=${SESSION}` }))
		expect(response.status).toBeGreaterThanOrEqual(300)
		expect(logger.dump()).not.toContain(SESSION)
	})
})

describe('redaction helpers', () => {
	test('a share-link px_ path segment is masked', () => {
		expect(redactPath('/s/px_abcdef123/view')).toBe('/s/px_***/view')
	})

	test('a query string is dropped entirely', () => {
		expect(redactPath('/search?q=hello&token=secret')).toBe('/search')
	})

	test('an ordinary path survives, because an unloggable path is an undebuggable proxy', () => {
		expect(redactPath('/api/v1/projects/42')).toBe('/api/v1/projects/42')
	})

	test('redactUrl keeps the origin and drops the query', () => {
		expect(redactUrl(new URL('https://app.example.com/s/px_zzz?x=1'))).toBe('https://app.example.com/s/px_***')
	})
})
