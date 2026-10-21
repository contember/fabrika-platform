// Enrolling a browser as a terminal and administering terminals (ADR-0067 §1).

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createIamApp } from '../app'
import { TERMINAL_COOKIE, TERMINAL_COOKIE_MAX_AGE_SECONDS } from '../auth/terminals'
import type { Env } from '../env'
import { prop } from '../json'
import { hashToken } from '../secret'
import { mintToken } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedGrant, seedInlineGrant, seedUser, TEST_SIGNING_KEYS } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const ENROL = `${ORIGIN}/auth/terminals/enroll`
const APP = 'attendance@prod'
const exec = { waitUntil() {} }

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
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

function fetchIam(h: Harness, request: Request): Promise<Response> {
	return createIamApp().fetch(request, env(h), exec)
}

/** A signed-in person on IAM's host; `enrols` grants `iam.terminals.manage`. */
async function signedIn(h: Harness, options: { enrols: boolean }): Promise<{ principalId: string; cookie: string }> {
	const principalId = seedUser(h.sqlite, { sub: `sub-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com` })
	if (options.enrols) {
		seedInlineGrant(h.sqlite, principalId, ['iam.terminals.manage'], null, 'propustka')
	}
	return { principalId, cookie: await h.signSession(principalId) }
}

function enrolPost(cookie: string, body: string, headers: Record<string, string> = {}): Request {
	return new Request(ENROL, {
		method: 'POST',
		headers: {
			Cookie: `${SESSION_COOKIE}=${cookie}`,
			'Content-Type': 'application/x-www-form-urlencoded',
			'Sec-Fetch-Site': 'same-origin',
			Origin: ORIGIN,
			...headers,
		},
		body,
	})
}

function setCookies(response: Response): string[] {
	return response.headers.getSetCookie()
}

