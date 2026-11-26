import { REVOCATION_FEED_WINDOW_SECONDS } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { hashToken } from '../secret'
import { createHarness, seedUser } from './helpers/harness'

const FUTURE = Math.floor(Date.now() / 1000) + 3600
const PAST = Math.floor(Date.now() / 1000) - 3600

describe('sessions db', () => {
	test('create → look up an active session by the cookie hash', async () => {
		const h = createHarness()
		const principal = seedUser(h.sqlite, { sub: 'g-1', email: 'a@b.cz' })
		const hash = await hashToken('session-cookie-value')

		const id = await h.repositories.sessions.createSession({
			tokenHash: hash,
			principalId: principal,
			idpSub: 'g-1',
			email: 'a@b.cz',
			expiresAt: FUTURE,
		})
		expect(id).toBeTruthy()

		const row = await h.repositories.sessions.getActiveSessionByHash(hash)
		expect(row?.principal_id).toBe(principal)
		expect(row?.idp_sub).toBe('g-1')
		expect(row?.email).toBe('a@b.cz')
	})

	test('an expired session does not resolve', async () => {
		const h = createHarness()
		const principal = seedUser(h.sqlite, { sub: 'g-2', email: 'c@d.cz' })
		const hash = await hashToken('expired')
		await h.repositories.sessions.createSession({ tokenHash: hash, principalId: principal, idpSub: 'g-2', expiresAt: PAST })
		expect(await h.repositories.sessions.getActiveSessionByHash(hash)).toBeNull()
	})

	test('revoke makes the session stop resolving (idempotent)', async () => {
		const h = createHarness()
		const principal = seedUser(h.sqlite, { sub: 'g-3', email: 'e@f.cz' })
		const hash = await hashToken('to-revoke')
		await h.repositories.sessions.createSession({ tokenHash: hash, principalId: principal, idpSub: 'g-3', expiresAt: FUTURE })

		expect(await h.repositories.sessions.revokeSessionByHash(hash)).toBe(true)
		expect(await h.repositories.sessions.getActiveSessionByHash(hash)).toBeNull()
		// Second revoke is a no-op.
		expect(await h.repositories.sessions.revokeSessionByHash(hash)).toBe(false)
	})

	test('an unknown hash resolves to null', async () => {
		const h = createHarness()
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken('nope'))).toBeNull()
	})

	test('list sessions for a principal, newest first', async () => {
		const h = createHarness()
		const principal = seedUser(h.sqlite, { sub: 'g-4', email: 'g@h.cz' })
		await h.repositories.sessions.createSession({ tokenHash: await hashToken('s1'), principalId: principal, idpSub: 'g-4', expiresAt: FUTURE })
		await h.repositories.sessions.createSession({ tokenHash: await hashToken('s2'), principalId: principal, idpSub: 'g-4', expiresAt: FUTURE })
		expect((await h.repositories.sessions.listSessionsForPrincipal(principal, { limit: 50 })).length).toBe(2)
	})

	test('prune removes expired sessions and those revoked a token lifetime ago, and keeps one the revocation feed still reads', async () => {
		const h = createHarness()
		const principal = seedUser(h.sqlite, { sub: 'g-5', email: 'i@j.cz' })
		await h.repositories.sessions.createSession({ tokenHash: await hashToken('live'), principalId: principal, idpSub: 'g-5', expiresAt: FUTURE })
		await h.repositories.sessions.createSession({ tokenHash: await hashToken('dead'), principalId: principal, idpSub: 'g-5', expiresAt: PAST })
		const revokedHash = await hashToken('killed')
		await h.repositories.sessions.createSession({ tokenHash: revokedHash, principalId: principal, idpSub: 'g-5', expiresAt: FUTURE })
		await h.repositories.sessions.revokeSessionByHash(revokedHash)
		const justRevokedHash = await hashToken('just-killed')
		await h.repositories.sessions.createSession({ tokenHash: justRevokedHash, principalId: principal, idpSub: 'g-5', expiresAt: FUTURE })
		await h.repositories.sessions.revokeSessionByHash(justRevokedHash)
		const now = Math.floor(Date.now() / 1000)
		h.sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(now - REVOCATION_FEED_WINDOW_SECONDS - 1, revokedHash)

		const removed = await h.repositories.sessions.pruneSessions(now)
		expect(removed).toBe(2)
		expect((await h.repositories.sessions.listSessionsForPrincipal(principal, { limit: 50 })).length).toBe(2)
		expect((await h.repositories.revocations.since(now - 60, 10)).map((row) => row.subject)).toEqual([principal])
	})
})
