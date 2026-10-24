// A person's session on a terminal (ADR-0067 §4): it mints `(person ∩ ceiling) ∪ terminal`, only for the application
// that asserted it, and only while the terminal is enrolled and still lists that application.

import { type AccessTokenClaims, buildAccessClaims, parseAccessClaims, type Scope } from '@fabrika/auth-core'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { resolveAdmin } from '../admin/router'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import type { Env, RequestContext } from '../env'
import { exchangeAuthCode, issueAuthCode } from '../handoff'
import { listAppMembers } from '../membership'
import { pkceChallenge, randomToken } from '../oidc'
import { createIamRpc } from '../rpc'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { getSigner } from '../signing'
import { mintToken } from '../tokens'
import { PEOPLE_SCHEMA } from './helpers/app-people'
import {
	CONSOLE_APP,
	createHarness,
	type Harness,
	makeServicesFor,
	seedInlineGrant,
	seedUser,
	TEST_SIGNING_ENV,
	TEST_SIGNING_KEYS,
	TestSqlDatabase,
} from './helpers/harness'
import { APP as MEMBERS_APP, CALLER_ENV, membershipFixture } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture } from './helpers/postgres'

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
	for (const app of [APP, OTHER_APP]) {
		h.sqlite.run('INSERT INTO app_terminals (app, identify) VALUES (?, ?)', [app, '/identify'])
	}
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
		terminalGeneration: 0,
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

	test('once the application no longer declares a terminal', async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		s.h.sqlite.run('DELETE FROM app_terminals WHERE app = ?', [APP])
		expect((await mintToken(s.services, ENV, { app: APP, session, requestId: 'r' })).result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test("once the terminal's principal is disabled", async () => {
		const s = await scenario([])
		const session = await applicationSession(s)
		s.h.sqlite.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [now(), s.terminalId])
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
		// A session the validity rule no longer finds is refused, and its row still names who and where.
		const expired = await applicationSession(s)
		s.h.sqlite.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [now() - 1, await hashToken(expired)])
		expect((await rpc.mintToken({ app: APP, session: expired, requestId: 'refused-expired' })).ok).toBe(false)
		await s.h.repositories.terminals.revoke(s.terminalId)
		expect((await rpc.mintToken({ app: APP, session, requestId: 'refused-revoked' })).ok).toBe(false)
		await Promise.all(ctx.pending)
		const rows = s.h.sqlite
			.query<{ request_id: string; decision: string; principal_id: string | null; terminal_id: string | null; asserted_by: string | null }, []>(
				"SELECT request_id, decision, principal_id, terminal_id, asserted_by FROM auth_log WHERE request_id LIKE 'allowed' OR request_id LIKE 'refused%' ORDER BY request_id",
			)
			.all()
		const attributed = { principal_id: s.person, terminal_id: s.terminalId, asserted_by: APP }
		expect(rows).toEqual([
			{ request_id: 'allowed', decision: 'allow', ...attributed },
			{ request_id: 'refused', decision: 'deny', ...attributed },
			{ request_id: 'refused-expired', decision: 'deny', ...attributed },
			{ request_id: 'refused-revoked', decision: 'deny', ...attributed },
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

describe('membership operations on a terminal session', () => {
	// A terminal grants `people.list`, which the person lacks: the token carries it, and the directory honours it.
	test('honour what the terminal grants, live, and refuse once the terminal no longer mints there', async () => {
		const h = createHarness()
		const f = await membershipFixture(h.repositories)
		expect((await f.putSchema(PEOPLE_SCHEMA)).status).toBe(200)
		const person = await f.person('ann')
		const terminalId = uuidv7()
		await h.repositories.audit.commit([
			h.repositories.principals.createServiceStatement(terminalId, 'Entrance'),
			h.repositories.terminals.enrolStatement({
				principalId: terminalId,
				label: 'Entrance',
				enrolledBy: person.id,
				tokenHash: await hashToken(randomToken()),
				sessionTtl: 300,
			}),
		])
		await h.repositories.terminals.setProfile(terminalId, { label: 'Entrance', sessionTtl: 300, asserters: [{ app: MEMBERS_APP, ceiling: [] }] })
		await h.repositories.grants.createGrant({ principalId: terminalId, permissions: ['people.list'], app: MEMBERS_APP })
		h.sqlite.run('INSERT INTO app_terminals (app, identify) VALUES (?, ?)', [MEMBERS_APP, '/identify'])
		const session = randomToken()
		await h.repositories.sessions.createSession({
			tokenHash: await hashToken(session),
			principalId: person.id,
			authenticationMethod: 'terminal_assertion',
			terminal: { terminalId, assertedBy: MEMBERS_APP },
			terminalGeneration: 0,
			app: MEMBERS_APP,
			expiresAt: now() + 300,
		})
		const minted = await mintToken(f.services, TEST_SIGNING_ENV, { app: MEMBERS_APP, session, requestId: uuidv7() })
		if (!minted.result.ok) throw new Error(`mint refused: ${minted.result.reason}`)
		const list = () =>
			listAppMembers(f.services, CALLER_ENV, f.ctx, { app: MEMBERS_APP, credential: minted.result.ok ? minted.result.token : '', requestId: uuidv7() })

		// The person alone may not list the application's people.
		const own = await listAppMembers(f.services, CALLER_ENV, f.ctx, { app: MEMBERS_APP, credential: await person.token(), requestId: uuidv7() })
		expect(own).toEqual({ ok: false, reason: 'not_allowed' })
		expect((await list()).ok).toBe(true)

		await h.repositories.terminals.revoke(terminalId)
		expect(await list()).toEqual({ ok: false, reason: 'invalid_token' })
	})
})

/** The mint and handoff of a terminal session over the repositories alone, so it runs on SQLite and on Postgres. */
function terminalSessionSuite(backend: () => { repositories: IamRepositories; db: SqlDatabase }): void {
	async function world(ceiling: string[]) {
		const { repositories, db } = backend()
		const declareTerminal = async (declared: boolean): Promise<void> => {
			await db.prepare('DELETE FROM app_terminals WHERE app = ?').bind(app).run()
			if (declared) await db.prepare("INSERT INTO app_terminals (app, identify) VALUES (?, '/identify')").bind(app).run()
		}
		const services = makeServicesFor(repositories, { issuer: ISSUER })
		const app = `attendance-${uuidv7()}@prod`
		const person = (await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)).id
		await repositories.grants.createGrant({ principalId: person, permissions: ['attendance.view', 'report.export'], app })
		const terminalId = uuidv7()
		await repositories.audit.commit([
			repositories.principals.createServiceStatement(terminalId, 'Entrance'),
			repositories.terminals.enrolStatement({
				principalId: terminalId,
				label: 'Entrance',
				enrolledBy: person,
				tokenHash: await hashToken(randomToken()),
				sessionTtl: 300,
			}),
		])
		await repositories.grants.createGrant({ principalId: terminalId, permissions: ['attendance.record'], app })
		await repositories.terminals.setProfile(terminalId, { label: 'Entrance', sessionTtl: 300, asserters: [{ app, ceiling }] })
		await declareTerminal(true)
		await repositories.handoff.setReturnOrigins(app, [APP_ORIGIN])
		const generation = (await repositories.terminals.getById(terminalId))?.generation ?? -1
		const session = async (): Promise<string> => {
			const loginId = await repositories.sessions.createSession({
				tokenHash: await hashToken(randomToken()),
				principalId: person,
				authenticationMethod: 'terminal_assertion',
				terminal: { terminalId, assertedBy: app },
				terminalGeneration: generation,
				expiresAt: now() + 300,
			})
			const { code } = await issueAuthCode(services, {
				app,
				parentSessionId: loginId,
				returnUrl: `${APP_ORIGIN}/`,
				challenge: await pkceChallenge(VERIFIER),
			})
			const { result } = await exchangeAuthCode(services, { app, code, verifier: VERIFIER, requestId: uuidv7() })
			if (!result.ok) throw new Error(`redemption refused: ${result.reason}`)
			return result.session
		}
		const mint = (value: string, audience = app) => mintToken(services, ENV, { app: audience, session: value, requestId: uuidv7() })
		return { repositories, app, person, terminalId, session, mint, declareTerminal }
	}

	test('mints (person ∩ ceiling) ∪ terminal through the handoff', async () => {
		const w = await world(['attendance.*'])
		const outcome = await w.mint(await w.session())
		if (!outcome.result.ok) throw new Error(`mint refused: ${outcome.result.reason}`)
		const claims = parseAccessClaims((await jwtVerify(outcome.result.token, createLocalJWKSet((await getSigner(ENV)).jwks()))).payload)
		expect(claims?.terminal).toEqual({ id: w.terminalId, label: 'Entrance' })
		expect(claims?.perms.map((entry) => `${entry.action}:${entry.source}`).sort()).toEqual(['attendance.record:terminal', 'attendance.view:grant'])
		expect(outcome.terminal).toEqual({ terminalId: w.terminalId, assertedBy: w.app })
	})

	test('refuses another audience, a released or revoked terminal, and an application that no longer declares one', async () => {
		const w = await world([])
		const session = await w.session()
		expect((await w.mint(session, OTHER_APP)).result).toEqual({ ok: false, reason: 'invalid_session' })
		await w.declareTerminal(false)
		expect((await w.mint(session)).result).toEqual({ ok: false, reason: 'invalid_session' })
		await w.declareTerminal(true)
		expect((await w.mint(session)).result.ok).toBe(true)

		await w.repositories.terminals.release(w.terminalId)
		const released = await w.mint(session)
		expect(released.result).toEqual({ ok: false, reason: 'invalid_session' })
		// The refusal's audit row still names the person and the terminal.
		expect(released).toMatchObject({ principalId: w.person, terminal: { terminalId: w.terminalId, assertedBy: w.app } })

		const again = await world([])
		const live = await again.session()
		await again.repositories.terminals.revoke(again.terminalId)
		expect((await again.mint(live)).result).toEqual({ ok: false, reason: 'invalid_session' })
	})
}

describe('terminal sessions — SQLite', () => {
	terminalSessionSuite(() => {
		const h = createHarness()
		return { repositories: h.repositories, db: new TestSqlDatabase(h.sqlite) }
	})
})

let postgresFixture: PostgresFixture | null = null

beforeAll(async () => {
	if (!hasPostgres) return
	postgresFixture = await createPostgres('iam_terminal_sessions', { max: 4 })
})

afterAll(async () => {
	await postgresFixture?.close()
})

describe.skipIf(!hasPostgres)('terminal sessions — Postgres', () => {
	terminalSessionSuite(() => {
		if (postgresFixture === null) throw new Error('postgres backend not ready')
		return { repositories: createPostgresIamRepositories(postgresFixture.db), db: postgresFixture.db }
	})
})
