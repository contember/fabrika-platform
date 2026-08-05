/**
 * IAM answers identically through every HTTP adapter — for routes whose behaviour is meant to be
 * portable, not just for one trivial GET.
 *
 * The scaffold used to cover exactly `/.well-known/jwks.json`: a 200 with a JSON body, no cookies, no
 * credentials, and no branch on configuration. That proves the adapter is wired, and nothing about the
 * places the two runtimes could actually diverge (TEST-10). The routes below are those places — a form
 * POST that writes cookies and a 302, a structured 401, and a surface that is DISABLED by
 * configuration and must be equally invisible on both.
 */

import { assertAppRuntimeConformance, runAppRuntimeConformance } from '@fabrika/app/testing'
import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamApp, iamApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'

const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

const ISSUER = 'http://localhost:18191'

function env(overrides: Partial<Env> = {}): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: createHarness().repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: '[]',
		ENVIRONMENT: 'local',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		...overrides,
	}
}

/** The `Set-Cookie` values in a normalized response, in order. */
function setCookies(headers: ReadonlyArray<readonly [string, string]>): string[] {
	return headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value)
}

describe('IAM runtime conformance', () => {
	test('serves the public Worker surface identically through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: iamApp,
			createEnv: () => env(),
			createRequest: () => new Request(`${ISSUER}/.well-known/jwks.json`),
		})

		expect(response.status).toBe(200)
		expect(response.headers).toContainEqual(['content-type', 'application/json;charset=utf-8'])
	})

	test('a login that MINTS A SESSION answers with the same status and the same Set-Cookie count', async () => {
		// The route that WRITES cookies and redirects — the one place an adapter can plausibly differ,
		// because `Set-Cookie` is the only header that may legitimately appear twice and each runtime has
		// its own idea of how to carry it across the boundary.
		const responses = await runAppRuntimeConformance({
			app: createIamApp(),
			// The local bypass mints a real session row and a real 302, so this exercises the cookie path
			// rather than the login page.
			createEnv: () => env({ LOCAL_DEV_LOGIN: 'true' }),
			createRequest: () => new Request(`${ISSUER}/auth/login?redirect=${encodeURIComponent(ISSUER)}`),
		})

		// The bodies and cookie VALUES differ legitimately: each run gets its own env and its own session
		// token. What must not differ is the shape.
		expect(responses.bun.status).toBe(responses.direct.status)
		expect(responses.cloudflare.status).toBe(responses.direct.status)
		expect(responses.direct.status).toBe(302)
		expect(setCookies(responses.direct.headers).length).toBeGreaterThan(0)
		expect(setCookies(responses.bun.headers)).toHaveLength(setCookies(responses.direct.headers).length)
		expect(setCookies(responses.cloudflare.headers)).toHaveLength(setCookies(responses.direct.headers).length)
		// The response carrying a session cookie must never be cached, on either runtime.
		for (const response of [responses.direct, responses.bun, responses.cloudflare]) {
			expect(response.headers).toContainEqual(['cache-control', 'no-store'])
		}
	})

	test('a credential-less POST to /admin/rpc answers with an identical structured 401', async () => {
		const response = await assertAppRuntimeConformance({
			app: createIamApp(),
			// Off-local, so the ENVIRONMENT=local caller bypass cannot answer this instead of the 401.
			createEnv: () => env({ ADMIN_ORIGINS: JSON.stringify([ISSUER]), ENVIRONMENT: 'stage' }),
			createRequest: () =>
				new Request(`${ISSUER}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: ISSUER },
					body: JSON.stringify({ method: 'me', input: null }),
				}),
		})

		expect(response.status).toBe(401)
		// `assertAppRuntimeConformance` already compares the body across adapters; this pins WHAT they
		// agree on, so a future relaxation of the helper cannot quietly drop the assertion.
		expect(JSON.parse(response.body)).toEqual({
			error: { type: 'auth', message: 'missing_token', loginUrl: `${ISSUER}/auth/login?redirect=${encodeURIComponent(ISSUER)}` },
		})
	})

	test('the proxy mint surface is equally INVISIBLE on both adapters when its key is unset', async () => {
		// NO KEY MEANS NO SURFACE. A misconfigured deploy must lose the surface identically everywhere; an
		// adapter that 500s or 401s instead of 404ing would be advertising that it exists.
		const response = await assertAppRuntimeConformance({
			app: createIamApp(),
			createEnv: () => env(),
			createRequest: () =>
				new Request(`${ISSUER}/auth/mint/session`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ app: 'opice', session: 'nope', requestId: 'r' }),
				}),
		})

		expect(response.status).toBe(404)
	})
})
