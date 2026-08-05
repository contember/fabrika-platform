import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair } from 'jose'
import { handleAuth } from '../auth/routes'
import type { RequestContext } from '../env'
import { OidcClient, type OidcIdentity, type OidcMetadata } from '../oidc'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ISSUER = 'http://localhost:18191'

function ctx(): RequestContext {
	return { waitUntil() {} }
}

/** Pull a single cookie's value out of a `Set-Cookie` header list. */
function setCookieValue(res: Response, name: string): string | null {
	for (const header of res.headers.getSetCookie()) {
		const eq = header.indexOf('=')
		if (header.slice(0, eq) === name) {
			return header.slice(eq + 1).split(';')[0] ?? null
		}
	}
	return null
}

const IDP_METADATA: OidcMetadata = {
	issuer: 'https://idp.test',
	authorizationEndpoint: 'https://idp.test/authorize',
	tokenEndpoint: 'https://idp.test/token',
	jwksUri: 'https://idp.test/jwks',
}

/** An OidcClient that skips the network: discovery injected, fixed identity from the exchange/verify. */
class FakeOidc extends OidcClient {
	constructor(private readonly identity: OidcIdentity | null) {
		super(
			{ issuer: 'https://idp.test', clientId: 'x', clientSecret: 'y', redirectUri: `${ISSUER}/auth/callback`, scopes: '', requireVerifiedEmail: true },
			{ metadata: IDP_METADATA },
		)
	}
	override async exchangeCode(): Promise<string | null> {
		return 'fake-id-token'
	}
	override async verifyIdToken(): Promise<OidcIdentity | null> {
		return this.identity
	}
}

describe('GET /.well-known/jwks.json', () => {
	test('serves the public key set', async () => {
		const h = createHarness()
		const res = await handleAuth(new Request(`${ISSUER}/.well-known/jwks.json`), h.makeServices(), AUTH_ENV, ctx())
		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		const keys = body && typeof body === 'object' && 'keys' in body ? body.keys : undefined
		expect(Array.isArray(keys) && keys.length).toBeGreaterThan(0)
	})
})

