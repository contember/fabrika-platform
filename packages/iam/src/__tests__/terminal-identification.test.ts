// Identifying a person at an enrolled terminal (ADR-0067 §2, §3, §5): `/auth/login` sends a terminal's browser to the
// application's identification page, the application asserts the person over its transport, IAM signs them in through
// the unchanged handoff, and `/auth/terminals/release` ends the terminal's sessions.

import { HttpIamTerminals } from '@fabrika/auth'
import {
	AUTH_CALLBACK_PATH,
	AUTH_CODE_PARAM,
	AUTH_HANDOFF_CHALLENGE_PARAM,
	AUTH_HANDOFF_STATE_PARAM,
	IDENTIFICATION_QUERY_PARAMETER,
	SESSION_COOKIE,
	type TerminalCaller,
} from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { SIGNOUT_RELEASE_PATH } from '@fabrika/proxy-core'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { TERMINAL_COOKIE, TERMINAL_COOKIE_MAX_AGE_SECONDS, TERMINAL_RELEASE_PATH } from '../auth/terminals'
import type { Env, RequestContext } from '../env'
import { exchangeAuthCode } from '../handoff'
import { pkceChallenge, randomToken } from '../oidc'
import { createIamRpc } from '../rpc'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { adminTokenFor, createHarness, type Harness, seedService, seedUser, TEST_SIGNING_KEYS } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const APP = 'attendance@prod'
const OTHER_APP = 'canteen@prod'
const APP_ORIGIN = 'https://attendance.test'
const IDENTIFY = '/kiosk/identify'
const VERIFIER = 'terminal-browser-verifier-terminal-browser-verifier'
const STATE = 'handoff-state-0123456789'

function now(): number {
	return Math.floor(Date.now() / 1000)
}

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	}
}

interface Scenario {
	h: Harness
	services: Services
	ctx: TestContext
	fetch(request: Request): Promise<Response>
	person: string
	terminalId: string
	/** The `Cookie` header of the terminal's browser. */
	terminalCookie: string
}

/** An enrolled terminal on which the app may assert, an app that declares an identification page, and a person. */
async function scenario(options: { identify?: string | null; asserters?: readonly string[] } = {}): Promise<Scenario> {
	const h = createHarness()
	const ctx = new TestContext()
	const app = createIamApp({ membershipTransport: true })
	const person = seedUser(h.sqlite, { sub: 'g-person', email: 'ann@example.com' })
	const terminalId = uuidv7()
	const token = randomToken()
	await h.repositories.audit.commit([
		h.repositories.principals.createServiceStatement(terminalId, 'Entrance'),
		h.repositories.terminals.enrolStatement({
			principalId: terminalId,
			label: 'Entrance',
			enrolledBy: person,
			tokenHash: await hashToken(token),
			sessionTtl: 300,
		}),
	])
	await h.repositories.terminals.setProfile(terminalId, {
		label: 'Entrance',
		sessionTtl: 300,
		asserters: (options.asserters ?? [APP]).map((asserter) => ({ app: asserter, ceiling: [] })),
	})
	await h.repositories.handoff.setReturnOrigins(APP, [APP_ORIGIN])
	const identify = options.identify === undefined ? IDENTIFY : options.identify
	if (identify !== null) {
		h.sqlite.run('INSERT INTO app_terminals (app, identify) VALUES (?, ?)', [APP, identify])
	}
	return {
		h,
		services: h.makeServices({ issuer: ORIGIN, authentication: { oidc: false, password: true } }),
		ctx,
		fetch: (request) => app.fetch(request, env(h), ctx),
		person,
		terminalId,
		terminalCookie: `${TERMINAL_COOKIE}=${token}`,
	}
}

async function loginRequest(cookie: string | null): Promise<Request> {
	const url = new URL('/auth/login', ORIGIN)
	url.searchParams.set('app', APP)
	url.searchParams.set('redirect', `${APP_ORIGIN}/desk`)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, STATE)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, await pkceChallenge(VERIFIER))
	return new Request(url, cookie === null ? {} : { headers: { Cookie: cookie } })
}

/** Open an identification the way the terminal's browser does, and answer its id. */
async function identification(s: Scenario): Promise<string> {
	const response = await s.fetch(await loginRequest(s.terminalCookie))
	const location = response.headers.get('location')
	if (response.status !== 302 || location === null) throw new Error(`no identification redirect: ${response.status}`)
	const id = new URL(location).searchParams.get(IDENTIFICATION_QUERY_PARAMETER)
	if (id === null) throw new Error('no identification id')
	return id
}

