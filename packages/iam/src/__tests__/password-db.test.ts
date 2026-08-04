import { describe, expect, test } from 'bun:test'
import { principalStatus } from '../db'
import type { StoredPasswordHash } from '../password-crypto'
import { createHarness } from './helpers/harness'

const STORED: StoredPasswordHash = {
	algorithm: 'pbkdf2-sha256',
	parameters: '{"iterations":600000,"outputBytes":32}',
	salt: '00112233445566778899aabbccddeeff',
	passwordHash: '00'.repeat(32),
}

function future(seconds = 3600): number {
	return Math.floor(Date.now() / 1000) + seconds
}

describe('password persistence', () => {
	test('keeps explicit pending state when an enrollment token expires or is superseded', async () => {
		const h = createHarness()
		const principal = await h.repositories.principals.inviteUser('pending@example.com')
		expect(principalStatus(principal)).toBe('invited')

		await h.repositories.passwords.enableEnrollment(principal.id)
		await h.repositories.passwords.issueActionToken({
			principalId: principal.id,
			purpose: 'enrollment',
			tokenHash: 'old-token-hash',
			expiresAt: future(-1),
		})
		expect(await h.repositories.passwords.completeAction({ tokenHash: 'old-token-hash', purpose: 'enrollment', password: STORED })).toBeNull()
		expect((await h.repositories.passwords.getAccount(principal.id))?.state).toBe('pending')

		await h.repositories.passwords.issueActionToken({
			principalId: principal.id,
			purpose: 'enrollment',
			tokenHash: 'new-token-hash',
			expiresAt: future(),
		})
		expect((await h.repositories.passwords.getAccount(principal.id))?.state).toBe('pending')
	})

	test('completes an action once, activates the principal, and stores only verifier material', async () => {
		const h = createHarness()
		const principal = await h.repositories.principals.inviteUser('enroll@example.com')
		await h.repositories.passwords.enableEnrollment(principal.id)
		await h.repositories.passwords.issueActionToken({
			principalId: principal.id,
			purpose: 'enrollment',
			tokenHash: 'enrollment-hash',
			expiresAt: future(),
		})

		expect(await h.repositories.passwords.completeAction({ tokenHash: 'enrollment-hash', purpose: 'enrollment', password: STORED }))
			.toEqual({ principalId: principal.id })
		expect(
			await h.repositories.passwords.completeAction({
				tokenHash: 'enrollment-hash',
				purpose: 'enrollment',
				password: { ...STORED, passwordHash: 'ff' },
			}),
		)
			.toBeNull()
		expect((await h.repositories.passwords.getAccount(principal.id))?.state).toBe('enabled')
		expect((await h.repositories.passwords.getCredential(principal.id))?.password_hash).toBe(STORED.passwordHash)
		expect(principalStatus((await h.repositories.principals.getPrincipalById(principal.id))!)).toBe('active')
	})

	test('password replacement revokes password sessions and preserves OIDC sessions', async () => {
		const h = createHarness()
		const principal = await h.repositories.principals.createUser('oidc-sub', 'hybrid@example.com')
		await h.repositories.passwords.upsertCredential(principal.id, STORED)
		await h.repositories.sessions.createSession({
			tokenHash: 'password-session',
			principalId: principal.id,
			authenticationMethod: 'password',
			expiresAt: future(),
		})
		await h.repositories.sessions.createSession({
			tokenHash: 'oidc-session',
			principalId: principal.id,
			idpSub: 'oidc-sub',
			authenticationMethod: 'oidc',
			expiresAt: future(),
		})

		await h.repositories.passwords.upsertCredential(principal.id, { ...STORED, passwordHash: '11'.repeat(32) })
		expect(await h.repositories.sessions.getActiveSessionByHash('password-session')).toBeNull()
		expect(await h.repositories.sessions.getActiveSessionByHash('oidc-session')).not.toBeNull()
	})

	test('login lookup is case-insensitive and fails closed on case-variant duplicates', async () => {
		const h = createHarness()
		const first = await h.repositories.principals.createUser('sub-first', 'Alice@example.com')
		await h.repositories.passwords.upsertCredential(first.id, STORED)
		expect((await h.repositories.passwords.lookupLogin(' alice@EXAMPLE.com ')).status).toBe('found')

		const second = await h.repositories.principals.createUser('sub-second', 'alice@example.com')
		await h.repositories.passwords.upsertCredential(second.id, STORED)
		expect(await h.repositories.passwords.lookupLogin('ALICE@example.com')).toEqual({ status: 'ambiguous' })
	})

	test('records failures atomically at the threshold and clears them after success', async () => {
		const h = createHarness()
		const input = { loginKeyHash: 'email-hash', windowSeconds: 300, maxAttempts: 3, blockSeconds: 600 }
		expect((await h.repositories.passwords.recordLoginFailure(input)).attempt_count).toBe(1)
		expect((await h.repositories.passwords.recordLoginFailure(input)).attempt_count).toBe(2)
		const blocked = await h.repositories.passwords.recordLoginFailure(input)
		expect(blocked.attempt_count).toBe(3)
		expect(blocked.blocked_until).toBeGreaterThan(Math.floor(Date.now() / 1000))

		const stillBlocked = await h.repositories.passwords.recordLoginFailure(input)
		expect(stillBlocked.attempt_count).toBe(3)
		await h.repositories.passwords.clearLoginFailures(input.loginKeyHash)
		expect(await h.repositories.passwords.getLoginThrottle(input.loginKeyHash)).toBeNull()
	})

	test('prunes expired action tokens and stale throttle rows', async () => {
		const h = createHarness()
		const principal = await h.repositories.principals.inviteUser('cleanup@example.com')
		await h.repositories.passwords.enableEnrollment(principal.id)
		await h.repositories.passwords.issueActionToken({
			principalId: principal.id,
			purpose: 'enrollment',
			tokenHash: 'expired-action',
			expiresAt: 100,
		})
		await h.repositories.passwords.issueActionToken({
			principalId: principal.id,
			purpose: 'reset',
			tokenHash: 'current-action',
			expiresAt: 300,
		})
		await h.repositories.passwords.recordLoginFailure({
			loginKeyHash: 'stale-throttle',
			windowSeconds: 60,
			maxAttempts: 3,
			blockSeconds: 60,
		})
		h.sqlite.run("UPDATE password_login_throttles SET updated_at = 100, blocked_until = NULL WHERE login_key_hash = 'stale-throttle'")

		expect(await h.repositories.passwords.pruneActionTokens(200)).toBe(1)
		expect(await h.repositories.passwords.inspectActionToken('expired-action', 'enrollment')).toBeNull()
		expect((await h.repositories.passwords.getAccount(principal.id))?.state).toBe('pending')
		expect(await h.repositories.passwords.pruneLoginThrottles(200)).toBe(1)
		expect(await h.repositories.passwords.getLoginThrottle('stale-throttle')).toBeNull()
	})
})
