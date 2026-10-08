// The control plane's CSRF guard, at both altitudes: the exported middleware on its own, and the real
// `controlApp` proving a forged RPC mutation never reaches its handler.

import { type AuthContext, PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import { controlApp } from '../app'
import type { Env } from '../env'
import { controlOriginGuard } from '../origin-guard'
import { FakeRepoSource } from '../repo-source'
import { unavailableSourceConnection } from '../source/connections'
import { createHarness, type Harness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { adminToken, testIamEnv, testToken } from './helpers/tokens'

const CONTROL_ORIGIN = 'https://control.test'

function principal(type: 'user' | 'service'): AuthContext {
	return {
		ok: true,
		principal: { id: 'principal-1', type, label: `${type}@vozka.test` },
		can: () => true,
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

const anonymousToken: AuthContext = { ...principal('user'), principal: null }

async function guarded(input: {
	auth?: AuthContext | null
	domain?: string
	headers?: Record<string, string>
	method?: string
	path?: string
}): Promise<{ status: number; reached: boolean }> {
	const guard = controlOriginGuard<{ auth?: AuthContext | null }>(
		input.domain === undefined ? {} : { FABRIKA_CONTROL_DOMAIN: input.domain },
	)
	let reached = false
	const request = new Request(`${CONTROL_ORIGIN}${input.path ?? '/api/rpc'}`, {
		method: input.method ?? 'POST',
		headers: input.headers ?? {},
	})
	const response = await guard(request, { auth: input.auth }, () => {
		reached = true
		return Promise.resolve(new Response('handler', { status: 200 }))
	})
	return { status: response.status, reached }
}

const ALLOWED = { status: 200, reached: true }
const REFUSED = { status: 403, reached: false }

describe('controlOriginGuard', () => {
	test('checks a human mutation against the configured public origin', async () => {
		const auth = principal('user')

		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: CONTROL_ORIGIN } })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: 'https://evil.example' } })).toEqual(REFUSED)
		// A bare host is the live installation's spelling of the same origin.
		expect(await guarded({ auth, domain: 'control.test', headers: { origin: CONTROL_ORIGIN } })).toEqual(ALLOWED)
		// The scheme is part of the origin: the same host over plain HTTP is a different one.
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: 'http://control.test' } })).toEqual(REFUSED)
		expect(await guarded({ auth, domain: 'http://control.test', headers: { origin: CONTROL_ORIGIN } })).toEqual(REFUSED)
	})

	test('refuses any Sec-Fetch-Site the browser did not label same-origin', async () => {
		const auth = principal('user')
		const headers = { origin: CONTROL_ORIGIN }

		for (const site of ['cross-site', 'same-site', 'none']) {
			expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { ...headers, 'sec-fetch-site': site } })).toEqual(REFUSED)
		}
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { ...headers, 'sec-fetch-site': 'same-origin' } })).toEqual(ALLOWED)
	})

	test('falls back to the Referer and refuses when neither header is present', async () => {
		const auth = principal('user')

		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { referer: `${CONTROL_ORIGIN}/apps/example` } })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { referer: 'https://evil.example/page' } })).toEqual(REFUSED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: {} })).toEqual(REFUSED)
		// An Origin, once sent, is the answer — a matching Referer never rescues it.
		expect(
			await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: 'https://evil.example', referer: `${CONTROL_ORIGIN}/apps` } }),
		).toEqual(REFUSED)
	})

	test('accepts a null Origin only when the browser itself proves same-origin', async () => {
		const auth = principal('user')

		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: { origin: 'null' } })).toEqual(REFUSED)
	})

	test('fails closed when no public origin is configured', async () => {
		const auth = principal('user')

		expect(await guarded({ auth, headers: { origin: CONTROL_ORIGIN } })).toEqual(REFUSED)
		expect(await guarded({ auth, domain: '   ', headers: { origin: CONTROL_ORIGIN } })).toEqual(REFUSED)
		expect(await guarded({ auth, domain: 'not a url', headers: { origin: CONTROL_ORIGIN } })).toEqual(REFUSED)
	})

	test('exempts on the credential`s shape, not on who the caller is', async () => {
		const noOrigin = { domain: CONTROL_ORIGIN, headers: {} }

		// A bearer is never attached by a page cross-origin without a preflight nothing here answers —
		// so a personal `px_` key, which mints a USER principal, keeps working from the CLI.
		expect(await guarded({ ...noOrigin, auth: principal('user'), headers: { authorization: 'Bearer px_personal_key' } })).toEqual(ALLOWED)
		expect(await guarded({ ...noOrigin, auth: principal('service') })).toEqual(ALLOWED)
		// No equivalent fact covers a credential-less or anonymous caller, so both are CHECKED.
		expect(await guarded({ ...noOrigin, auth: anonymousToken })).toEqual(REFUSED)
		expect(await guarded({ ...noOrigin, auth: null })).toEqual(REFUSED)
		expect(await guarded({ ...noOrigin, auth: undefined })).toEqual(REFUSED)
	})

	test('leaves safe methods and every path outside `/api/*` alone', async () => {
		const auth = principal('user')
		const evil = { origin: 'https://evil.example' }

		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			expect(await guarded({ auth, domain: CONTROL_ORIGIN, method, headers: evil, path: '/api/apps' })).toEqual(ALLOWED)
		}
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: evil, path: '/api' })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: evil, path: '/api/health' })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: evil, path: '/webhooks/github' })).toEqual(ALLOWED)
		expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: evil, path: '/iam/admin/rpc' })).toEqual(ALLOWED)
	})

	test('reads the path the way the router does, so a doubled or trailing slash cannot skip it', async () => {
		const auth = principal('user')
		const evil = { origin: 'https://evil.example' }

		for (const path of ['//api/rpc', '/api/rpc/', '//api//rpc//', '/api/apps/']) {
			expect(await guarded({ auth, domain: CONTROL_ORIGIN, headers: evil, path })).toEqual(REFUSED)
		}
	})

	test('shapes the refusal for RPC and unmatched HTTP paths', async () => {
		const guard = controlOriginGuard<{ auth?: AuthContext | null }>({ FABRIKA_CONTROL_DOMAIN: CONTROL_ORIGIN })
		const forge = (path: string) => new Request(`${CONTROL_ORIGIN}${path}`, { method: 'POST', headers: { origin: 'https://evil.example' } })
		const never = () => Promise.reject(new Error('handler must not run'))

		for (const path of ['/api/rpc', '/api/rpc/', '//api/rpc']) {
			const rpc = await guard(forge(path), { auth: principal('user') }, never)
			expect(rpc.status).toBe(403)
			const rpcBody: unknown = await rpc.json()
			expect(rpcBody).toEqual({ error: { type: 'forbidden', message: 'cross-origin request rejected' } })
		}

		const unmatched = await guard(forge('/api/apps'), { auth: principal('user') }, never)
		expect(unmatched.status).toBe(403)
		const body: unknown = await unmatched.json()
		expect(body).toEqual({ error: 'cross-origin request rejected' })
	})
})