/** What the application's public procedure sends: a token minted for the app, here a service's. */
async function caller(s: Scenario, app = APP, tokenApp = app): Promise<TerminalCaller> {
	const workload = seedService(s.h.sqlite, { commonName: `public-${uuidv7()}` })
	return { app, credential: await adminTokenFor(s.h.repositories, workload, { issuer: ORIGIN, app: tokenApp, session: false }), requestId: uuidv7() }
}

function identificationCount(s: Scenario): number {
	return s.h.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM terminal_identifications').get()?.n ?? -1
}

describe('/auth/login on a terminal', () => {
	test('sends the browser to the asserting application to identify, with a fresh identification', async () => {
		const s = await scenario()
		const response = await s.fetch(await loginRequest(s.terminalCookie))
		expect(response.status).toBe(302)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const location = new URL(response.headers.get('location') ?? '')
		expect(`${location.origin}${location.pathname}`).toBe(`${APP_ORIGIN}${IDENTIFY}`)
		const id = location.searchParams.get(IDENTIFICATION_QUERY_PARAMETER) ?? ''

		const row = await s.h.repositories.terminals.getIdentification(await hashToken(id))
		expect(row).toMatchObject({ terminal_id: s.terminalId, app: APP, return_url: `${APP_ORIGIN}/desk`, handoff_state: STATE, consumed_at: null })
		expect((row?.expires_at ?? 0) - now()).toBeLessThanOrEqual(120)
		expect((await s.h.repositories.terminals.getById(s.terminalId))?.last_seen_at).not.toBeNull()
		const refreshed = response.headers.getSetCookie().find((value) => value.startsWith(`${s.terminalCookie};`))
		expect(refreshed).toContain(`Max-Age=${TERMINAL_COOKIE_MAX_AGE_SECONDS}`)
		const logged = s.h.sqlite
			.query<{ terminal_id: string; asserted_by: string }, []>("SELECT terminal_id, asserted_by FROM auth_log WHERE reason = 'terminal_identification'")
			.all()
		expect(logged).toEqual([{ terminal_id: s.terminalId, asserted_by: APP }])
	})

	test.each([
		{ name: 'the application is not an asserter', options: { asserters: [OTHER_APP] } },
		{ name: 'the application declares no identification page', options: { identify: null } },
	])('shows the normal sign-in when $name', async ({ options }) => {
		const s = await scenario(options)
		const response = await s.fetch(await loginRequest(s.terminalCookie))
		expect(response.status).toBe(200)
		expect(identificationCount(s)).toBe(0)
	})

	test('shows the normal sign-in to a browser that is no terminal, or a revoked one', async () => {
		const s = await scenario()
		expect((await s.fetch(await loginRequest(null))).status).toBe(200)
		await s.h.repositories.terminals.revoke(s.terminalId)
		expect((await s.fetch(await loginRequest(s.terminalCookie))).status).toBe(200)
		expect(identificationCount(s)).toBe(0)
	})

	test('a personal login on the terminal wins: the handoff continues as that person', async () => {
		const s = await scenario()
		const login = await s.h.signSession(s.person, { idpSub: null, authenticationMethod: 'password' })
		const response = await s.fetch(await loginRequest(`${SESSION_COOKIE}=${login}; ${s.terminalCookie}`))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')?.startsWith(`${APP_ORIGIN}${AUTH_CALLBACK_PATH}?`)).toBe(true)
		expect(identificationCount(s)).toBe(0)
	})
})

