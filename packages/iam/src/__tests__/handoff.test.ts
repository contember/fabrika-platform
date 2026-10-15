// The session handoff (ADR-0022, ADR-0023) — the only way a session reaches an app's host.
//
// The property under test throughout is that a code buys exactly ONE app session, for ONE app, for
// as long as the login behind it lives — and nothing else. Every failure mode below is a way that
// could stop being true.

import { AUTH_CALLBACK_PATH, AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { LOCAL_DEV_ADMIN_ID } from '../auth'
import { handleAuth } from '../auth/routes'
import type { Env, RequestContext } from '../env'
import { exchangeAuthCode, issueAuthCode, normalizeOrigin, resolveReturnUrl } from '../handoff'
import { prop } from '../json'
import { pkceChallenge } from '../oidc'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { mintToken } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedGrant, seedUser, TEST_SIGNING_KEYS } from './helpers/harness'

const ISSUER = 'https://iam.test'
const APP_ORIGIN = 'https://app.test'
const HANDOFF_STATE = 'state-state-state1'
const HANDOFF_VERIFIER = 'browser-held-verifier-browser-held-verifier-1'
const HANDOFF_CHALLENGE = await pkceChallenge(HANDOFF_VERIFIER)
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
/** The admin surface reaches the database only through `REPOSITORIES`; this proves it. */
class TestContext implements RequestContext {
	readonly waiting: Promise<unknown>[] = []
	waitUntil(promise: Promise<unknown>): void {
		this.waiting.push(promise)
	}
}

/** A harness with one registered app, one user, and a live IAM session for that user. */
async function scenario(options: { origins?: string[]; label?: string } = {}) {
	const harness = createHarness()
	// Both methods on: the session below is an OIDC one, and a session whose method the installation
	// has since disabled is refused everywhere it is used (`sessionUsable`).
	const services = harness.makeServices({
		issuer: ISSUER,
		environment: 'stage',
		authentication: { oidc: true, password: true },
	})
	await services.repositories.handoff.setReturnOrigins('notes', options.origins ?? [APP_ORIGIN])
	const principalId = seedUser(harness.sqlite, {
		email: 'human@contember.com',
		sub: 'sub-1',
		...(options.label === undefined ? {} : { label: options.label }),
	})
	const sessionToken = await harness.signSession(principalId, { email: 'human@contember.com' })
	const session = await services.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken))
	if (session === null) throw new Error('harness session did not persist')
	return { harness, services, principalId, sessionToken, sessionId: session.id }
}

async function codeFor(services: Services, sessionId: string, returnUrl = `${APP_ORIGIN}/private`): Promise<string> {
	const issued = await issueAuthCode(services, {
		app: 'notes',
		parentSessionId: sessionId,
		returnUrl,
		challenge: HANDOFF_CHALLENGE,
	})
	return issued.code
}

/** Age a login past the moment in which it counts as the choice of the application it lands on. */
function ageLogin(harness: Harness, sessionId: string): void {
	harness.sqlite.run('UPDATE sessions SET created_at = created_at - 3600 WHERE id = ?', [sessionId])
}

function issuedCodes(harness: Harness): number {
	return harness.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM auth_codes').get()?.n ?? 0
}

/** The answer the account question posts: the handoff's fields, a decision, and the browser's own headers. */
function accountChoice(decision: string, options: { cookie?: string; fetchSite?: string; redirect?: string } = {}): Request {
	return new Request(`${ISSUER}/auth/login/account`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Sec-Fetch-Site': options.fetchSite ?? 'same-origin',
			Origin: 'null',
			...(options.cookie === undefined ? {} : { Cookie: `${SESSION_COOKIE}=${options.cookie}` }),
		},
		body: new URLSearchParams({
			app: 'notes',
			redirect: options.redirect ?? `${APP_ORIGIN}/private`,
			[AUTH_HANDOFF_STATE_PARAM]: HANDOFF_STATE,
			[AUTH_HANDOFF_CHALLENGE_PARAM]: HANDOFF_CHALLENGE,
			decision,
		}),
	})
}

