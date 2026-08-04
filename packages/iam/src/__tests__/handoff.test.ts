// The cross-host session handoff (ADR-0021).
//
// The property under test throughout is that a code buys exactly ONE app session, for ONE app, for
// as long as the login behind it lives — and nothing else. Every failure mode below is a way that
// could stop being true.

import { AUTH_CALLBACK_PATH, SESSION_COOKIE } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { resolveAdmin } from '../admin/router'
import { createIamApp } from '../app'
import { LOCAL_DEV_ADMIN_ID } from '../auth'
import { handleAuth } from '../auth/routes'
import type { Env, RequestContext } from '../env'
import { exchangeAuthCode, issueAuthCode, normalizeOrigin, resolveReturnUrl } from '../handoff'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { mintToken } from '../tokens'
import { createHarness, seedAppAction, seedGrant, seedUser } from './helpers/harness'

const ISSUER = 'https://iam.test'
const APP_ORIGIN = 'https://app.test'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ADMIN_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', FABRIKA_IAM_PROVISIONING_KEY: '', ENVIRONMENT: 'stage' }
/** The admin surface reaches the database only through `REPOSITORIES`; this proves it. */
const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

class TestContext implements RequestContext {
	readonly waiting: Promise<unknown>[] = []
	waitUntil(promise: Promise<unknown>): void {
		this.waiting.push(promise)
	}
}

/** A harness with one registered app, one user, and a live IAM session for that user. */
async function scenario(options: { origins?: string[] } = {}) {
	const harness = createHarness()
	const services = harness.makeServices({
		issuer: ISSUER,
		environment: 'stage',
		authentication: { oidc: false, password: true },
	})
	await services.repositories.handoff.setReturnOrigins('notes', options.origins ?? [APP_ORIGIN])
	const principalId = seedUser(harness.sqlite, { email: 'human@contember.com', sub: 'sub-1' })
	const sessionToken = await harness.signSession(principalId, { email: 'human@contember.com' })
	const session = await services.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken))
	if (session === null) throw new Error('harness session did not persist')
	return { harness, services, principalId, sessionToken, sessionId: session.id }
}

async function codeFor(services: Services, sessionId: string, returnUrl = `${APP_ORIGIN}/private`): Promise<string> {
	const issued = await issueAuthCode(services, { app: 'notes', parentSessionId: sessionId, returnUrl })
	return issued.code
}

describe('normalizeOrigin', () => {
	test('canonicalizes case and the default port, and drops everything below the origin', () => {
		expect(normalizeOrigin('https://App.Test/some/path?q=1')).toBe('https://app.test')
		expect(normalizeOrigin('https://app.test:443')).toBe('https://app.test')
		expect(normalizeOrigin('http://app.test:8080/')).toBe('http://app.test:8080')
	})

	test('refuses anything that is not an absolute http(s) URL', () => {
		for (const value of ['/private', 'app.test', 'javascript:alert(1)', 'ftp://app.test', '']) {
			expect(normalizeOrigin(value)).toBeNull()
		}
	})
})

describe('resolveReturnUrl', () => {
	test('accepts a registered origin and keeps the path and query', async () => {
		const { services } = await scenario()
		expect(await resolveReturnUrl(services, 'notes', `${APP_ORIGIN}/private/notes?page=2`)).toBe(`${APP_ORIGIN}/private/notes?page=2`)
	})

	test('rejects an origin the app has not registered — including a lookalike host', async () => {
		const { services } = await scenario()
		for (const url of ['https://evil.test/private', 'https://app.test.evil.test/', 'http://app.test/private']) {
			expect(await resolveReturnUrl(services, 'notes', url)).toBeNull()
		}
	})

	test('rejects a registered origin claimed by a DIFFERENT app', async () => {
		// Registration is per app; otherwise one tenant could redirect another tenant's login.
		const { services } = await scenario()
		expect(await resolveReturnUrl(services, 'other', `${APP_ORIGIN}/private`)).toBeNull()
	})

	test('a fragment cannot smuggle a second target past the origin check', async () => {
		const { services } = await scenario()
		// The URL is rebuilt from origin + pathname + search, so the fragment is dropped entirely.
		expect(await resolveReturnUrl(services, 'notes', `${APP_ORIGIN}/private#@evil.test`)).toBe(`${APP_ORIGIN}/private`)
	})
})