describe('the identification operations', () => {
	test('inspect names the terminal; assert signs the person in through the handoff the proxy started', async () => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)

		const inspected = await rpc.inspectIdentification({ ...(await caller(s)), id })
		expect(inspected).toMatchObject({ ok: true, terminal: { id: s.terminalId, label: 'Entrance' } })

		const asserted = await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })
		if (!asserted.ok) throw new Error(`assertion refused: ${asserted.reason}`)
		const callback = new URL(asserted.callbackUrl)
		expect(`${callback.origin}${callback.pathname}`).toBe(`${APP_ORIGIN}${AUTH_CALLBACK_PATH}`)
		expect(callback.searchParams.get(AUTH_HANDOFF_STATE_PARAM)).toBe(STATE)

		const login = s.h.sqlite
			.query<{ authentication_method: string; terminal_id: string; asserted_by: string; ttl: number }, []>(
				'SELECT authentication_method, terminal_id, asserted_by, expires_at - created_at AS ttl FROM sessions WHERE parent_session_id IS NULL',
			)
			.all()
		expect(login).toEqual([{ authentication_method: 'terminal_assertion', terminal_id: s.terminalId, asserted_by: APP, ttl: 300 }])

		const { result } = await exchangeAuthCode(s.services, {
			app: APP,
			code: callback.searchParams.get(AUTH_CODE_PARAM) ?? '',
			verifier: VERIFIER,
			requestId: 'redeem',
		})
		if (!result.ok) throw new Error(`redemption refused: ${result.reason}`)
		expect(result.returnUrl).toBe(`${APP_ORIGIN}/desk`)
		const child = await s.h.repositories.sessions.getActiveSessionByHash(await hashToken(result.session))
		expect(child).toMatchObject({ app: APP, principal_id: s.person, terminal_id: s.terminalId, asserted_by: APP })

		const logged = s.h.sqlite
			.query<{ principal_id: string; terminal_id: string; asserted_by: string }, []>(
				"SELECT principal_id, terminal_id, asserted_by FROM auth_log WHERE reason = 'terminal_assertion'",
			)
			.all()
		expect(logged).toEqual([{ principal_id: s.person, terminal_id: s.terminalId, asserted_by: APP }])
	})

	test('an identification is single use', async () => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		expect((await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })).ok).toBe(true)
		expect(await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })).toEqual({ ok: false, reason: 'not_found' })
		expect(await rpc.inspectIdentification({ ...(await caller(s)), id })).toEqual({ ok: false, reason: 'not_found' })
	})

	test.each([
		{
			name: 'another application asks',
			change: async (s: Scenario) => {
				await s.h.repositories.terminals.setProfile(s.terminalId, {
					label: 'Entrance',
					sessionTtl: 300,
					asserters: [{ app: APP, ceiling: [] }, { app: OTHER_APP, ceiling: [] }],
				})
				return caller(s, OTHER_APP)
			},
		},
		{
			name: 'it expired',
			change: async (s: Scenario) => {
				s.h.sqlite.run('UPDATE terminal_identifications SET expires_at = ?', [now() - 1])
				return caller(s)
			},
		},
		{
			name: 'the terminal was revoked',
			change: async (s: Scenario) => {
				await s.h.repositories.terminals.revoke(s.terminalId)
				return caller(s)
			},
		},
		{
			name: 'the terminal no longer lists the application',
			change: async (s: Scenario) => {
				await s.h.repositories.terminals.setProfile(s.terminalId, { label: 'Entrance', sessionTtl: 300, asserters: [] })
				return caller(s)
			},
		},
	])('is not_found when $name, and opens no login', async ({ change }) => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		const asking = await change(s)
		expect(await rpc.inspectIdentification({ ...asking, id })).toEqual({ ok: false, reason: 'not_found' })
		expect(await rpc.assertIdentity({ ...asking, id, principalId: s.person })).toEqual({ ok: false, reason: 'not_found' })
		expect(s.h.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0)
	})

	test('a principal that cannot sign in at a terminal is invalid_principal, and the identification stays open', async () => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		const external = seedUser(s.h.sqlite, { sub: 'g-guest', email: 'guest@partner.test' })
		s.h.sqlite.run("UPDATE principals SET affiliation = 'external' WHERE id = ?", [external])
		const disabled = seedUser(s.h.sqlite, { sub: 'g-gone', email: 'gone@example.com', disabled: true })
		const invited = seedUser(s.h.sqlite, { email: 'invited@example.com' })
		const service = seedService(s.h.sqlite, { commonName: 'robot' })
		for (const principalId of [external, disabled, invited, service, 'nobody']) {
			expect(await rpc.assertIdentity({ ...(await caller(s)), id, principalId })).toEqual({ ok: false, reason: 'invalid_principal' })
		}
		expect((await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })).ok).toBe(true)

		await Promise.all(s.ctx.pending)
		const refusals = s.h.sqlite
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_log WHERE decision = 'deny' AND reason = 'terminal_assertion_invalid_principal'")
			.get()
		expect(refusals?.n).toBe(5)
	})

	test("the application is the credential's audience: a missing or another app's token is refused", async () => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		expect(await rpc.inspectIdentification({ app: APP, credential: null, requestId: 'r', id })).toEqual({ ok: false, reason: 'missing_token' })
		expect(await rpc.assertIdentity({ ...(await caller(s, APP, OTHER_APP)), id, principalId: s.person })).toEqual({
			ok: false,
			reason: 'invalid_token',
		})
	})

	test('cancel ends an open identification once', async () => {
		const s = await scenario()
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		expect(await rpc.cancelIdentification({ ...(await caller(s, OTHER_APP)), id })).toEqual({ ok: false, reason: 'not_found' })
		expect(await rpc.cancelIdentification({ ...(await caller(s)), id })).toEqual({ ok: true })
		expect(await rpc.cancelIdentification({ ...(await caller(s)), id })).toEqual({ ok: false, reason: 'not_found' })
		expect(await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })).toEqual({ ok: false, reason: 'not_found' })
	})

	test('the membership transport serves them, pinned to its key', async () => {
		const s = await scenario()
		const id = await identification(s)
		const client = async (app: string) => {
			const key = `px_${randomToken(20)}`
			await s.h.repositories.membershipTransport.issue({ app, keyHash: await hashToken(key), expiresAt: now() + 3600, keep: null, now: now() })
			return new HttpIamTerminals({ origin: ORIGIN, key, fetch: (input, init) => s.fetch(new Request(input, init)) })
		}
		const own = await client(APP)
		expect(await own.inspectIdentification({ ...(await caller(s)), id })).toMatchObject({ ok: true, terminal: { id: s.terminalId } })
		const other = await client(OTHER_APP)
		expect(await other.inspectIdentification({ ...(await caller(s)), id })).toEqual({ ok: false, reason: 'not_allowed' })
		const asserted = await own.assertIdentity({ ...(await caller(s)), id, principalId: s.person })
		expect(asserted.ok).toBe(true)
	})
})