function application(overrides: Partial<Env> = {}, harness: Harness = createHarness()) {
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: {
			put: () => Promise.resolve(),
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		},
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		REPO_EVENTS: new FakeRepoSource(),
		ENVIRONMENT: 'local',
		FABRIKA_CONTROL_DOMAIN: CONTROL_ORIGIN,
		...testIamEnv,
		...overrides,
	}
	return (request: Request) =>
		controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unavailableSourceConnection('harbor') }, {
			waitUntil() {},
		})
}

function createRequest(token: string | null, headers: Record<string, string>, id: string, path = '/api/rpc'): Request {
	return new Request(`${CONTROL_ORIGIN}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'text/plain',
			...(token === null ? {} : { [PROXY_TOKEN_HEADER]: token }),
			...headers,
		},
		body: JSON.stringify({ method: 'apps.create', input: { id, repoUrl: `https://github.com/acme/${id}` } }),
	})
}

async function appIds(fetch: (request: Request) => Promise<Response>): Promise<string[]> {
	const listed: unknown = await (await fetch(
		new Request(`${CONTROL_ORIGIN}/api/rpc`, {
			method: 'POST',
			headers: { [PROXY_TOKEN_HEADER]: adminToken, authorization: 'Bearer px_test_reader', 'content-type': 'application/json' },
			body: JSON.stringify({ method: 'apps.list', input: null }),
		}),
	))
		.json()
	if (typeof listed !== 'object' || listed === null) throw new Error('app list must be an object')
	const result: unknown = Reflect.get(listed, 'result')
	if (typeof result !== 'object' || result === null) throw new Error('app list must carry a result')
	const items = Reflect.get(result, 'items')
	if (!Array.isArray(items)) throw new Error('app list must carry items')
	return items.map((item: unknown) => {
		const id = typeof item === 'object' && item !== null ? Reflect.get(item, 'id') : undefined
		return typeof id === 'string' ? id : ''
	})
}