describe('GET /auth/login', () => {
	test('creates a real HOST-ONLY admin session when explicit local login is enabled', async () => {
		const h = createHarness()
		const issuer = 'http://iam.fabrika.localhost:18080'
		const services = h.makeServices({ issuer, bootstrapAdmins: new Set(['admin@local.test']), localDevLogin: true })
		const res = await handleAuth(
			new Request(`${issuer}/auth/login?redirect=${encodeURIComponent(`${issuer}/back`)}`),
			services,
			AUTH_ENV,
			ctx(),
		)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${issuer}/back`)
		const sessionToken = setCookieValue(res, SESSION_COOKIE)
		expect(sessionToken).toBeTruthy()
		// ADR-0023: the cookie belongs to IAM's host alone. `__Host-` is what a browser enforces that
		// with, and it refuses any cookie of this name carrying a `Domain`.
		expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true)
		expect(res.headers.getSetCookie().some((cookie) => cookie.includes('Domain='))).toBe(false)

		const principal = await h.repositories.principals.getUserByExternalId('local-dev-admin')
		expect(principal?.email).toBe('admin@local.test')
		const session = await h.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken ?? ''))
		expect(session?.principal_id).toBe(principal?.id)
	})

	test('a redirect to a SIBLING host is refused — only the registry may send a browser off IAM', async () => {
		const h = createHarness()
		const issuer = 'http://iam.fabrika.localhost:18080'
		const services = h.makeServices({ issuer, bootstrapAdmins: new Set(['admin@local.test']), localDevLogin: true })
		const res = await handleAuth(
			new Request(`${issuer}/auth/login?redirect=${encodeURIComponent('http://notes.fabrika.localhost:18081/')}`),
			services,
			AUTH_ENV,
			ctx(),
		)
		// It used to be admitted, because the shared cookie could reach it. Now the browser would land
		// there with no session at all, so it goes nowhere but IAM — a `?app=` handoff is the only way.
		expect(res.headers.get('location')).toBe(issuer)
	})

	test('302s to the IdP with PKCE and sets the in-flight cookie', async () => {
		const h = createHarness()
		const res = await handleAuth(
			new Request(`${ISSUER}/auth/login?redirect=${encodeURIComponent(`${ISSUER}/back`)}`),
			h.makeServices({ issuer: ISSUER }),
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(302)
		const location = new URL(res.headers.get('location') ?? '')
		expect(location.hostname).toBe('idp.test')
		expect(location.searchParams.get('code_challenge_method')).toBe('S256')
		expect(setCookieValue(res, 'px_oidc')).toBeTruthy()
	})

	test('rejects an open-redirect target, falling back to the issuer', async () => {
		const h = createHarness()
		const res = await handleAuth(
			new Request(`${ISSUER}/auth/login?redirect=${encodeURIComponent('https://evil.example/x')}`),
			h.makeServices({ issuer: ISSUER }),
			AUTH_ENV,
			ctx(),
		)
		// The bad redirect is dropped; login still proceeds (the redirect is only used post-callback).
		expect(res.status).toBe(302)
		expect(new URL(res.headers.get('location') ?? '').hostname).toBe('idp.test')
	})
})

describe('login → callback (end to end with a fake IdP)', () => {
	test('creates a session, sets px_session, and 302s back to the original target', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, oidc: new FakeOidc({ sub: 'g-42', email: 'user@contember.com' }) })

		// 1. Login: capture the state (from the IdP URL) and the in-flight cookie.
		const login = await handleAuth(
			new Request(`${ISSUER}/auth/login?redirect=${encodeURIComponent(`${ISSUER}/back`)}`),
			services,
			AUTH_ENV,
			ctx(),
		)
		const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
		const flightCookie = setCookieValue(login, 'px_oidc')
		expect(state && flightCookie).toBeTruthy()

		// 2. Callback: the IdP bounces back with code + matching state; the in-flight cookie is replayed.
		const callback = await handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=${state}`, {
				headers: { Cookie: `px_oidc=${flightCookie}` },
			}),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(callback.status).toBe(302)
		expect(callback.headers.get('location')).toBe(`${ISSUER}/back`)
		// The response carrying a 30-day session cookie must never be cached; so must the 302 that
		// started the detour. The password pages always said so and these did not.
		expect(callback.headers.get('cache-control')).toBe('no-store')
		expect(login.headers.get('cache-control')).toBe('no-store')

		// A session cookie was issued and a session row created for the lazily-created principal.
		const sessionToken = setCookieValue(callback, SESSION_COOKIE)
		expect(sessionToken).toBeTruthy()
		const principal = await h.repositories.principals.getUserByExternalId('g-42')
		expect(principal?.email).toBe('user@contember.com')
		const session = await h.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken ?? ''))
		expect(session?.principal_id).toBe(principal?.id)
	})

	/** Whether a response spends the in-flight cookie (Max-Age=0), which every terminal outcome must. */
	function clearsFlight(res: Response): boolean {
		return res.headers.getSetCookie().some((c) => c.startsWith('px_oidc=') && c.includes('Max-Age=0'))
	}

	test('a mismatched state is rejected (CSRF guard) and the flight is spent', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, oidc: new FakeOidc({ sub: 'g', email: 'a@b.cz' }) })
		const login = await handleAuth(new Request(`${ISSUER}/auth/login`), services, AUTH_ENV, ctx())
		const flightCookie = setCookieValue(login, 'px_oidc')
		const res = await handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=WRONG`, { headers: { Cookie: `px_oidc=${flightCookie}` } }),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(400)
		// The cookie carries a live PKCE verifier: leaving it behind kept it replayable for 600s.
		expect(clearsFlight(res)).toBe(true)
	})

	test('a refused identity (unverified email → null) yields 401 and spends the flight', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, oidc: new FakeOidc(null) })
		const login = await handleAuth(new Request(`${ISSUER}/auth/login`), services, AUTH_ENV, ctx())
		const flightCookie = setCookieValue(login, 'px_oidc')
		const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
		const res = await handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=${state}`, { headers: { Cookie: `px_oidc=${flightCookie}` } }),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(401)
		expect(clearsFlight(res)).toBe(true)
	})

	test('a flight nobody signed is refused, however well its state matches', async () => {
		// The cookie used to be plain base64 JSON, and the only CSRF check was `flight.state === state`
		// — an attacker-written cookie against an attacker-written query parameter. `Path=/auth` is no
		// isolation either: a sibling host under a shared registrable domain can toss in a SECOND
		// px_oidc that the browser sends first, so a planted flight bought the victim a session for
		// the ATTACKER'S identity.
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, oidc: new FakeOidc({ sub: 'attacker', email: 'attacker@contember.com' }) })
		const forged = btoa(JSON.stringify({ state: 'S', verifier: 'V', redirect: ISSUER })).replaceAll('=', '')

		const res = await handleAuth(
			new Request(`${ISSUER}/auth/callback?code=attacker-code&state=S`, { headers: { Cookie: `px_oidc=${forged}` } }),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(400)
		expect(setCookieValue(res, SESSION_COOKIE)).toBeNull()
		expect(await h.repositories.principals.getUserByExternalId('attacker')).toBeNull()
	})

	test('a flight signed by a DIFFERENT installation is refused', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, oidc: new FakeOidc({ sub: 'g-9', email: 'user@contember.com' }) })
		// The flight is minted under another deployment's key and replayed against ours.
		const { privateKey } = await generateKeyPair('ES256', { extractable: true })
		const otherEnv = { FABRIKA_IAM_SIGNING_KEYS: JSON.stringify([await exportJWK(privateKey)]), ENVIRONMENT: 'local' }
		const login = await handleAuth(new Request(`${ISSUER}/auth/login`), services, otherEnv, ctx())
		const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')

		const res = await handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=${state}`, {
				headers: { Cookie: `px_oidc=${setCookieValue(login, 'px_oidc')}` },
			}),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(400)
	})
})

describe('login admission (/auth/callback allowlist)', () => {
	// Drive a full login → callback for the given services + identity, returning the callback response.
	async function login(services: ReturnType<Harness['makeServices']>, identity: OidcIdentity): Promise<Response> {
		const withOidc = { ...services, oidc: new FakeOidc(identity) }
		const loginRes = await handleAuth(new Request(`${ISSUER}/auth/login`), withOidc, AUTH_ENV, ctx())
		const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state')
		const flightCookie = setCookieValue(loginRes, 'px_oidc')
		return handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=${state}`, { headers: { Cookie: `px_oidc=${flightCookie}` } }),
			withOidc,
			AUTH_ENV,
			ctx(),
		)
	}

	test('a new identity outside the allowlist is refused (403), no principal created', async () => {
		const h = createHarness()
		// Default allowlist admits only @contember.com.
		const services = h.makeServices({ issuer: ISSUER })
		const res = await login(services, { sub: 'out-1', email: 'stranger@evil.example' })
		expect(res.status).toBe(403)
		expect(await h.repositories.principals.getUserByExternalId('out-1')).toBeNull()
	})

	test('a matching email domain admits a new identity (302 + session)', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const res = await login(services, { sub: 'in-1', email: 'new@contember.com' })
		expect(res.status).toBe(302)
		expect(setCookieValue(res, SESSION_COOKIE)).toBeTruthy()
	})

	test('an exact email on the allowlist admits a new identity', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, human: { emailDomains: [], emails: ['vip@evil.example'] } })
		const res = await login(services, { sub: 'vip-1', email: 'vip@evil.example' })
		expect(res.status).toBe(302)
	})

	test('a `*` wildcard admits anyone (allow-all)', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, human: { emailDomains: ['*'], emails: [] } })
		const res = await login(services, { sub: 'any-1', email: 'whoever@anywhere.example' })
		expect(res.status).toBe(302)
	})

	test('a bootstrap admin is always admitted, even outside the allowlist', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, bootstrapAdmins: new Set(['boss@evil.example']) })
		const res = await login(services, { sub: 'boss-1', email: 'boss@evil.example' })
		expect(res.status).toBe(302)
	})

	test('an already-invited principal is admitted despite an allowlist miss', async () => {
		const h = createHarness()
		// An invited row (external_id NULL) with a non-allowlisted email — claimed on first login.
		seedUser(h.sqlite, { sub: null, email: 'invited@evil.example' })
		const services = h.makeServices({ issuer: ISSUER })
		const res = await login(services, { sub: 'inv-1', email: 'invited@evil.example' })
		expect(res.status).toBe(302)
		// The invite was claimed by the IdP sub.
		expect((await h.repositories.principals.getUserByExternalId('inv-1'))?.email).toBe('invited@evil.example')
	})

	test('a mixed-case allowlist entry matches — it is a control, not decoration', async () => {
		// Entra and Okta both preserve directory casing, so `emails.includes(email)` silently never
		// matched an entry an operator typed the way their directory spells it.
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, human: { emailDomains: [], emails: ['VIP@Evil.Example'] } })
		expect((await login(services, { sub: 'vip-2', email: 'vip@evil.example' })).status).toBe(302)
	})
})

