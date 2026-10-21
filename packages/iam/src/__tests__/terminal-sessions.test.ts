// A person's session on a terminal (ADR-0067 §4): it mints `(person ∩ ceiling) ∪ terminal`, only for the application
// that asserted it, and only while the terminal is enrolled and still lists that application.

import { type AccessTokenClaims, buildAccessClaims, parseAccessClaims, type Scope } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { resolveAdmin } from '../admin/router'
import type { Env, RequestContext } from '../env'
import { exchangeAuthCode, issueAuthCode } from '../handoff'
import { pkceChallenge, randomToken } from '../oidc'
import { createIamRpc } from '../rpc'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { getSigner } from '../signing'
import { mintToken } from '../tokens'
import { CONSOLE_APP, createHarness, type Harness, seedInlineGrant, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

const ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ISSUER = 'https://iam.test'
const APP = 'attendance@prod'
const OTHER_APP = 'canteen@prod'
const APP_ORIGIN = 'https://attendance.test'
const VERIFIER = 'terminal-browser-verifier-terminal-browser-verifier'

function now(): number {
	return Math.floor(Date.now() / 1000)
}

interface Scenario {
	h: Harness
	services: Services
	person: string
	terminalId: string
}

interface PersonalGrant {
	actions: string[]
	scope: Scope | null
	app: string
}

const PERSONAL_GRANTS: PersonalGrant[] = [
	{ actions: ['attendance.view', 'report.export'], scope: null, app: APP },
	{ actions: ['attendance.view'], scope: { type: 'site', value: 'north' }, app: APP },
	{ actions: ['meal.order'], scope: null, app: OTHER_APP },
]

/** A person with personal grants at the app, and a terminal whose principal holds its own grant there. */
async function scenario(ceiling: string[], grants: PersonalGrant[] = PERSONAL_GRANTS): Promise<Scenario> {
	const h = createHarness()
	const services = h.makeServices({ issuer: ISSUER, authentication: { oidc: true, password: true } })
	const person = seedUser(h.sqlite, { sub: 'g-person', email: 'ann@example.com' })
	for (const grant of grants) {
		seedInlineGrant(h.sqlite, person, grant.actions, grant.scope, grant.app)
	}
	const terminalId = uuidv7()
	await h.repositories.audit.commit([
		h.repositories.principals.createServiceStatement(terminalId, 'Entrance'),
		h.repositories.terminals.enrolStatement({
			principalId: terminalId,
			label: 'Entrance',
			enrolledBy: person,
			tokenHash: await hashToken(randomToken()),
			sessionTtl: 300,
		}),
	])
	seedInlineGrant(h.sqlite, terminalId, ['attendance.record'], null, APP)
	await h.repositories.terminals.setProfile(terminalId, {
		label: 'Entrance',
		sessionTtl: 300,
		asserters: [{ app: APP, ceiling }, { app: OTHER_APP, ceiling: [] }],
	})
	return { h, services, person, terminalId }
}

/** The login an assertion writes: no cookie holds it, it is the parent of the application session. */
async function terminalLogin(s: Scenario, assertedBy = APP): Promise<{ id: string; token: string }> {
	const token = randomToken()
	const id = await s.h.repositories.sessions.createSession({
		tokenHash: await hashToken(token),
		principalId: s.person,
		authenticationMethod: 'terminal_assertion',
		terminal: { terminalId: s.terminalId, assertedBy },
		expiresAt: now() + 300,
	})
	return { id, token }
}

/** Redeem a handoff code issued against the terminal login into the application session the proxy would hold. */
async function applicationSession(s: Scenario, app = APP): Promise<string> {
	await s.services.repositories.handoff.setReturnOrigins(app, [APP_ORIGIN])
	const login = await terminalLogin(s)
	const { code } = await issueAuthCode(s.services, {
		app,
		parentSessionId: login.id,
		returnUrl: `${APP_ORIGIN}/`,
		challenge: await pkceChallenge(VERIFIER),
	})
	const { result } = await exchangeAuthCode(s.services, { app, code, verifier: VERIFIER, requestId: uuidv7() })
	if (!result.ok) throw new Error(`redemption refused: ${result.reason}`)
	return result.session
}

async function mintedClaims(s: Scenario, session: string, app = APP): Promise<AccessTokenClaims> {
	const { result } = await mintToken(s.services, ENV, { app, session, requestId: uuidv7() })
	if (!result.ok) throw new Error(`mint refused: ${result.reason}`)
	const signer = await getSigner(ENV)
	const { payload } = await jwtVerify(result.token, createLocalJWKSet(signer.jwks()), { issuer: ISSUER, audience: app })
	const claims = parseAccessClaims(payload)
	if (claims === null) throw new Error('unparseable claims')
	return claims
}

describe('a terminal session mints (person ∩ ceiling) ∪ terminal', () => {
	test("an empty ceiling yields only the terminal's grants, and the token names the terminal", async () => {
		const s = await scenario([])
		const claims = await mintedClaims(s, await applicationSession(s))
		expect(claims.sub).toBe(s.person)
		expect(claims.ptype).toBe('user')
		expect(claims.amr).toBe('terminal_assertion')
		expect(claims.terminal).toEqual({ id: s.terminalId, label: 'Entrance' })
		expect(claims.perms).toEqual([{ action: 'attendance.record', scope: null, source: 'terminal' }])
	})

	test("a ceiling keeps only the person's entries it permits, scoped ones with their scope", async () => {
		const s = await scenario(['attendance.*'])
		const claims = await mintedClaims(s, await applicationSession(s))
		expect(claims.perms).toEqual([
			{ action: 'attendance.view', scope: null, source: 'grant' },
			{ action: 'attendance.view', scope: { type: 'site', value: 'north' }, source: 'grant' },
			{ action: 'attendance.record', scope: null, source: 'terminal' },
		])
	})

	test("a person's wildcard yields the ceiling's narrower actions, under the person's scope", async () => {
		const everything = await scenario(['attendance.view'], [{ actions: ['*'], scope: null, app: APP }])
		expect((await mintedClaims(everything, await applicationSession(everything))).perms).toEqual([
			{ action: 'attendance.view', scope: null, source: 'grant' },
			{ action: 'attendance.record', scope: null, source: 'terminal' },
		])

		const north = { type: 'site', value: 'north' }
		const namespace = await scenario(['attendance.view', 'report.export'], [{ actions: ['attendance.*'], scope: north, app: APP }])
		expect((await mintedClaims(namespace, await applicationSession(namespace))).perms).toEqual([
			{ action: 'attendance.view', scope: north, source: 'grant' },
			{ action: 'attendance.record', scope: null, source: 'terminal' },
		])
	})

	test("a ceiling wildcard keeps the person's exact action", async () => {
		const s = await scenario(['attendance.*'], [{ actions: ['attendance.view', 'report.export'], scope: null, app: APP }])
		expect((await mintedClaims(s, await applicationSession(s))).perms).toEqual([
			{ action: 'attendance.view', scope: null, source: 'grant' },
			{ action: 'attendance.record', scope: null, source: 'terminal' },
		])
	})

	test('the ceiling and the grants are read at every mint', async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		await s.h.repositories.terminals.setProfile(s.terminalId, {
			label: 'Entrance',
			sessionTtl: 300,
			asserters: [{ app: APP, ceiling: ['report.export'] }],
		})
		expect((await mintedClaims(s, session)).perms.map((entry) => entry.action)).toEqual(['report.export', 'attendance.record'])
	})

	test("a personal session is unchanged: the person's own set, no terminal claims", async () => {
		const s = await scenario([])
		const session = await s.h.signSession(s.person, { email: 'ann@example.com' })
		const claims = await mintedClaims(s, session)
		expect(claims.amr).toBeUndefined()
		expect(claims.terminal).toBeUndefined()
		expect(claims.perms.map((entry) => entry.action)).toEqual(['attendance.view', 'report.export', 'attendance.view'])
	})
})