describe('exchangeAuthCode', () => {
	test('redeems once into an app-bound child session and returns the stored return URL', async () => {
		const { services, principalId, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)

		const { result } = await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r1' })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.returnUrl).toBe(`${APP_ORIGIN}/private`)

		const child = await services.repositories.sessions.getActiveSessionByHash(await hashToken(result.session))
		expect(child?.app).toBe('notes')
		expect(child?.parent_session_id).toBe(sessionId)
		expect(child?.principal_id).toBe(principalId)
	})

	test('a replayed code is refused — consumption is the guard, not the read', async () => {
		const { services, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		expect((await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r1' })).result.ok).toBe(true)

		const replay = await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r2' })
		expect(replay.result).toEqual({ ok: false, reason: 'expired_code' })
	})

	test('a code issued for one app cannot be redeemed by another, and is spent trying', async () => {
		const { services, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)

		expect((await exchangeAuthCode(services, { app: 'other', code, requestId: 'r1' })).result).toEqual({ ok: false, reason: 'wrong_app' })
		// Spent: a code that survived a failed redemption would be a code an attacker keeps trying.
		expect((await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r2' })).result).toEqual({ ok: false, reason: 'expired_code' })
	})

	test('an unknown code is invalid_code, not expired_code', async () => {
		const { services } = await scenario()
		expect((await exchangeAuthCode(services, { app: 'notes', code: 'never-issued', requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_code',
		})
	})

	test('an expired code is refused', async () => {
		const { services, harness, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		harness.sqlite.run('UPDATE auth_codes SET expires_at = ?', [Math.floor(Date.now() / 1000) - 1])
		expect((await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r1' })).result).toEqual({ ok: false, reason: 'expired_code' })
	})

	test('a code outlives no logout — revoking the login refuses redemption', async () => {
		const { services, sessionToken, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		await services.repositories.sessions.revokeSessionByHash(await hashToken(sessionToken))
		expect((await exchangeAuthCode(services, { app: 'notes', code, requestId: 'r1' })).result).toEqual({ ok: false, reason: 'invalid_code' })
	})
})

describe('the child session', () => {
	test('dies with its parent — this is what makes logout reach a host IAM cannot set a cookie on', async () => {
		const { services, sessionToken, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, { app: 'notes', code: await codeFor(services, sessionId), requestId: 'r1' })
		if (!result.ok) throw new Error('exchange failed')
		const childHash = await hashToken(result.session)
		expect(await services.repositories.sessions.getActiveSessionByHash(childHash)).not.toBeNull()

		await services.repositories.sessions.revokeSessionByHash(await hashToken(sessionToken))
		expect(await services.repositories.sessions.getActiveSessionByHash(childHash)).toBeNull()
	})

	test('mints for its own app and is refused for any other', async () => {
		const { services, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, { app: 'notes', code: await codeFor(services, sessionId), requestId: 'r1' })
		if (!result.ok) throw new Error('exchange failed')

		const own = await mintToken(services, AUTH_ENV, { app: 'notes', session: result.session, requestId: 'r2' })
		expect(own.result.ok).toBe(true)

		const other = await mintToken(services, AUTH_ENV, { app: 'other', session: result.session, requestId: 'r3' })
		expect(other.result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test('cannot itself authorize another handoff', async () => {
		// Only the IAM login may father app sessions; otherwise one app could mint access to the next.
		const { services, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, { app: 'notes', code: await codeFor(services, sessionId), requestId: 'r1' })
		if (!result.ok) throw new Error('exchange failed')

		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(`${APP_ORIGIN}/private`)}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${result.session}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		// Falls through to the login form rather than issuing a code off the child.
		expect(response.status).toBe(200)
	})
})

describe('GET /auth/login as a handoff', () => {
	test('an existing IAM session is handed off with no prompt', async () => {
		const { services, sessionToken } = await scenario()
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(`${APP_ORIGIN}/private?x=1`)}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.origin).toBe(APP_ORIGIN)
		expect(location.pathname).toBe(AUTH_CALLBACK_PATH)
		expect(location.searchParams.get('code')).toBeTruthy()
		// The destination is NOT in the redirect — it was stored with the code.
		expect(location.searchParams.get('redirect')).toBeNull()
	})

	test('an app with an EMPTY registry has not opted in — the ordinary login still works', async () => {
		// The proxy sends `app=` on every bounce, so treating "no registry" as a misconfiguration would
		// break every installation that shares a cookie domain with IAM the moment it upgraded. The
		// local stack is exactly that.
		const { services, sessionToken } = await scenario({ origins: [] })
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(ISSUER)}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		// The ordinary login, unchanged: the form renders and carries no app, so nothing downstream
		// issues a code. Not a 400, which is what an empty registry used to produce.
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('<form method="post" action="/auth/login">')
		expect(html).not.toContain('name="app"')
	})

	test('an empty registry that CANNOT be served by the shared cookie is a 400, not a login loop', async () => {
		// The narrow half of the opt-out above. With no cookie domain, `safeRedirect` refuses the app's
		// host, so the ordinary path provably cannot carry the browser back: the fast path is skipped
		// (there is no handoff), the form lands the human on IAM's root, they go back, and it repeats.
		// Unbounded, and with OIDC completely silent — the IdP auto-approves every lap.
		const { services, sessionToken } = await scenario({ origins: [] })
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(`${APP_ORIGIN}/private`)}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
		// The message names the origin nobody registered — the one thing an operator has to act on.
		expect(await response.text()).toContain(APP_ORIGIN)
	})

	test('an unregistered return address is a 400, never a quiet fallback to the issuer', async () => {
		const { services, sessionToken } = await scenario()
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent('https://evil.test/')}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
	})

	test('without a session the password form carries BOTH the app and its return address forward', async () => {
		const { services } = await scenario()
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(`${APP_ORIGIN}/private`)}`),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('name="app" value="notes"')
		// `safeRedirect`'s allowlist is the session-cookie domain, which by construction excludes the
		// cross-host case. Letting it rewrite this to the issuer strands the login on IAM — it did,
		// live, and the form looked perfectly fine.
		expect(html).toContain(`name="redirect" value="${APP_ORIGIN}/private"`)
	})

	test('signing in at the form completes the handoff', async () => {
		const { services, harness, principalId } = await scenario()
		const password = 'a-sufficiently-long-passphrase'
		await services.repositories.passwords.enableEnrollment(principalId)
		await services.repositories.passwords.upsertCredential(principalId, await services.passwordHasher.hash(password))
		void harness

		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login`, {
				method: 'POST',
				headers: { Origin: ISSUER, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ email: 'human@contember.com', password, app: 'notes', redirect: `${APP_ORIGIN}/private` }),
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.origin).toBe(APP_ORIGIN)
		expect(location.pathname).toBe(AUTH_CALLBACK_PATH)
		expect(location.searchParams.get('code')).toBeTruthy()
		// The IAM session is set too — that is what makes the NEXT app silent.
		expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
		// A single-use code sits in that Location, and a session cookie in that header set.
		expect(response.headers.get('cache-control')).toBe('no-store')
	})
})

describe('registering return origins', () => {
	/** Drive the real admin RPC: an admin session, a registered app, and the shipped router. */
	async function adminCall(input: unknown): Promise<Response> {
		const harness = createHarness()
		const adminId = seedUser(harness.sqlite, { sub: 'sub-admin', email: 'admin@contember.com' })
		seedGrant(harness.sqlite, adminId, 'admin')
		seedAppAction(harness.sqlite, 'notes', 'note.read')
		const session = await harness.signSession(adminId)
		const env: Env = {
			DB: unusedDatabase,
			REPOSITORIES: harness.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ADMIN_ORIGINS: JSON.stringify([ISSUER]),
			ENVIRONMENT: 'stage',
			ISSUER: ISSUER,
			FABRIKA_IAM_SIGNING_KEYS: '',
			FABRIKA_IAM_PROVISIONING_KEY: '',
			SESSION_COOKIE_DOMAIN: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: 'client',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		return createIamApp().fetch(
			new Request(`${ISSUER}/admin/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ISSUER, cookie: `${SESSION_COOKIE}=${session}` },
				body: JSON.stringify({ method: 'apps.setReturnOrigins', input }),
			}),
			env,
			{ waitUntil() {} },
		)
	}

	test('an unknown app is a 404, reported before anything is said about the origins', async () => {
		// Every other app-scoped use case validates this; without it a typo in the app id registered
		// origins nobody would ever look up.
		const response = await adminCall({ app: 'nope', origins: ['not-a-url'] })
		expect(response.status).toBe(404)
	})

	test('an empty set is refused — it is indistinguishable from never having registered', async () => {
		const response = await adminCall({ app: 'notes', origins: [] })
		expect(response.status).toBe(400)
	})

	test('replacement is atomic, so no failure can leave an app with no origin at all', async () => {
		// The repository writes the DELETE and the INSERTs as one batch. A rejected INSERT (here: a
		// duplicate primary key, forced through the raw connection) must take the DELETE with it.
		const harness = createHarness()
		await harness.repositories.handoff.setReturnOrigins('notes', [APP_ORIGIN])
		harness.sqlite.run('CREATE TRIGGER refuse_origin BEFORE INSERT ON app_return_origins BEGIN SELECT RAISE(ABORT, 0); END')
		await expect(harness.repositories.handoff.setReturnOrigins('notes', ['https://other.test'])).rejects.toThrow()
		harness.sqlite.run('DROP TRIGGER refuse_origin')
		expect(await harness.repositories.handoff.listReturnOrigins('notes')).toEqual([APP_ORIGIN])
	})
})

// ── Sessions the bypass minted (backlog 52) ───────────────────────────────────
//
// `LOCAL_DEV_LOGIN` mints a REAL 30-day session for a fixed global admin. Turning the flag off used
// to change nothing about what was already issued, so an installation that moved to real
// authentication kept honouring them for a month. Found live: a browser sailed through the handoff
// with no password because it still held one from the day before.

describe('a session minted by the local-dev bypass', () => {
	async function bypassSession(localDevLogin: boolean) {
		const harness = createHarness()
		const services = harness.makeServices({
			issuer: ISSUER,
			environment: 'local',
			localDevLogin,
			authentication: { oidc: false, password: true },
		})
		await services.repositories.handoff.setReturnOrigins('notes', [APP_ORIGIN])
		const principalId = seedUser(harness.sqlite, { email: 'dev@local.test', sub: LOCAL_DEV_ADMIN_ID })
		const token = await harness.signSession(principalId, { idpSub: LOCAL_DEV_ADMIN_ID, email: 'dev@local.test' })
		return { services, token, principalId }
	}

	test('still works while the bypass is on', async () => {
		const { services, token } = await bypassSession(true)
		expect((await mintToken(services, AUTH_ENV, { app: 'notes', session: token, requestId: 'r1' })).result.ok).toBe(true)
	})

	test('stops minting the moment the bypass is off', async () => {
		const { services, token } = await bypassSession(false)
		expect((await mintToken(services, AUTH_ENV, { app: 'notes', session: token, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
	})

	test('cannot silently hand an app a global admin through the handoff', async () => {
		const { services, token } = await bypassSession(false)
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes&redirect=${encodeURIComponent(`${APP_ORIGIN}/private`)}`, {
				headers: { Cookie: `${SESSION_COOKIE}=${token}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		// The password form, not a 302 carrying a code.
		expect(response.status).toBe(200)
	})

	test('stops opening the admin surface too', async () => {
		const { services, token } = await bypassSession(false)
		const resolution = await resolveAdmin(services, ADMIN_ENV, { bearer: null, session: token, requestId: 'r1' })
		expect(resolution).toEqual({ ok: false, status: 401, reason: 'invalid_session' })
	})
})