// ── One mailbox rule (CORR-1) ────────────────────────────────────────────────
//
// The password path normalized and the OIDC path did not, so an ordinary invite — `Bob@Example.com`
// typed by an admin, `bob@example.com` returned by the IdP — produced a SECOND principal. The invite
// and every grant on it went dead, and password sign-in stayed ambiguous forever after.

describe('email identity is the mailbox, not its spelling', () => {
	async function oidcLogin(services: ReturnType<Harness['makeServices']>, identity: OidcIdentity): Promise<Response> {
		const withOidc = { ...services, oidc: new FakeOidc(identity) }
		const loginRes = await handleAuth(new Request(`${ISSUER}/auth/login`), withOidc, AUTH_ENV, ctx())
		const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state')
		return handleAuth(
			new Request(`${ISSUER}/auth/callback?code=abc&state=${state}`, {
				headers: { Cookie: `px_oidc=${setCookieValue(loginRes, 'px_oidc')}` },
			}),
			withOidc,
			AUTH_ENV,
			ctx(),
		)
	}

	test('an OIDC login differing only in case claims the invite instead of creating a second principal', async () => {
		const h = createHarness()
		const invited = await h.repositories.principals.inviteUser('Bob@Example.com')
		expect(invited.email).toBe('bob@example.com')
		expect(invited.label).toBe('Bob@Example.com')

		const services = h.makeServices({ issuer: ISSUER })
		expect((await oidcLogin(services, { sub: 'bob-1', email: 'bob@example.com' })).status).toBe(302)

		const claimed = await h.repositories.principals.getUserByExternalId('bob-1')
		expect(claimed?.id).toBe(invited.id)
		expect((await h.repositories.principals.listPrincipals({ type: 'user', limit: 50 })).length).toBe(1)
	})

	test('an invited-but-disabled principal with different casing is refused, not re-created', async () => {
		const h = createHarness()
		const invited = await h.repositories.principals.inviteUser('bob@example.com')
		await h.repositories.principals.disablePrincipal(invited.id)

		const services = h.makeServices({ issuer: ISSUER, human: { emailDomains: ['*'], emails: [] } })
		expect((await oidcLogin(services, { sub: 'bob-2', email: 'BOB@Example.com' })).status).toBe(403)
		expect(await h.repositories.principals.getUserByExternalId('bob-2')).toBeNull()
		expect((await h.repositories.principals.listPrincipals({ type: 'user', limit: 50 })).length).toBe(1)
	})

	test('the always-admit-a-known-principal fallback finds the invite whatever the IdP spells', async () => {
		const h = createHarness()
		// Not on the allowlist: admission depends entirely on the invited row being FOUND.
		await h.repositories.principals.inviteUser('Invited@Evil.Example')
		const services = h.makeServices({ issuer: ISSUER })
		expect((await oidcLogin(services, { sub: 'inv-2', email: 'invited@evil.example' })).status).toBe(302)
	})
})