describe('a terminal session is refused', () => {
	test('for any audience but the application that asserted it, the login itself included', async () => {
		const s = await scenario(['*'])
		const session = await applicationSession(s)
		expect((await mintToken(s.services, ENV, { app: OTHER_APP, session, requestId: 'r' })).result).toEqual({ ok: false, reason: 'invalid_session' })
		const login = await terminalLogin(s)
		expect((await mintToken(s.services, ENV, { app: OTHER_APP, session: login.token, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
		expect((await mintToken(s.services, ENV, { app: CONSOLE_APP, session: login.token, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
	})

	test('for a platform audience even when that audience asserted it', async () => {
		const s = await scenario(['*'])
		await s.h.repositories.terminals.setProfile(s.terminalId, { label: 'Entrance', sessionTtl: 300, asserters: [{ app: CONSOLE_APP, ceiling: ['*'] }] })
		const login = await terminalLogin(s, CONSOLE_APP)
		const outcome = await mintToken(s.services, ENV, { app: CONSOLE_APP, session: login.token, requestId: 'r' })
		expect(outcome.result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test('once the terminal is revoked', async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		await s.h.repositories.terminals.revoke(s.terminalId)
		expect((await mintToken(s.services, ENV, { app: APP, session, requestId: 'r' })).result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test('once the terminal no longer lists the application', async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		await s.h.repositories.terminals.setProfile(s.terminalId, { label: 'Entrance', sessionTtl: 300, asserters: [] })
		const outcome = await mintToken(s.services, ENV, { app: APP, session, requestId: 'r' })
		expect(outcome.result).toEqual({ ok: false, reason: 'invalid_session' })
		expect(outcome.terminal).toEqual({ terminalId: s.terminalId, assertedBy: APP })
	})
})

describe('the handoff of a terminal login', () => {
	test('copies the terminal and the asserter to the child, and logs both on the redemption', async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		const child = await s.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))
		expect(child).toMatchObject({ app: APP, authentication_method: 'terminal_assertion', terminal_id: s.terminalId, asserted_by: APP })
		const row = s.h.sqlite
			.query<{ terminal_id: string | null; asserted_by: string | null }, []>("SELECT terminal_id, asserted_by FROM auth_log WHERE reason = 'handoff'")
			.get()
		expect(row).toEqual({ terminal_id: s.terminalId, asserted_by: APP })
	})

	test('refuses a code issued for another application', async () => {
		const s = await scenario([])
		await s.services.repositories.handoff.setReturnOrigins(OTHER_APP, [APP_ORIGIN])
		const login = await terminalLogin(s)
		const { code } = await issueAuthCode(s.services, {
			app: OTHER_APP,
			parentSessionId: login.id,
			returnUrl: `${APP_ORIGIN}/`,
			challenge: await pkceChallenge(VERIFIER),
		})
		const outcome = await exchangeAuthCode(s.services, { app: OTHER_APP, code, verifier: VERIFIER, requestId: 'r' })
		expect(outcome.result).toEqual({ ok: false, reason: 'wrong_app' })
		expect(outcome.terminal).toEqual({ terminalId: s.terminalId, assertedBy: APP })
	})
})

describe('the auth_log of a terminal session', () => {
	class TestContext implements RequestContext {
		readonly pending: Promise<unknown>[] = []
		readonly waitUntil = (promise: Promise<unknown>): void => {
			this.pending.push(promise)
		}
	}

	test("every mint, allowed or refused, records the session's terminal and asserter", async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		const env: Env = {
			DB: unusedDatabase,
			REPOSITORIES: s.h.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			OIDC_ENABLED: 'false',
			PASSWORD_ENABLED: 'true',
			ISSUER,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: '',
		}
		const ctx = new TestContext()
		const rpc = createIamRpc(env, ctx)
		expect((await rpc.mintToken({ app: APP, session, requestId: 'allowed' })).ok).toBe(true)
		expect((await rpc.mintToken({ app: OTHER_APP, session, requestId: 'refused' })).ok).toBe(false)
		await Promise.all(ctx.pending)
		const rows = s.h.sqlite
			.query<{ request_id: string; decision: string; terminal_id: string | null; asserted_by: string | null }, []>(
				"SELECT request_id, decision, terminal_id, asserted_by FROM auth_log WHERE request_id IN ('allowed', 'refused') ORDER BY request_id",
			)
			.all()
		expect(rows).toEqual([
			{ request_id: 'allowed', decision: 'allow', terminal_id: s.terminalId, asserted_by: APP },
			{ request_id: 'refused', decision: 'deny', terminal_id: s.terminalId, asserted_by: APP },
		])
	})
})

describe("IAM's administration refuses a terminal session's token", () => {
	test('even at a registered admin audience, for a principal that administers', async () => {
		const h = createHarness()
		const services = h.makeServices({ bootstrapAdmins: new Set(['root@example.com']) })
		const admin = seedUser(h.sqlite, { sub: 'g-root', email: 'root@example.com' })
		const signer = await getSigner(TEST_SIGNING_ENV)
		const issuedAt = now()
		const claims = {
			iss: 'http://localhost:18191',
			app: CONSOLE_APP,
			subject: admin,
			type: 'user' as const,
			label: 'root@example.com',
			session: true as const,
			permissions: [],
			issuedAt,
			expiresAt: issuedAt + 300,
		}
		const personal = await resolveAdmin(services, { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }, {
			bearer: await signer.sign(buildAccessClaims(claims)),
			requestId: 'r',
		})
		expect(personal.ok).toBe(true)
		const onTerminal = await resolveAdmin(services, { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }, {
			bearer: await signer.sign(buildAccessClaims({ ...claims, terminal: { id: 'terminal-1', label: 'Entrance' } })),
			requestId: 'r',
		})
		expect(onTerminal).toEqual({ ok: false, status: 403, reason: 'not_allowed' })
	})
})
