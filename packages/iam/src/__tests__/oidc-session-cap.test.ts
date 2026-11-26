// An OIDC login is usable for the installation's cap (`OIDC_SESSION_HOURS`, 12 h by default) after its sign-in; then
// IAM sends the browser back to the provider, which is where an organization blocks a person. Checked at use, from the
// login's sign-in, so a console session derived from an older login stops too, and so do logins issued before the cap.
//
// Twice, once against SQLite and once against a real Postgres, because the sign-in time comes from a join both engines
// run. The Postgres half skips (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — helpers/postgres.ts.

import { AUTH_CALLBACK_PATH, AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import { PASSWORD_MIN_LENGTH_FLOOR } from '@fabrika/iam-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sessionUsable } from '../auth'
import { handleAuth } from '../auth/routes'
import { issueSession } from '../auth/sessions'
import { type AuthenticationMethod, createPostgresIamRepositories, type IamRepositories } from '../db'
import { grantAuthority } from '../oauth'
import { pkceChallenge } from '../oidc'
import { parseOidcSessionSeconds } from '../oidc-session'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { mintToken } from '../tokens'
import { CONSOLE_APP, createHarness, makeServicesFor, TEST_SIGNING_ENV, TestSqlDatabase } from './helpers/harness'
import { register } from './helpers/oauth'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const ISSUER = 'https://iam.test'
const CONSOLE_ORIGIN = 'https://console.test'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const HANDOFF_CHALLENGE = await pkceChallenge('oidc-session-cap-verifier')
const HOUR = 3600
const CLIENT_ID = 'https://client.test/cimd'
const RESOURCE = 'https://control.test/mcp'
const CAP = 12 * HOUR

if (!hasPostgres) {
	console.warn(`oidc-session-cap.test.ts (Postgres half) ${skipReason}`)
}

const now = () => Math.floor(Date.now() / 1000)
const ctx = { waitUntil(): void {} }

/** Where `/auth/login` sends a browser holding `session` that opens the console: its callback, the provider, or a page. */
async function consoleSignIn(services: Services, session: string): Promise<string> {
	const url = new URL('/auth/login', ISSUER)
	url.searchParams.set('app', CONSOLE_APP)
	url.searchParams.set('redirect', `${CONSOLE_ORIGIN}/`)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, 'oidc-session-cap-state')
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, HANDOFF_CHALLENGE)
	const response = await handleAuth(new Request(url, { headers: { Cookie: `${SESSION_COOKIE}=${session}` } }), services, AUTH_ENV, ctx)
	if (response.status !== 302) return `page ${response.status}`
	const location = new URL(response.headers.get('location') ?? '')
	if (location.origin === CONSOLE_ORIGIN && location.pathname === AUTH_CALLBACK_PATH) return 'console'
	if (location.href.startsWith('https://idp.test/authorize')) return 'provider'
	return location.href
}

/** Mint the console's token from its app session, as the proxy does on every renewal. */
async function consoleMint(services: Services, session: string): Promise<boolean> {
	return (await mintToken(services, AUTH_ENV, { app: CONSOLE_APP, session, requestId: 'r1' })).result.ok
}

let seq = 0

/**
 * A login of `method` that signed in `age` seconds ago, and the console session derived from it a moment ago — the
 * child's own creation is recent, so only the parent's sign-in can tell how old the login is.
 */
async function login(db: SqlDatabase, repositories: IamRepositories, method: AuthenticationMethod, age: number) {
	seq += 1
	const principal = await repositories.principals.createUser(`cap-sub-${seq}`, `cap-${seq}@contember.com`)
	const token = `cap-login-${seq}`
	const signedIn = now() - age
	const loginId = await repositories.sessions.createSession({
		tokenHash: await hashToken(token),
		principalId: principal.id,
		...(method === 'password' ? {} : { idpSub: `cap-sub-${seq}` }),
		authenticationMethod: method,
		expiresAt: signedIn + 30 * 24 * HOUR,
	})
	const consoleSession = `cap-console-${seq}`
	await repositories.sessions.createSession({
		tokenHash: await hashToken(consoleSession),
		principalId: principal.id,
		...(method === 'password' ? {} : { idpSub: `cap-sub-${seq}` }),
		authenticationMethod: method,
		expiresAt: signedIn + 30 * 24 * HOUR,
		app: CONSOLE_APP,
		parentSessionId: loginId,
	})
	// A session's creation is the writer's clock; the login is aged after the fact, which is what time does.
	await db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').bind(signedIn, loginId).run()
	return { token, consoleSession, loginId, signedIn }
}