describe('/auth/terminals/release', () => {
	function release(redirect: string, cookie: string | null, method = 'GET'): Request {
		const url = new URL(TERMINAL_RELEASE_PATH, ORIGIN)
		url.searchParams.set('app', APP)
		url.searchParams.set('redirect', redirect)
		return new Request(url, { method, ...(cookie === null ? {} : { headers: { Cookie: cookie } }) })
	}

	async function signedInAtTerminal(s: Scenario): Promise<string> {
		const rpc = createIamRpc(env(s.h), s.ctx)
		const id = await identification(s)
		const asserted = await rpc.assertIdentity({ ...(await caller(s)), id, principalId: s.person })
		if (!asserted.ok) throw new Error(`assertion refused: ${asserted.reason}`)
		const { result } = await exchangeAuthCode(s.services, {
			app: APP,
			code: new URL(asserted.callbackUrl).searchParams.get(AUTH_CODE_PARAM) ?? '',
			verifier: VERIFIER,
			requestId: 'redeem',
		})
		if (!result.ok) throw new Error(`redemption refused: ${result.reason}`)
		return result.session
	}

	test("is the path the application's proxy signs out to", () => {
		expect(TERMINAL_RELEASE_PATH).toBe(SIGNOUT_RELEASE_PATH)
	})

	test("ends the terminal's sessions, logs the logout and returns to the application", async () => {
		const s = await scenario()
		const session = await signedInAtTerminal(s)
		const response = await s.fetch(release(`${APP_ORIGIN}/kiosk`, s.terminalCookie))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(`${APP_ORIGIN}/kiosk`)
		expect(await s.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).toBeNull()
		const logout = s.h.sqlite
			.query<{ principal_id: string; terminal_id: string }, []>("SELECT principal_id, terminal_id FROM auth_log WHERE kind = 'logout'")
			.all()
		expect(logout).toEqual([{ principal_id: s.person, terminal_id: s.terminalId }])
	})

	test('a browser that is no terminal is only sent back', async () => {
		const s = await scenario()
		const session = await signedInAtTerminal(s)
		const response = await s.fetch(release(`${APP_ORIGIN}/kiosk`, null))
		expect(response.status).toBe(302)
		expect(await s.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).not.toBeNull()
	})

	test('refuses a return address outside the application, and every method but GET', async () => {
		const s = await scenario()
		const session = await signedInAtTerminal(s)
		expect((await s.fetch(release('https://elsewhere.test/', s.terminalCookie))).status).toBe(400)
		expect((await s.fetch(release(`${APP_ORIGIN}/kiosk`, s.terminalCookie, 'POST'))).status).toBe(405)
		expect(await s.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).not.toBeNull()
	})
})