describe('/auth/logout', () => {
	async function liveLogin(): Promise<{ h: Harness; sessionToken: string }> {
		const h = createHarness()
		const principalId = seedUser(h.sqlite, { sub: 'g-7', email: 'l@o.cz' })
		const sessionToken = 'live-session'
		await h.repositories.sessions.createSession({
			tokenHash: await hashToken(sessionToken),
			principalId,
			idpSub: 'g-7',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		return { h, sessionToken }
	}

	function logout(sessionToken: string, init: RequestInit = {}): Request {
		return new Request(`${ISSUER}/auth/logout`, {
			...init,
			headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}`, ...(init.headers ?? {}) },
		})
	}

	test('a same-origin POST revokes the session and clears the cookie', async () => {
		const { h, sessionToken } = await liveLogin()
		const res = await handleAuth(
			logout(sessionToken, { method: 'POST', headers: { Origin: ISSUER, 'Sec-Fetch-Site': 'same-origin' } }),
			h.makeServices({ issuer: ISSUER }),
			AUTH_ENV,
			ctx(),
		)
		expect(res.status).toBe(302)
		// Cookie cleared (Max-Age=0) and the session no longer resolves.
		expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.includes('Max-Age=0'))).toBe(true)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken))).toBeNull()
	})

	test('a cross-site navigation cannot log anyone out', async () => {
		// `px_session` is SameSite=Lax, so a top-level GET from any page carried it — and because every
		// app session hangs off this one, that single request signed the human out everywhere.
		const { h, sessionToken } = await liveLogin()
		const services = h.makeServices({ issuer: ISSUER })

		const navigation = await handleAuth(logout(sessionToken, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), services, AUTH_ENV, ctx())
		expect(navigation.status).toBe(200)
		expect(navigation.headers.getSetCookie()).toEqual([])

		const forgedPost = await handleAuth(
			logout(sessionToken, { method: 'POST', headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } }),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(forgedPost.status).toBe(403)
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken))).not.toBeNull()
	})

	test('GET renders the same-origin form that posts', async () => {
		const { h, sessionToken } = await liveLogin()
		const res = await handleAuth(logout(sessionToken), h.makeServices({ issuer: ISSUER }), AUTH_ENV, ctx())
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('<form method="post" action="/auth/logout')
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(sessionToken))).not.toBeNull()
	})

	test('any other method is a 405', async () => {
		const { h, sessionToken } = await liveLogin()
		const res = await handleAuth(logout(sessionToken, { method: 'DELETE' }), h.makeServices({ issuer: ISSUER }), AUTH_ENV, ctx())
		expect(res.status).toBe(405)
	})
})

describe('every auth cookie is Secure, on every transport', () => {
	// `__Host-` requires `Secure`, so the flag stopped being a decision: without it the browser refuses
	// the cookie whatever the socket said. Which is also why it can no longer be derived from the
	// issuer — Zerops' L7 balancer terminates TLS and forwards plain HTTP, so the socket was always the
	// wrong signal, and the issuer was only ever a proxy for "the browser spoke HTTPS".
	const secureFlags = (res: Response): boolean[] => res.headers.getSetCookie().map((header) => /;\s*Secure(;|$)/i.test(header))

	test('an https ISSUER on a plain-HTTP request (a TLS-terminating balancer)', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: 'https://iam.example.com' })
		const res = await handleAuth(new Request('http://iam:3000/auth/login'), services, AUTH_ENV, ctx())
		expect(res.status).toBe(302)
		expect(secureFlags(res)).toEqual([true])
	})

	test('an http ISSUER on a plain-HTTP request — the local stack, where *.localhost is trustworthy', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const res = await handleAuth(new Request(`${ISSUER}/auth/login`), services, AUTH_ENV, ctx())
		expect(secureFlags(res)).toEqual([true])
	})

	test('an https request', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: 'https://iam.example.com' })
		const res = await handleAuth(
			new Request('https://iam.example.com/auth/logout', {
				method: 'POST',
				headers: { Origin: 'https://iam.example.com', 'Sec-Fetch-Site': 'same-origin' },
			}),
			services,
			AUTH_ENV,
			ctx(),
		)
		expect(secureFlags(res)).toEqual([true])
	})
})