function handoffLoginUrl(returnUrl: string): string {
	const url = new URL('/auth/login', ISSUER)
	url.searchParams.set('app', 'notes')
	url.searchParams.set('redirect', returnUrl)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, HANDOFF_STATE)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, HANDOFF_CHALLENGE)
	return url.toString()
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

	// The URL parser keeps these in a host, and the origin is written into a CSP `form-action` source list.
	test('refuses a host carrying a character that would end or widen a CSP directive', () => {
		for (
			const value of ['https://app.test;frame-src', 'https://a%3Bb.test', 'https://a,b.test', 'https://a"b.test', "https://a'b.test", 'https://*.test']
		) {
			expect(normalizeOrigin(value)).toBeNull()
		}
		expect(normalizeOrigin('https://bücher.example/x')).toBe('https://xn--bcher-kva.example')
		expect(normalizeOrigin('http://[::1]:3000/')).toBe('http://[::1]:3000')
	})

	test('a login naming such an address is refused, and a stored one widens no form-action', async () => {
		const { services } = await scenario({ origins: [`${APP_ORIGIN};script-src`] })
		const refused = await handleAuth(new Request(handoffLoginUrl(`${APP_ORIGIN};script-src/private`)), services, AUTH_ENV, new TestContext())
		expect(refused.status).toBe(400)
		expect(refused.headers.get('content-security-policy')).toContain(`form-action 'self';`)
		const page = await handleAuth(new Request(`${ISSUER}/auth/password/reset?app=notes`), services, AUTH_ENV, new TestContext())
		expect(page.headers.get('content-security-policy')).toContain(`form-action 'self';`)
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

		const { result } = await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })
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
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })).result.ok).toBe(true)

		const replay = await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r2' })
		expect(replay.result).toEqual({ ok: false, reason: 'expired_code' })
	})

	test('a code issued for one app cannot be redeemed by another, and is spent trying', async () => {
		const { services, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)

		expect((await exchangeAuthCode(services, { app: 'other', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'wrong_app',
		})
		// Spent: a code that survived a failed redemption would be a code an attacker keeps trying.
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r2' })).result).toEqual({
			ok: false,
			reason: 'expired_code',
		})
	})

	test('an unknown code is invalid_code, not expired_code', async () => {
		const { services } = await scenario()
		expect((await exchangeAuthCode(services, { app: 'notes', code: 'never-issued', verifier: HANDOFF_VERIFIER, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_code',
		})
	})

	test('an expired code is refused', async () => {
		const { services, harness, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		harness.sqlite.run('UPDATE auth_codes SET expires_at = ?', [Math.floor(Date.now() / 1000) - 1])
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'expired_code',
		})
	})

	test('a code outlives no logout — revoking the login refuses redemption', async () => {
		const { services, sessionToken, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		await services.repositories.sessions.revokeSessionByHash(await hashToken(sessionToken))
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_code',
		})
	})

	test('a code cannot be redeemed without the verifier held by the initiating browser', async () => {
		const { services, sessionId } = await scenario()
		const code = await codeFor(services, sessionId)
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: 'attacker-verifier', requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_verifier',
		})
	})
})