describe('parseOidcSessionSeconds', () => {
	test('defaults to 12 hours and takes whole hours from 1 to 720', () => {
		expect(parseOidcSessionSeconds(undefined)).toBe(CAP)
		expect(parseOidcSessionSeconds(' ')).toBe(CAP)
		expect(parseOidcSessionSeconds('1')).toBe(HOUR)
		expect(parseOidcSessionSeconds('720')).toBe(720 * HOUR)
		for (const value of ['0', '721', '-1', '12h', '1.5', '012']) {
			expect(() => parseOidcSessionSeconds(value)).toThrow('OIDC_SESSION_HOURS must be a whole number of hours from 1 to 720')
		}
	})
})

describe('sessionUsable and the OIDC cap', () => {
	const config = {
		authentication: { oidc: { enabled: true, sessionCapSeconds: CAP }, password: { enabled: true, minLengthFloor: PASSWORD_MIN_LENGTH_FLOOR } },
		localDevLogin: false,
	}
	const at = 1_000_000
	const session = (authentication_method: AuthenticationMethod, signedInAgo: number) => ({
		authentication_method,
		signed_in_at: at - signedInAgo,
		expires_at: at + 30 * 24 * HOUR,
	})

	test('an OIDC login is usable until its sign-in plus the cap, and not from then on', () => {
		expect(sessionUsable(session('oidc', CAP - 1), config, at)).toBe(true)
		expect(sessionUsable(session('oidc', CAP), config, at)).toBe(false)
	})

	test('a password login is not capped', () => {
		expect(sessionUsable(session('password', 29 * 24 * HOUR), config, at)).toBe(true)
	})
})