function cookieValue(response: Response, name: string): string | null {
	const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`))
	return cookie === undefined ? null : cookie.slice(name.length + 1).split(';')[0] ?? null
}

describe('GET /auth/terminals/enroll', () => {
	test('a browser with no login is sent to sign in and back', async () => {
		const h = createHarness()
		const response = await fetchIam(h, new Request(ENROL))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(`/auth/login?redirect=${encodeURIComponent(ENROL)}`)
	})

	test('a login without iam.terminals.manage is refused', async () => {
		const h = createHarness()
		const { cookie } = await signedIn(h, { enrols: false })
		const response = await fetchIam(h, new Request(ENROL, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }))
		expect(response.status).toBe(403)
	})

	test('a login that may enrol gets the form, under the page CSP', async () => {
		const h = createHarness()
		const { cookie } = await signedIn(h, { enrols: true })
		const response = await fetchIam(h, new Request(ENROL, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-security-policy')).toContain(`form-action 'self';`)
		expect(await response.text()).toContain('action="/auth/terminals/enroll"')
	})
})

describe('POST /auth/terminals/enroll', () => {
	test('without iam.terminals.manage it is a 403 and nothing is written', async () => {
		const h = createHarness()
		const { cookie } = await signedIn(h, { enrols: false })
		const response = await fetchIam(h, enrolPost(cookie, 'label=Entrance'))
		expect(response.status).toBe(403)
		expect(cookieValue(response, TERMINAL_COOKIE)).toBeNull()
		expect(await h.repositories.terminals.list({ limit: 10 })).toEqual([])
	})

	test('a cross-site post is refused', async () => {
		const h = createHarness()
		const { cookie } = await signedIn(h, { enrols: true })
		const response = await fetchIam(h, enrolPost(cookie, 'label=Entrance', { 'Sec-Fetch-Site': 'cross-site' }))
		expect(response.status).toBe(403)
		expect(await h.repositories.terminals.list({ limit: 10 })).toEqual([])
	})

	test('a label that is empty, too long or carries a control character renders the form again', async () => {
		const h = createHarness()
		const { cookie } = await signedIn(h, { enrols: true })
		for (const label of ['', '   ', 'x'.repeat(101), 'Entr%0Aance']) {
			const response = await fetchIam(h, enrolPost(cookie, `label=${label}`))
			expect(response.status).toBe(400)
		}
		expect(await h.repositories.terminals.list({ limit: 10 })).toEqual([])
	})

	test('enrols the browser: the terminal cookie is set, the login revoked and cleared, the enrolment audited', async () => {
		const h = createHarness()
		const { principalId, cookie } = await signedIn(h, { enrols: true })
		const response = await fetchIam(h, enrolPost(cookie, 'label=%20Entrance%20'))
		expect(response.status).toBe(200)

		const terminalCookie = setCookies(response).find((value) => value.startsWith(`${TERMINAL_COOKIE}=`))
		expect(terminalCookie).toContain('HttpOnly')
		expect(terminalCookie).toContain('Secure')
		expect(terminalCookie).toContain('SameSite=Lax')
		expect(terminalCookie).toContain('Path=/')
		expect(terminalCookie).toContain(`Max-Age=${TERMINAL_COOKIE_MAX_AGE_SECONDS}`)
		expect(terminalCookie).not.toContain('Domain')
		expect(setCookies(response)).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)

		const token = cookieValue(response, TERMINAL_COOKIE)
		if (token === null) throw new Error('no terminal cookie')
		const terminal = await h.repositories.terminals.getActiveByTokenHash(await hashToken(token))
		expect(terminal).toMatchObject({ label: 'Entrance', enrolled_by: principalId, session_ttl: 300, revoked_at: null })
		const principal = await h.repositories.principals.getPrincipalById(terminal?.principal_id ?? '')
		expect(principal).toMatchObject({ type: 'service', label: 'Entrance' })

		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(cookie))).toBeNull()
		const logout = h.sqlite.query<{ principal_id: string }, []>(
			"SELECT principal_id FROM auth_log WHERE kind = 'logout' AND reason = 'terminal_enrolment'",
		)
			.all()
		expect(logout).toEqual([{ principal_id: principalId }])
		const audit = h.sqlite
			.query<{ principal_id: string; resource_id: string }, []>("SELECT principal_id, resource_id FROM audit_events WHERE action = 'iam.terminal.enrol'")
			.all()
		expect(audit).toEqual([{ principal_id: principalId, resource_id: terminal?.principal_id ?? '' }])

		// The login is spent: a second submission from the same browser enrols nothing.
		expect((await fetchIam(h, enrolPost(cookie, 'label=Again'))).status).toBe(403)
	})
})

async function adminBearer(h: Harness): Promise<string> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	return h.adminToken(id, { issuer: ORIGIN })
}

async function rpc(h: Harness, bearer: string, method: string, input: unknown): Promise<Response> {
	return fetchIam(
		h,
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ method, input }),
		}),
	)
}

async function rpcResult(h: Harness, bearer: string, method: string, input: unknown): Promise<unknown> {
	const response = await rpc(h, bearer, method, input)
	expect(response.status).toBe(200)
	return prop(await response.json(), 'result')
}

const terminalDto = z.object({
	terminalId: z.string(),
	label: z.string(),
	enrolledBy: z.string().nullable(),
	sessionTtl: z.number(),
	asserters: z.array(z.object({ app: z.string(), ceiling: z.array(z.string()) })),
	status: z.enum(['active', 'revoked']),
	createdAt: z.number(),
	lastSeenAt: z.number().nullable(),
	revokedAt: z.number().nullable(),
})

/** Enrol a terminal through the route and answer its id. */
async function enrolled(h: Harness): Promise<string> {
	const { cookie } = await signedIn(h, { enrols: true })
	const token = cookieValue(await fetchIam(h, enrolPost(cookie, 'label=Entrance')), TERMINAL_COOKIE)
	const terminal = token === null ? null : await h.repositories.terminals.getActiveByTokenHash(await hashToken(token))
	if (terminal === null) throw new Error('enrolment failed')
	return terminal.principal_id
}

describe('terminals.* administration', () => {
	test('lists terminals with their profile, and sets the profile', async () => {
		const h = createHarness()
		const bearer = await adminBearer(h)
		seedAppAction(h.sqlite, APP, 'attendance.view')
		seedAppAction(h.sqlite, APP, 'attendance.record')
		const terminalId = await enrolled(h)

		const set = terminalDto.parse(
			await rpcResult(h, bearer, 'terminals.setProfile', {
				terminalId,
				label: 'Workshop',
				sessionTtl: 120,
				asserters: [{ app: APP, ceiling: ['attendance.*'] }],
			}),
		)
		expect(set).toMatchObject({
			terminalId,
			label: 'Workshop',
			sessionTtl: 120,
			asserters: [{ app: APP, ceiling: ['attendance.*'] }],
			status: 'active',
		})
		expect((await h.repositories.principals.getPrincipalById(terminalId))?.label).toBe('Workshop')

		const page = z.object({ items: z.array(terminalDto), nextCursor: z.string().nullable() }).parse(await rpcResult(h, bearer, 'terminals.list', {}))
		expect(page.items).toEqual([set])
	})

	test('refuses an unknown app, a platform audience, an unknown action pattern and a TTL out of bounds', async () => {
		const h = createHarness()
		const bearer = await adminBearer(h)
		seedAppAction(h.sqlite, APP, 'attendance.record')
		seedAppAction(h.sqlite, 'vozka', 'console.read')
		const terminalId = await enrolled(h)
		const profile = { terminalId, label: 'Entrance', sessionTtl: 300 }
		const refusals: [unknown, string][] = [
			[{ ...profile, asserters: [{ app: 'nobody@prod', ceiling: [] }] }, 'unknown app'],
			[{ ...profile, asserters: [{ app: 'vozka', ceiling: [] }] }, 'platform audience'],
			[{ ...profile, asserters: [{ app: APP, ceiling: ['payroll.read'] }] }, 'unknown action pattern'],
			[{ ...profile, asserters: [{ app: APP, ceiling: [] }, { app: APP, ceiling: [] }] }, 'listed twice'],
			[{ ...profile, sessionTtl: 3601, asserters: [] }, 'sessionTtl'],
			[{ ...profile, sessionTtl: 0, asserters: [] }, 'sessionTtl'],
			[{ ...profile, label: ' ', asserters: [] }, 'label'],
		]
		for (const [input, reason] of refusals) {
			const response = await rpc(h, bearer, 'terminals.setProfile', input)
			expect(response.status).toBe(400)
			expect(JSON.stringify(await response.json())).toContain(reason)
		}
		expect(await h.repositories.terminals.listAsserters(terminalId)).toEqual([])
	})

	test('revoke ends every session issued on the terminal, and a revoked terminal takes no profile', async () => {
		const h = createHarness()
		const bearer = await adminBearer(h)
		seedAppAction(h.sqlite, APP, 'attendance.record')
		const terminalId = await enrolled(h)
		await rpcResult(h, bearer, 'terminals.setProfile', { terminalId, label: 'Entrance', sessionTtl: 300, asserters: [{ app: APP, ceiling: [] }] })
		const person = seedUser(h.sqlite, { sub: 'sub-person', email: 'person@example.com' })
		const session = 'terminal-session'
		await h.repositories.sessions.createSession({
			tokenHash: await hashToken(session),
			principalId: person,
			authenticationMethod: 'terminal_assertion',
			terminal: { terminalId, assertedBy: APP },
			expiresAt: Math.floor(Date.now() / 1000) + 300,
		})
		const services = h.makeServices({ issuer: ORIGIN })
		expect((await mintToken(services, { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }, { app: APP, session, requestId: 'r' })).result.ok).toBe(
			true,
		)

		expect(await rpcResult(h, bearer, 'terminals.revoke', { terminalId })).toEqual({ ok: true })
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).toBeNull()
		expect((await mintToken(services, { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }, { app: APP, session, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
		expect(await rpcResult(h, bearer, 'terminals.revoke', { terminalId })).toEqual({ ok: true })
		const late = await rpc(h, bearer, 'terminals.setProfile', { terminalId, label: 'Entrance', sessionTtl: 300, asserters: [] })
		expect(late.status).toBe(409)
		expect((await rpc(h, bearer, 'terminals.revoke', { terminalId: 'no-such-terminal' })).status).toBe(404)
	})

	test('a terminal is not an API key', async () => {
		const h = createHarness()
		const bearer = await adminBearer(h)
		const terminalId = await enrolled(h)
		const keys = z.object({ items: z.array(z.object({ principalId: z.string() })) }).parse(await rpcResult(h, bearer, 'apiKeys.list', {}))
		expect(keys.items.map((item) => item.principalId)).not.toContain(terminalId)
		for (const method of ['apiKeys.get', 'apiKeys.rotate', 'apiKeys.revoke']) {
			expect((await rpc(h, bearer, method, { principalId: terminalId })).status).toBe(404)
		}
	})
})