describe('the child session', () => {
	test('dies with its parent — this is what makes logout reach a host IAM cannot set a cookie on', async () => {
		const { services, sessionToken, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		if (!result.ok) throw new Error('exchange failed')
		const childHash = await hashToken(result.session)
		expect(await services.repositories.sessions.getActiveSessionByHash(childHash)).not.toBeNull()

		await services.repositories.sessions.revokeSessionByHash(await hashToken(sessionToken))
		expect(await services.repositories.sessions.getActiveSessionByHash(childHash)).toBeNull()
	})

	test('mints for its own app and is refused for any other', async () => {
		const { services, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		if (!result.ok) throw new Error('exchange failed')

		const own = await mintToken(services, AUTH_ENV, { app: 'notes', session: result.session, requestId: 'r2' })
		expect(own.result.ok).toBe(true)

		const other = await mintToken(services, AUTH_ENV, { app: 'other', session: result.session, requestId: 'r3' })
		expect(other.result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test('cannot itself authorize another handoff', async () => {
		// Only the IAM login may father app sessions; otherwise one app could mint access to the next.
		const { services, sessionId } = await scenario()
		const { result } = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		if (!result.ok) throw new Error('exchange failed')

		const response = await handleAuth(
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private`), {
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

describe('a handoff for a browser already signed in to IAM', () => {
	async function loginRequest(sessionToken: string): Promise<Request> {
		return new Request(handoffLoginUrl(`${APP_ORIGIN}/private?x=1`), { headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` } })
	}

	function expectCallback(response: Response): string {
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.origin).toBe(APP_ORIGIN)
		expect(location.pathname).toBe(AUTH_CALLBACK_PATH)
		expect(location.searchParams.get(AUTH_HANDOFF_STATE_PARAM)).toBe(HANDOFF_STATE)
		// The destination is NOT in the redirect — it was stored with the code.
		expect(location.searchParams.get('redirect')).toBeNull()
		expect(response.headers.get('cache-control')).toBe('no-store')
		const code = location.searchParams.get('code')
		if (code === null) throw new Error('the callback carries no code')
		return code
	}

	function expectSignIn(response: Response): void {
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/auth/login`)
		expect(location.searchParams.get('app')).toBe('notes')
		expect(location.searchParams.get('redirect')).toBe(`${APP_ORIGIN}/private`)
		expect(location.searchParams.get(AUTH_HANDOFF_STATE_PARAM)).toBe(HANDOFF_STATE)
		expect(location.searchParams.get(AUTH_HANDOFF_CHALLENGE_PARAM)).toBe(HANDOFF_CHALLENGE)
	}

	test('asks which account to use when the login holds no session at the app, and mints no code', async () => {
		const { harness, services, sessionToken, sessionId } = await scenario({ label: 'Human <b>&</b>' })
		ageLogin(harness, sessionId)
		const response = await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext())
		expect(response.status).toBe(200)
		expect(issuedCodes(harness)).toBe(0)
		const csp = response.headers.get('content-security-policy') ?? ''
		// Continuing answers the 302 to the app's callback, which Chromium checks against `form-action`.
		expect(csp).toContain(`form-action 'self' ${APP_ORIGIN};`)
		expect(csp).toContain(`frame-ancestors 'none'`)
		expect(response.headers.get('x-frame-options')).toBe('DENY')
		const html = await response.text()
		expect(html).toContain('action="/auth/login/account"')
		expect(html).toContain('Continue as Human &lt;b&gt;&amp;&lt;/b&gt;')
		expect(html).not.toContain('<b>')
		expect(html).toContain('name="decision" value="another"')
		expect(html).toContain(`name="redirect" value="${APP_ORIGIN}/private?x=1"`)
		expect(html).toContain(`name="code_challenge" value="${HANDOFF_CHALLENGE}"`)
	})

	test("speaks the application's language and names it", async () => {
		const { harness, services, sessionToken, sessionId } = await scenario()
		harness.sqlite.run("INSERT INTO app_presentation (app, locale, display_name) VALUES ('notes', 'cs', 'Poznámky')")
		ageLogin(harness, sessionId)
		const html = await (await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext())).text()
		expect(html).toContain('<html lang="cs">')
		expect(html).toContain('Pokračovat do aplikace Poznámky')
		expect(html).toContain('Pokračovat jako human@contember.com')
	})

	test('continues with no prompt when the login already holds a live session at the app', async () => {
		// The browser lost the app's cookie, but this login already chose the app.
		const { harness, services, sessionToken, sessionId } = await scenario()
		ageLogin(harness, sessionId)
		const first = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		expect(first.result.ok).toBe(true)
		const code = expectCallback(await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext()))
		expect((await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r2' })).result.ok).toBe(true)
	})

	test('a revoked app session is no longer the choice of the app', async () => {
		const { harness, services, sessionToken, sessionId } = await scenario()
		ageLogin(harness, sessionId)
		const first = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		if (!first.result.ok) throw new Error('exchange failed')
		await services.repositories.sessions.revokeSessionByHash(await hashToken(first.result.session))
		expect((await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext())).status).toBe(200)
	})

	test('a session at ANOTHER app is not the choice of this one', async () => {
		const { harness, services, sessionToken, sessionId, principalId } = await scenario()
		ageLogin(harness, sessionId)
		await services.repositories.sessions.createSession({
			tokenHash: 'other-app-child',
			principalId,
			idpSub: 'sub-1',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			app: 'other',
			parentSessionId: sessionId,
		})
		expect(await services.repositories.sessions.hasActiveChild(sessionId, 'other')).toBe(true)
		expect(await services.repositories.sessions.hasActiveChild(sessionId, 'notes')).toBe(false)
		expect((await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext())).status).toBe(200)
	})

	test('continues with no prompt for a login issued moments ago', async () => {
		// A completed password action or a sign-in on IAM's own page lands on the app, whose proxy starts this handoff.
		const { services, sessionToken } = await scenario()
		expectCallback(await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext()))
	})

	test('a login of a principal that is not an active user gets the sign-in form, not the question', async () => {
		const { harness, services, sessionToken, sessionId, principalId } = await scenario()
		ageLogin(harness, sessionId)
		harness.sqlite.run('UPDATE principals SET disabled_at = 1 WHERE id = ?', [principalId])
		const response = await handleAuth(await loginRequest(sessionToken), services, AUTH_ENV, new TestContext())
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('name="password"')
		expect(issuedCodes(harness)).toBe(0)
	})

	test('"continue" hands off from the login the browser holds', async () => {
		const { harness, services, sessionToken, sessionId } = await scenario()
		ageLogin(harness, sessionId)
		const code = expectCallback(await handleAuth(accountChoice('continue', { cookie: sessionToken }), services, AUTH_ENV, new TestContext()))
		const { result } = await exchangeAuthCode(services, { app: 'notes', code, verifier: HANDOFF_VERIFIER, requestId: 'r1' })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.returnUrl).toBe(`${APP_ORIGIN}/private`)
		expect((await services.repositories.sessions.getActiveSessionByHash(await hashToken(result.session)))?.parent_session_id).toBe(sessionId)
	})

	test('a cross-site answer is refused, and neither hands off nor signs out', async () => {
		const { harness, services, sessionToken, sessionId } = await scenario()
		for (const decision of ['continue', 'another']) {
			const response = await handleAuth(
				accountChoice(decision, { cookie: sessionToken, fetchSite: 'cross-site' }),
				services,
				AUTH_ENV,
				new TestContext(),
			)
			expect(response.status).toBe(403)
		}
		expect(issuedCodes(harness)).toBe(0)
		expect(await services.repositories.sessions.getActiveSessionById(sessionId)).not.toBeNull()
	})

	test('the posted handoff is read again: an unregistered return address is a 400 and mints nothing', async () => {
		const { harness, services, sessionToken } = await scenario()
		const response = await handleAuth(
			accountChoice('continue', { cookie: sessionToken, redirect: 'https://evil.test/' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
		expect(issuedCodes(harness)).toBe(0)
	})

	test('an unknown decision is a 400', async () => {
		const { harness, services, sessionToken } = await scenario()
		expect((await handleAuth(accountChoice('approve', { cookie: sessionToken }), services, AUTH_ENV, new TestContext())).status).toBe(400)
		expect(issuedCodes(harness)).toBe(0)
	})

	test('"continue" after the login ended returns to the sign-in page of the same handoff', async () => {
		const { harness, services, sessionToken } = await scenario()
		await services.repositories.sessions.revokeSessionByHash(await hashToken(sessionToken))
		expectSignIn(await handleAuth(accountChoice('continue', { cookie: sessionToken }), services, AUTH_ENV, new TestContext()))
		expect(issuedCodes(harness)).toBe(0)
	})

	test('"another" ends the login and every app session under it, and signs in afresh for the same handoff', async () => {
		const { harness, services, sessionToken, sessionId } = await scenario()
		const child = await exchangeAuthCode(services, {
			app: 'notes',
			code: await codeFor(services, sessionId),
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		if (!child.result.ok) throw new Error('exchange failed')
		const response = await handleAuth(accountChoice('another', { cookie: sessionToken }), services, AUTH_ENV, new TestContext())
		expectSignIn(response)
		expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0`)
		expect(await services.repositories.sessions.getActiveSessionById(sessionId)).toBeNull()
		expect(await services.repositories.sessions.getActiveSessionByHash(await hashToken(child.result.session))).toBeNull()
		const logout = harness.sqlite.query<{ kind: string; reason: string }, []>("SELECT kind, reason FROM auth_log WHERE kind = 'logout'").get()
		expect(logout).toEqual({ kind: 'logout', reason: 'logout' })
		// The sign-in page it lands on asks for a password: there is no login left to continue.
		const page = await handleAuth(new Request(response.headers.get('location') ?? ''), services, AUTH_ENV, new TestContext())
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('name="password"')
	})

	test('the question answers only POST', async () => {
		const { services } = await scenario()
		expect((await handleAuth(new Request(`${ISSUER}/auth/login/account`), services, AUTH_ENV, new TestContext())).status).toBe(405)
	})
})

describe('GET /auth/login as a handoff', () => {
	test('an EMPTY registry is a 400 naming the address, not a fallback (ADR-0023)', async () => {
		// This used to be the shared-cookie opt-out: an app with no registry "had not opted in" and the
		// browser took the ordinary login, which worked whenever IAM and the app shared a domain. With
		// one session-delivery mechanism there is nothing to fall back TO — the login would succeed and
		// land the browser on a host where it has no session, forever. So it is the same refusal as an
		// address that is simply not in a non-empty registry, and it names what nobody registered.
		const { services, sessionToken } = await scenario({ origins: [] })
		const response = await handleAuth(
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private`), {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
		expect(await response.text()).toContain(APP_ORIGIN)
	})

	test('an app named with NO return address at all is a 400 too', async () => {
		const { services, sessionToken } = await scenario()
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login?app=notes`, { headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` } }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
	})

	test('an unregistered return address is a 400, never a quiet fallback to the issuer', async () => {
		const { services, sessionToken } = await scenario()
		const response = await handleAuth(
			new Request(handoffLoginUrl('https://evil.test/'), {
				headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(400)
		// It names the address, which is the one thing an operator has to act on.
		expect(await response.text()).toContain('https://evil.test')
	})

	test('without a session the password form carries BOTH the app and its return address forward', async () => {
		const { services } = await scenario()
		const response = await handleAuth(
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private`)),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('name="app" value="notes"')
		// `safeRedirect` admits IAM's own origin only, which by construction excludes the app host.
		// Letting it rewrite this to the issuer strands the login on IAM — it did, live, and the form
		// looked perfectly fine.
		expect(html).toContain(`name="redirect" value="${APP_ORIGIN}/private"`)
	})

	test('the login page admits the handoff destination in form-action, and only it', async () => {
		// Chromium applies `form-action` to the REDIRECT a submission answers with, not only to the
		// action, so `'self'` alone blocks the 302 to `<app>/__fabrika/auth/callback` — the POST is
		// accepted, a code is issued and spent, and the browser silently stays on the login page.
		// Measured in Chromium 149. The widened origin is the REGISTERED one, never the caller's.
		const { services } = await scenario()
		const handoff = await handleAuth(
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private`)),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(handoff.headers.get('content-security-policy')).toContain(`form-action 'self' ${APP_ORIGIN};`)

		// A login that is not a handoff goes nowhere but IAM, and stays narrow.
		const plain = await handleAuth(new Request(`${ISSUER}/auth/login`), services, AUTH_ENV, new TestContext())
		expect(plain.headers.get('content-security-policy')).toContain(`form-action 'self';`)
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
				body: new URLSearchParams({
					email: 'human@contember.com',
					password,
					app: 'notes',
					redirect: `${APP_ORIGIN}/private`,
					[AUTH_HANDOFF_STATE_PARAM]: HANDOFF_STATE,
					[AUTH_HANDOFF_CHALLENGE_PARAM]: HANDOFF_CHALLENGE,
				}),
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
	interface AdminStack {
		harness: Harness
		/** The admin's own `px_session` — reused as an ordinary login in the end-to-end case below. */
		session: string
		adminId: string
		call(method: string, input: unknown): Promise<Response>
	}

	/** Drive the real admin RPC: an admin's console bearer, a registered app, and the shipped router. */
	async function adminStack(): Promise<AdminStack> {
		const harness = createHarness()
		const adminId = seedUser(harness.sqlite, { sub: 'sub-admin', email: 'admin@contember.com' })
		seedGrant(harness.sqlite, adminId, 'admin')
		seedAppAction(harness.sqlite, 'notes', 'note.read')
		const session = await harness.signSession(adminId, { email: 'admin@contember.com', idpSub: 'sub-admin' })
		const bearer = await harness.adminToken(adminId, { issuer: ISSUER })
		const env: Env = {
			DB: unusedDatabase,
			REPOSITORIES: harness.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			ISSUER: ISSUER,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: 'client',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		return {
			harness,
			session,
			adminId,
			call(method: string, input: unknown): Promise<Response> {
				return createIamApp().fetch(
					new Request(`${ISSUER}/admin/rpc`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
						body: JSON.stringify({ method, input }),
					}),
					env,
					{ waitUntil() {} },
				)
			},
		}
	}

	async function adminCall(input: unknown): Promise<Response> {
		return (await adminStack()).call('apps.setReturnOrigins', input)
	}

	/** The `origins` array off a `{ result: ReturnOriginsDto }` envelope, read structurally. */
	async function returnedOrigins(response: Response): Promise<unknown> {
		return prop(prop(await response.json(), 'result'), 'origins')
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

	test('every origin is CANONICALIZED before it is stored, and the answer states what was stored', async () => {
		// The function's stated purpose: an operator cannot register `https://App.Example.com/` and then
		// wonder why `https://app.example.com` is refused. `normalizeOrigin` is the one place that
		// decides what canonical means, and it must run on this side of the write.
		const stack = await adminStack()
		const response = await stack.call('apps.setReturnOrigins', {
			app: 'notes',
			origins: ['https://App.Test/some/path?q=1', 'HTTPS://Other.Test:443', 'http://dev.test:8080/'],
		})
		expect(response.status).toBe(200)
		const stored = ['https://app.test', 'https://other.test', 'http://dev.test:8080']
		expect(await returnedOrigins(response)).toEqual(stored)
		// `listReturnOrigins` orders by origin, so compare as sets rather than pinning an order twice.
		expect((await stack.harness.repositories.handoff.listReturnOrigins('notes')).slice().sort()).toEqual(stored.slice().sort())
	})

	test('duplicate SPELLINGS of one origin collapse to a single row', async () => {
		// Without the de-duplication these are three values that canonicalize to one, and the second
		// INSERT violates the (app, origin) primary key — a 500 for what is an obvious operator input.
		const stack = await adminStack()
		const response = await stack.call('apps.setReturnOrigins', {
			app: 'notes',
			origins: ['https://app.test', 'https://APP.test/', 'https://app.test:443/deep/path'],
		})
		expect(response.status).toBe(200)
		expect(await returnedOrigins(response)).toEqual(['https://app.test'])
		expect(await stack.harness.repositories.handoff.listReturnOrigins('notes')).toEqual(['https://app.test'])
	})

	test('a value that is not an absolute http(s) origin is a 400, and NOTHING is written', async () => {
		for (const bad of ['javascript:alert(1)', 'ftp://app.test', '/private', 'app.test', '', 'https://app.test;frame-src']) {
			const stack = await adminStack()
			// A valid origin first, so a partial write would be visible: the whole call must be refused.
			const response = await stack.call('apps.setReturnOrigins', { app: 'notes', origins: ['https://app.test', bad] })
			expect(`${bad}: ${response.status}`).toBe(`${bad}: 400`)
			expect(await stack.harness.repositories.handoff.listReturnOrigins('notes')).toEqual([])
		}
	})

	test('the change is audited, with the CANONICAL set an operator can compare against', async () => {
		const stack = await adminStack()
		expect((await stack.call('apps.setReturnOrigins', { app: 'notes', origins: ['https://App.Test/'] })).status).toBe(200)
		const [event] = await stack.harness.repositories.audit.listAuditEvents({ limit: 10, action: 'iam.app.return-origins.set' })
		expect(event?.resource_type).toBe('app')
		expect(event?.resource_id).toBe('notes')
		expect(event?.principal_id).toBe(stack.adminId)
		expect(event?.metadata).toBe(JSON.stringify({ origins: ['https://app.test'] }))
	})

	test('what the admin API stores and what a login validates against are canonicalized THE SAME WAY', async () => {
		// The two ends of one rule, pinned to each other: `setReturnOriginsUseCase` normalizes on the way
		// in and `resolveReturnUrl` normalizes on the way out. If either stopped, an operator would
		// register an origin through the console and every cross-host sign-in would still 400 — with the
		// registry looking perfectly correct in the admin UI.
		const stack = await adminStack()
		expect((await stack.call('apps.setReturnOrigins', { app: 'notes', origins: [`${APP_ORIGIN.toUpperCase()}/`] })).status).toBe(200)

		const services = stack.harness.makeServices({
			issuer: ISSUER,
			environment: 'stage',
			authentication: { oidc: true, password: true },
		})
		// The login was issued moments ago, so the handoff continues with no account question.
		const response = await handleAuth(
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private?page=2`), {
				headers: { Cookie: `${SESSION_COOKIE}=${stack.session}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.origin).toBe(APP_ORIGIN)
		expect(location.pathname).toBe(AUTH_CALLBACK_PATH)
		const code = location.searchParams.get('code')
		expect(code).toBeTruthy()

		// …and the destination stored with the code is the app's URL, not the registered origin alone.
		const { result } = await exchangeAuthCode(services, {
			app: 'notes',
			code: code ?? '',
			verifier: HANDOFF_VERIFIER,
			requestId: 'r1',
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.returnUrl).toBe(`${APP_ORIGIN}/private?page=2`)
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
		// OIDC off is the LOCAL configuration, and the bypass has to survive it — which is the whole
		// reason the bypass carries `local_dev` rather than passing as an OIDC login.
		const services = harness.makeServices({
			issuer: ISSUER,
			environment: 'local',
			localDevLogin,
			authentication: { oidc: false, password: true },
		})
		await services.repositories.handoff.setReturnOrigins('notes', [APP_ORIGIN])
		const principalId = seedUser(harness.sqlite, { email: 'dev@local.test', sub: LOCAL_DEV_ADMIN_ID })
		const token = await harness.signSession(principalId, {
			idpSub: LOCAL_DEV_ADMIN_ID,
			email: 'dev@local.test',
			authenticationMethod: 'local_dev',
		})
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
			new Request(handoffLoginUrl(`${APP_ORIGIN}/private`), {
				headers: { Cookie: `${SESSION_COOKIE}=${token}` },
			}),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		// The password form, not a 302 carrying a code.
		expect(response.status).toBe(200)
	})
})