describe('controlApp under the origin guard', () => {
	test('refuses a forged RPC mutation before the handler runs, and admits the real console', async () => {
		const fetch = application()

		// A CORS-simple POST from a sibling host: no preflight, the operator's session attached.
		const forged = await fetch(createRequest(adminToken, { origin: 'https://evil.example' }, 'forged-app'))
		expect(forged.status).toBe(403)
		const forgedBody: unknown = await forged.json()
		expect(forgedBody).toEqual({ error: { type: 'forbidden', message: 'cross-origin request rejected' } })
		expect(await appIds(fetch)).toEqual([])

		const fromConsole = await fetch(createRequest(adminToken, { origin: CONTROL_ORIGIN }, 'console-app'))
		expect(fromConsole.status).toBe(200)
		expect(await appIds(fetch)).toEqual(['console-app'])
	})

	test('refuses a matching Origin the browser itself labels cross-site', async () => {
		const fetch = application()

		const response = await fetch(createRequest(adminToken, { origin: CONTROL_ORIGIN, 'sec-fetch-site': 'cross-site' }, 'spoofed-app'))
		expect(response.status).toBe(403)
		expect(await appIds(fetch)).toEqual([])
	})

	test('keeps the machine caller working: a bearer needs no Origin, whatever principal it minted', async () => {
		const fetch = application()
		const machine = await testToken({ label: 'automation', type: 'service', actions: ['*'] })

		expect((await fetch(createRequest(machine, {}, 'machine-app'))).status).toBe(200)
		// A personal `px_` key mints a USER principal; the forwarded bearer is what exempts it.
		const personal = await fetch(createRequest(adminToken, { authorization: 'Bearer px_personal_key' }, 'cli-app'))
		expect(personal.status).toBe(200)
		expect(await appIds(fetch)).toEqual(['cli-app', 'machine-app'])
	})

	test('accepts the Referer when the browser sent no Origin, and leaves reads alone', async () => {
		const fetch = application()

		expect((await fetch(createRequest(adminToken, { referer: `${CONTROL_ORIGIN}/apps` }, 'referer-app'))).status).toBe(200)
		const read = await fetch(
			new Request(`${CONTROL_ORIGIN}/api/rpc`, { headers: { [PROXY_TOKEN_HEADER]: adminToken, origin: 'https://evil.example' } }),
		)
		expect(read.status).toBe(404)
	})

	test('refuses every human mutation when the public origin is unconfigured', async () => {
		const fetch = application({ FABRIKA_CONTROL_DOMAIN: undefined })

		const response = await fetch(createRequest(adminToken, { origin: CONTROL_ORIGIN }, 'unconfigured-app'))
		expect(response.status).toBe(403)
		expect(await appIds(fetch)).toEqual([])
	})

	test('a doubled slash skips neither the authentication nor the guard', async () => {
		const fetch = application()

		const anonymous = await fetch(createRequest(null, {}, 'slash-app', '//api/rpc'))
		expect(anonymous.status).toBe(401)
		const anonymousBody: unknown = await anonymous.json()
		expect(anonymousBody).toEqual({ error: { type: 'auth', message: 'no_token' } })

		const forged = await fetch(createRequest(adminToken, { origin: 'https://evil.example' }, 'slash-app', '//api/rpc'))
		expect(forged.status).toBe(403)
		const forgedBody: unknown = await forged.json()
		expect(forgedBody).toEqual({ error: { type: 'forbidden', message: 'cross-origin request rejected' } })
		expect(await appIds(fetch)).toEqual([])
	})
})
