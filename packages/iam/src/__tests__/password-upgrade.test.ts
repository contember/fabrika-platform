/**
 * The password parameter-UPGRADE path (TEST-8).
 *
 * `password-crypto.test.ts` only ever asserted `needsRehash: false`, so the whole upgrade branch — the
 * thing that lets an installation raise its PBKDF2 cost without asking anyone to change a password —
 * was never observed working. Two layers here:
 *
 *   1. `verify` returns `{ valid: true, needsRehash: true }` for a verifier stored with weaker
 *      parameters or a short salt, and still verifies it correctly.
 *   2. A real login against such a verifier SUCCEEDS, rewrites the stored material with the current
 *      parameters, and — because replacing derived material revokes password sessions — logs the user
 *      out of their other password sessions while leaving an OIDC session alone.
 */

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import type { RequestContext } from '../env'
import { PBKDF2_SHA256_ALGORITHM, PBKDF2_SHA256_ITERATIONS, PBKDF2_SHA256_OUTPUT_BYTES, WebCryptoPasswordHasher } from '../password-crypto'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const ISSUER = 'http://localhost:18191'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const PASSWORD = 'a perfectly reasonable long password'

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
	async drain(): Promise<void> {
		await Promise.all(this.pending)
	}
}

/** Derive a verifier with DELIBERATELY legacy parameters, the way an older release would have. */
async function legacyVerifier(password: string, options: { iterations?: number; saltBytes?: number } = {}) {
	const iterations = options.iterations ?? 1_000
	const saltBytes = options.saltBytes ?? 16
	const salt = crypto.getRandomValues(new Uint8Array(saltBytes))
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		PBKDF2_SHA256_OUTPUT_BYTES * 8,
	)
	const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
	return {
		algorithm: PBKDF2_SHA256_ALGORITHM,
		parameters: JSON.stringify({ iterations, outputBytes: PBKDF2_SHA256_OUTPUT_BYTES }),
		salt: hex(salt),
		passwordHash: hex(new Uint8Array(bits)),
	}
}

describe('WebCryptoPasswordHasher — the upgrade path', () => {
	test('fewer iterations verify correctly and ask for a rehash', async () => {
		const hasher = new WebCryptoPasswordHasher()
		const stored = await legacyVerifier(PASSWORD, { iterations: 1_000 })

		expect(await hasher.verify(PASSWORD, stored)).toEqual({ valid: true, needsRehash: true })
		// A WRONG password against a legacy verifier is invalid and asks for nothing — a rehash request
		// must never be a side channel that says "this verifier is old" to someone who cannot log in.
		expect(await hasher.verify('wrong password entirely', stored)).toEqual({ valid: false, needsRehash: false })
	})

	test('a SHORT salt verifies correctly and asks for a rehash', async () => {
		const hasher = new WebCryptoPasswordHasher()
		const stored = await legacyVerifier(PASSWORD, { iterations: PBKDF2_SHA256_ITERATIONS, saltBytes: 8 })

		expect(await hasher.verify(PASSWORD, stored)).toEqual({ valid: true, needsRehash: true })
	})

	test('a verifier written by the CURRENT hasher asks for nothing', async () => {
		const hasher = new WebCryptoPasswordHasher()
		expect(await hasher.verify(PASSWORD, await hasher.hash(PASSWORD))).toEqual({ valid: true, needsRehash: false })
	})
})

describe('a login against a legacy verifier upgrades it in place', () => {
	async function setup(): Promise<{ h: Harness; principal: string; services: ReturnType<Harness['makeServices']> }> {
		const h = createHarness()
		const services = h.makeServices({
			issuer: ISSUER,
			authentication: { oidc: true, password: true },
			passwordHasher: new WebCryptoPasswordHasher(),
		})
		const principal = seedUser(h.sqlite, { sub: 'sub-upgrade', email: 'upgrade@example.test' })
		// 1_000 iterations rather than the shipped 600_000, so the test derives twice in milliseconds.
		await h.repositories.passwords.upsertCredential(principal, await legacyVerifier(PASSWORD, { iterations: 1_000 }))
		return { h, principal, services }
	}

	test('login succeeds, the stored parameters become current, and only password sessions are revoked', async () => {
		const { h, principal, services } = await setup()

		// Two sessions that already exist: one from a password login, one from OIDC. Replacing derived
		// material revokes the FIRST kind and must leave the second alone — the rule is "the password
		// changed", not "this human is untrusted".
		const passwordSession = await hashToken('existing-password-session')
		await h.repositories.sessions.createSession({
			tokenHash: passwordSession,
			principalId: principal,
			authenticationMethod: 'password',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		const oidcSession = await hashToken('existing-oidc-session')
		await h.repositories.sessions.createSession({
			tokenHash: oidcSession,
			principalId: principal,
			idpSub: 'sub-upgrade',
			authenticationMethod: 'oidc',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})

		const before = await h.repositories.passwords.lookupLogin('upgrade@example.test')
		if (before.status !== 'found' || before.credential === undefined) throw new Error('expected a stored credential')
		expect(JSON.parse(before.credential.parameters)).toEqual({ iterations: 1_000, outputBytes: PBKDF2_SHA256_OUTPUT_BYTES })

		const ctx = new TestContext()
		const response = await handleAuth(
			new Request(`${ISSUER}/auth/login`, {
				method: 'POST',
				headers: {
					Origin: ISSUER,
					'Sec-Fetch-Site': 'same-origin',
					'Content-Type': 'application/x-www-form-urlencoded',
					'CF-Connecting-IP': '192.0.2.10',
				},
				body: new URLSearchParams({ email: 'upgrade@example.test', password: PASSWORD }),
			}),
			services,
			AUTH_ENV,
			ctx,
		)
		await ctx.drain()

		// The login itself works — an upgrade must be invisible to the person signing in.
		expect(response.status).toBe(302)
		expect(response.headers.getSetCookie().some((header) => header.startsWith(`${SESSION_COOKIE}=`))).toBe(true)

		// The verifier was rewritten with the CURRENT parameters and a fresh salt.
		const after = await h.repositories.passwords.lookupLogin('upgrade@example.test')
		if (after.status !== 'found' || after.credential === undefined) throw new Error('expected a stored credential')
		expect(JSON.parse(after.credential.parameters)).toEqual({
			iterations: PBKDF2_SHA256_ITERATIONS,
			outputBytes: PBKDF2_SHA256_OUTPUT_BYTES,
		})
		expect(after.credential.salt).not.toBe(before.credential.salt)
		expect(after.credential.password_hash).not.toBe(before.credential.password_hash)

		// The pre-existing PASSWORD session is gone; the OIDC one survives.
		expect(await h.repositories.sessions.getActiveSessionByHash(passwordSession)).toBeNull()
		expect(await h.repositories.sessions.getActiveSessionByHash(oidcSession)).not.toBeNull()
	})
})
