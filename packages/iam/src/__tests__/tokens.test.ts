import { DEFAULT_TOKEN_TTL_SECONDS, parseAccessClaims, permits } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { mintFromKey, mintToken } from '../tokens'
import { createHarness, seedInlineGrant, seedUser } from './helpers/harness'

const ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const FUTURE = Math.floor(Date.now() / 1000) + 3600

/** Stand up a user + session + grant, returning what mint needs. */
async function setup(action = 'project.read', app = 'example-app') {
	const h = createHarness()
	const principalId = seedUser(h.sqlite, { sub: 'g-1', email: 'a@b.cz' })
	seedInlineGrant(h.sqlite, principalId, [action], null, app)
	const sessionToken = 'sess-cookie-value'
	await h.repositories.sessions.createSession({
		tokenHash: await hashToken(sessionToken),
		principalId,
		idpSub: 'g-1',
		email: 'a@b.cz',
		expiresAt: FUTURE,
	})
	return { h, principalId, sessionToken }
}

describe('mintToken', () => {
	test('mints a per-app token carrying the resolved permissions; the JWKS verifies it', async () => {
		const { h, principalId, sessionToken } = await setup()
		const services = h.makeServices({ issuer: 'https://propustka.test' })

		const { result, principalId: loggedId } = await mintToken(services, ENV, { app: 'example-app', session: sessionToken, requestId: 'r1' })
		expect(result.ok).toBe(true)
		expect(loggedId).toBe(principalId)
		if (!result.ok) {
			throw new Error('expected ok')
		}

		// Verify EXACTLY as the SDK will: local JWKS from the issuer's published keys, checking aud.
		const signer = await getSigner(ENV)
		const { payload } = await jwtVerify(result.token, createLocalJWKSet(signer.jwks()), {
			issuer: 'https://propustka.test',
			audience: 'example-app',
		})
		const claims = parseAccessClaims(payload)
		expect(claims?.ptype).toBe('user')
		if (!claims) {
			throw new Error('expected access claims')
		}
		expect(claims.sub).toBe(principalId)
		// The granted action is authorized by the same matcher the SDK's can() uses.
		expect(permits(claims.perms, 'project.read')).toBe(true)
		expect(permits(claims.perms, 'project.delete')).toBe(false)
	})

	test('resolves permissions PER APP — a grant on another app does not leak', async () => {
		const { h, sessionToken } = await setup('project.read', 'app-a')
		const services = h.makeServices({ issuer: 'https://propustka.test' })
		const { result } = await mintToken(services, ENV, { app: 'app-b', session: sessionToken, requestId: 'r' })
		expect(result.ok).toBe(true)
		if (!result.ok) {
			throw new Error('expected ok')
		}
		const claims = parseAccessClaims(
			(await jwtVerify(result.token, createLocalJWKSet((await getSigner(ENV)).jwks()), { issuer: 'https://propustka.test', audience: 'app-b' })).payload,
		)
		expect(claims?.perms).toEqual([])
	})

	test('the token never outlives the SESSION it was minted from', async () => {
		// A session with 90 seconds left must not mint a token that lives the full TTL: logging out or
		// letting a session expire would leave a valid token in the app's hands for the remainder (SEC-27).
		const h = createHarness()
		const principalId = seedUser(h.sqlite, { sub: 'g-clamp', email: 'clamp@b.cz' })
		const sessionToken = 'about-to-expire'
		const expiresAt = Math.floor(Date.now() / 1000) + 90
		await h.repositories.sessions.createSession({
			tokenHash: await hashToken(sessionToken),
			principalId,
			idpSub: 'g-clamp',
			email: 'clamp@b.cz',
			expiresAt,
		})
		const { result } = await mintToken(h.makeServices(), ENV, { app: 'a', session: sessionToken, requestId: 'r' })
		if (!result.ok) throw new Error('expected ok')
		expect(result.expiresAt).toBe(expiresAt)

		// A long-lived session still gets the ordinary TTL, so the clamp is a bound and not a rewrite.
		const longLived = 'plenty-of-time-left'
		await h.repositories.sessions.createSession({
			tokenHash: await hashToken(longLived),
			principalId,
			idpSub: 'g-clamp',
			email: 'clamp@b.cz',
			expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
		})
		const long = await mintToken(h.makeServices(), ENV, { app: 'a', session: longLived, requestId: 'r' })
		if (!long.result.ok) throw new Error('expected ok')
		expect(long.result.expiresAt).toBe(Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS)
	})

	test('no session → no_session', async () => {
		const h = createHarness()
		const { result } = await mintToken(h.makeServices(), ENV, { app: 'a', session: null, requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'no_session' })
	})

	test('unknown/expired session → invalid_session', async () => {
		const h = createHarness()
		const { result } = await mintToken(h.makeServices(), ENV, { app: 'a', session: 'never-issued', requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	test('disabled principal → disabled', async () => {
		const h = createHarness()
		const principalId = seedUser(h.sqlite, { sub: 'g-9', email: 'z@b.cz', disabled: true })
		const sessionToken = 'disabled-sess'
		await h.repositories.sessions.createSession({ tokenHash: await hashToken(sessionToken), principalId, idpSub: 'g-9', expiresAt: FUTURE })
		const { result, principalId: loggedId } = await mintToken(h.makeServices(), ENV, { app: 'a', session: sessionToken, requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'disabled' })
		expect(loggedId).toBe(principalId)
	})
})

describe('mintFromKey', () => {
	/**
	 * The per-app isolation assertion `mintToken` has had since day one, for the OTHER mint front. Its
	 * absence is why an anonymous `px_` credential stayed unbound to an app for so long: delegation at
	 * issue time is app-scoped, so authority granted at one app was spendable at every other one behind
	 * the proxy (SEC-2). Mirrors `mintToken`'s "resolves permissions PER APP" test.
	 */
	async function shareLink(app: string | null, action = 'report.read') {
		const h = createHarness()
		const issuer = seedUser(h.sqlite, { sub: 'g-issuer', email: 'issuer@b.cz' })
		const key = `px_link-for-${app ?? 'nowhere'}`
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			issuedBy: issuer,
			...(app === null ? {} : { app }),
			grants: [{ action }],
		})
		return { h, key }
	}

	test('an anonymous key mints ONLY for the app it was issued for', async () => {
		const { h, key } = await shareLink('app-a')
		const services = h.makeServices({ issuer: 'https://propustka.test' })

		const mine = await mintFromKey(services, ENV, { app: 'app-a', key, requestId: 'r' })
		expect(mine.result.ok).toBe(true)
		if (!mine.result.ok) throw new Error('expected ok')
		const claims = parseAccessClaims(
			(await jwtVerify(mine.result.token, createLocalJWKSet((await getSigner(ENV)).jwks()), {
				issuer: 'https://propustka.test',
				audience: 'app-a',
			})).payload,
		)
		expect(permits(claims?.perms ?? [], 'report.read')).toBe(true)

		// Another app: refused outright, and reported as `invalid_key` so the holder learns nothing about
		// whether the credential exists.
		const elsewhere = await mintFromKey(services, ENV, { app: 'app-b', key, requestId: 'r' })
		expect(elsewhere.result).toEqual({ ok: false, reason: 'invalid_key' })
	})

	test('an anonymous key with NO app is dead everywhere — the hard cutover', async () => {
		const { h, key } = await shareLink(null)
		const services = h.makeServices({ issuer: 'https://propustka.test' })
		for (const app of ['app-a', 'app-b']) {
			expect((await mintFromKey(services, ENV, { app, key, requestId: 'r' })).result).toEqual({ ok: false, reason: 'invalid_key' })
		}
	})

	test('a principal-bound key with no app is CROSS-APP, and still resolves per app through its grants', async () => {
		// The other half of the rule: a bound credential carries no frozen authority, so a null app is a
		// real choice rather than an omission — its permissions come from `grants`, which are app-filtered.
		const h = createHarness()
		const principalId = seedUser(h.sqlite, { sub: 'g-bound', email: 'bound@b.cz' })
		seedInlineGrant(h.sqlite, principalId, ['project.read'], null, 'app-a')
		const key = 'px_cross-app-personal-key'
		await h.repositories.credentials.createCredential({ tokenHash: await hashToken(key), principalId, issuedBy: principalId, grants: [] })
		const services = h.makeServices({ issuer: 'https://propustka.test' })

		const atA = await mintFromKey(services, ENV, { app: 'app-a', key, requestId: 'r' })
		expect(atA.result.ok).toBe(true)
		const atB = await mintFromKey(services, ENV, { app: 'app-b', key, requestId: 'r' })
		expect(atB.result.ok).toBe(true)
		if (!atB.result.ok) throw new Error('expected ok')
		const claims = parseAccessClaims(
			(await jwtVerify(atB.result.token, createLocalJWKSet((await getSigner(ENV)).jwks()), {
				issuer: 'https://propustka.test',
				audience: 'app-b',
			})).payload,
		)
		// It mints, but it carries nothing: the grant belongs to app-a.
		expect(claims?.perms).toEqual([])
	})
})