describe('the OIDC session cap — SQLite', () => {
	function installation(cap = CAP) {
		const harness = createHarness()
		const services = harness.makeServices({ issuer: ISSUER, environment: 'stage', oidcSessionCapSeconds: cap })
		return { harness, services, db: new TestSqlDatabase(harness.sqlite) }
	}

	test('a console session younger than the cap keeps working', async () => {
		const { harness, services, db } = installation()
		await services.repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE_ORIGIN])
		const young = await login(db, harness.repositories, 'oidc', CAP - HOUR)

		expect(await consoleMint(services, young.consoleSession)).toBe(true)
		expect(await consoleSignIn(services, young.token)).toBe('console')
	})

	test('a console session older than the cap is sent back to the OIDC provider', async () => {
		const { harness, services, db } = installation()
		await services.repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE_ORIGIN])
		const old = await login(db, harness.repositories, 'oidc', CAP + HOUR)

		// The proxy's renewal is refused, so it sends the browser to IAM's sign-in, which no longer honours the login.
		expect(await consoleMint(services, old.consoleSession)).toBe(false)
		expect(await consoleSignIn(services, old.token)).toBe('provider')
	})

	test('the cap is the setting: the same login passes under a longer one', async () => {
		const { harness, services, db } = installation(24 * HOUR)
		await services.repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE_ORIGIN])
		const old = await login(db, harness.repositories, 'oidc', CAP + HOUR)

		expect(await consoleMint(services, old.consoleSession)).toBe(true)
		expect(await consoleSignIn(services, old.token)).toBe('console')
	})

	test('a password login older than the cap keeps working', async () => {
		const harness = createHarness()
		const services = harness.makeServices({ issuer: ISSUER, environment: 'stage', authentication: { oidc: true, password: true } })
		const old = await login(new TestSqlDatabase(harness.sqlite), harness.repositories, 'password', CAP + HOUR)

		expect(await consoleMint(services, old.consoleSession)).toBe(true)
	})

	test('a token minted near the cap ends at the cap, not 5 minutes later', async () => {
		const { harness, services, db } = installation()
		const almost = await login(db, harness.repositories, 'oidc', CAP - 60)

		const outcome = await mintToken(services, AUTH_ENV, { app: CONSOLE_APP, session: almost.consoleSession, requestId: 'r1' })
		if (!outcome.result.ok) throw new Error(`mint refused: ${outcome.result.reason}`)
		expect(outcome.result.expiresAt).toBe(almost.signedIn + CAP)
	})

	test("an MCP client's refreshed token ends at the cap of the login its grant was given under", async () => {
		const harness = createHarness()
		await register(harness.repositories, { provider: 'claude', clientId: CLIENT_ID, redirectUris: [`${ISSUER}/cb`], metadataUrl: CLIENT_ID })
		const services = harness.makeServices({
			issuer: ISSUER,
			environment: 'stage',
			oidcSessionCapSeconds: CAP,
			oauth: {
				resources: [{ app: 'control', resource: RESOURCE, defaultScopes: ['read'], scopeGrants: [{ scope: 'read', permissions: [{ action: '*' }] }] }],
				hosts: [],
			},
		})
		const almost = await login(new TestSqlDatabase(harness.sqlite), harness.repositories, 'oidc', CAP - 60)
		const principalId = harness.sqlite.query<{ principal_id: string }, [string]>('SELECT principal_id FROM sessions WHERE id = ?').get(almost.loginId)
			?.principal_id
		if (principalId === undefined) throw new Error('no login row')
		// A grant given before the cap stores the login's old 30-day expiry.
		const grant = {
			id: 'cap-grant',
			principal_id: principalId,
			session_id: almost.loginId,
			client_id: CLIENT_ID,
			app: 'control',
			resource: RESOURCE,
			resources: null,
			scopes: JSON.stringify(['read']),
			created_at: almost.signedIn,
			expires_at: almost.signedIn + 30 * 24 * HOUR,
			revoked_at: null,
			agent_label: null,
			passkey_confirmed_at: null,
		}

		expect((await grantAuthority(services, grant, now()))?.expiresAt).toBe(almost.signedIn + CAP)
		expect(await grantAuthority(services, grant, almost.signedIn + CAP)).toBeNull()
	})

	test('a new OIDC login stores the cap as its expiry and cookie lifetime; a password login keeps 30 days', async () => {
		const { harness, services } = installation()
		const oidcUser = await harness.repositories.principals.createUser('cap-new-oidc', 'cap-new-oidc@contember.com')
		const passwordUser = await harness.repositories.principals.createUser('cap-new-password', 'cap-new-password@contember.com')
		const open = (principalId: string, authenticationMethod: AuthenticationMethod) =>
			issueSession(new Request(`${ISSUER}/auth/callback`), services, TEST_SIGNING_ENV, ctx, {
				principalId,
				...(authenticationMethod === 'oidc' ? { idpSub: `idp-${principalId}` } : {}),
				authenticationMethod,
				redirect: `${ISSUER}/`,
				reason: 'test',
				requestId: 'r1',
			})

		const before = now()
		const oidcCookie = (await open(oidcUser.id, 'oidc')).headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
		const passwordCookie = (await open(passwordUser.id, 'password')).headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
		const expiry = (principalId: string) =>
			harness.sqlite.query<{ expires_at: number }, [string]>('SELECT expires_at FROM sessions WHERE principal_id = ?').get(principalId)?.expires_at

		expect(oidcCookie).toContain(`Max-Age=${CAP}`)
		expect(expiry(oidcUser.id)).toBeGreaterThanOrEqual(before + CAP)
		expect(expiry(oidcUser.id)).toBeLessThanOrEqual(now() + CAP)
		expect(passwordCookie).toContain(`Max-Age=${30 * 24 * HOUR}`)
		expect(expiry(passwordUser.id)).toBeGreaterThanOrEqual(before + 30 * 24 * HOUR)
	})
})

describe.skipIf(!hasPostgres)('the OIDC session cap — Postgres', () => {
	let fixture: PostgresFixture | null = null
	let repositories: IamRepositories

	beforeAll(async () => {
		if (!hasPostgres) return
		fixture = await createPostgres('oidc_session_cap')
		repositories = createPostgresIamRepositories(fixture.db)
	})

	afterAll(async () => {
		await fixture?.close()
	})

	test('a console session older than the cap is sent back to the provider, a younger one keeps working', async () => {
		if (fixture === null) throw new Error('no Postgres fixture')
		await repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE_ORIGIN])
		const services = makeServicesFor(repositories, { issuer: ISSUER, environment: 'stage', oidcSessionCapSeconds: CAP })
		const young = await login(fixture.db, repositories, 'oidc', CAP - HOUR)
		const old = await login(fixture.db, repositories, 'oidc', CAP + HOUR)

		expect(await consoleMint(services, young.consoleSession)).toBe(true)
		expect(await consoleSignIn(services, young.token)).toBe('console')
		expect(await consoleMint(services, old.consoleSession)).toBe(false)
		expect(await consoleSignIn(services, old.token)).toBe('provider')
	})
})
