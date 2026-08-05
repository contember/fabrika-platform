/**
 * The per-client abuse bucket (WU-C, backlog 21 + 49) — three properties, in the order they matter:
 *
 *  1. **Isolation.** One abusive client is refused while another keeps its full allowance. Before this
 *     bucket the only bound beyond per-account was deployment-wide, so one client could deny everyone.
 *  2. **Atomicity.** Admission is decided from the `RETURNING` of the same statement that increments,
 *     so a concurrent burst cannot cross the limit before any request has recorded its attempt. Proved
 *     by counting the derivations a 120-deep burst actually bought, not asserted.
 *  3. **Provenance.** The coordinate comes from the ONE header the composition root names, and from
 *     nothing else. A caller that sets the other names — the spoofing test, once per composition —
 *     changes no key, and an installation that names no header gets no per-client bucket at all rather
 *     than a forgeable one.
 */

import { CLIENT_ADDRESS_HEADER } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { handleAuth } from '../auth/routes'
import { readClientAddress } from '../client-address'
import type { Env, RequestContext } from '../env'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const ISSUER = 'http://localhost:18191'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const CLOUDFLARE_HEADER = 'CF-Connecting-IP'
const PASSWORD = 'a valid long password'
/** Mirrors `LOGIN_CLIENT_MAX_ATTEMPTS` in auth/routes.ts — the attempt at which a client is refused. */
const CLIENT_MAX = 100

class CountingHasher implements PasswordHasher {
	hashCalls = 0
	verifyCalls = 0

	hash(password: string): Promise<StoredPasswordHash> {
		this.hashCalls += 1
		return Promise.resolve({ algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` })
	}

	verify(password: string, stored: StoredPasswordHash): Promise<{ valid: boolean; needsRehash: boolean }> {
		this.verifyCalls += 1
		return Promise.resolve({ valid: stored.passwordHash === `hash:${password}`, needsRehash: false })
	}
}

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
	async drain(): Promise<void> {
		await Promise.all(this.pending)
	}
}

function login(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
	return new Request(`${ISSUER}/auth/login`, {
		method: 'POST',
		headers: {
			Origin: ISSUER,
			'Sec-Fetch-Site': 'same-origin',
			'Content-Type': 'application/x-www-form-urlencoded',
			...headers,
		},
		body: new URLSearchParams(fields),
	})
}

function harness(hasher: CountingHasher = new CountingHasher()) {
	const h = createHarness()
	const services = h.makeServices({ issuer: ISSUER, authentication: { oidc: false, password: true }, passwordHasher: hasher })
	return { h, hasher, services }
}

function clientKey(address: string, purpose = 'password-login'): Promise<string> {
	return hashToken(`${purpose}:client:${address}`)
}

async function attemptCount(h: Harness, address: string): Promise<number | null> {
	const row = await h.repositories.passwords.getLoginThrottle(await clientKey(address))
	return row?.attempt_count ?? null
}

describe('the client coordinate comes from the composition, not the caller', () => {
	test('only the named header is read, and naming none reads nothing', () => {
		const request = new Request(`${ISSUER}/auth/login`, {
			headers: { [CLIENT_ADDRESS_HEADER]: '203.0.113.99', [CLOUDFLARE_HEADER]: '198.51.100.7' },
		})
		// The Cloudflare composition: IAM's Worker holds its own Custom Domain, so the edge header is the
		// only trustworthy one and a caller-supplied `X-Fabrika-Client-Ip` is not read.
		expect(readClientAddress(request, CLOUDFLARE_HEADER)).toBe('198.51.100.7')
		// The Bun composition behind Caddy: the proxy writes its header after deleting the caller's, and
		// `CF-Connecting-IP` on that cloud is a caller's invention.
		expect(readClientAddress(request, CLIENT_ADDRESS_HEADER)).toBe('203.0.113.99')
		// An installation whose ingress guarantees nothing gets no per-client bucket at all.
		expect(readClientAddress(request, undefined)).toBeNull()
		expect(readClientAddress(request, '')).toBeNull()
	})

	test('a second value cannot change the key, and an absurd one is refused', () => {
		const appended = new Request(ISSUER, { headers: { [CLIENT_ADDRESS_HEADER]: '198.51.100.7' } })
		appended.headers.append(CLIENT_ADDRESS_HEADER, '203.0.113.99')
		expect(readClientAddress(appended, CLIENT_ADDRESS_HEADER)).toBe('198.51.100.7')

		expect(readClientAddress(new Request(ISSUER, { headers: { [CLIENT_ADDRESS_HEADER]: '  ' } }), CLIENT_ADDRESS_HEADER)).toBeNull()
		expect(readClientAddress(new Request(ISSUER, { headers: { [CLIENT_ADDRESS_HEADER]: 'x'.repeat(65) } }), CLIENT_ADDRESS_HEADER))
			.toBeNull()
	})
})

describe('one client is bounded without bounding another', () => {
	test('the abusive client is refused while a second client still signs in', async () => {
		const { h, hasher, services } = harness()
		const abusive = '203.0.113.5'
		const innocent = '198.51.100.9'
		const ctx = new TestContext()

		for (let i = 0; i < CLIENT_MAX; i++) {
			// A distinct address each time, so only the CLIENT bucket can be what refuses: the account
			// bucket never sees the same mailbox twice.
			await handleAuth(login({ email: `probe-${i}@example.test`, password: PASSWORD }), services, AUTH_ENV, ctx, abusive)
		}
		expect(hasher.hashCalls).toBe(CLIENT_MAX - 1)
		expect(await attemptCount(h, abusive)).toBe(CLIENT_MAX)

		// Nothing more is spent on that client, whatever it asks for.
		await handleAuth(login({ email: 'probe-x@example.test', password: PASSWORD }), services, AUTH_ENV, ctx, abusive)
		expect(hasher.hashCalls).toBe(CLIENT_MAX - 1)

		// A different client is untouched — including on the credential path, which is what the
		// deployment-wide bucket could not promise.
		const principalId = seedUser(h.sqlite, { sub: 'sub-ok', email: 'person@example.test' })
		await h.repositories.passwords.enableEnrollment(principalId)
		await h.repositories.passwords.upsertCredential(principalId, await hasher.hash(PASSWORD))
		const response = await handleAuth(
			login({ email: 'person@example.test', password: PASSWORD }),
			services,
			AUTH_ENV,
			ctx,
			innocent,
		)
		expect(response.status).toBe(302)
		expect(await attemptCount(h, innocent)).toBe(1)
		await ctx.drain()
	})

	test('the bucket survives a successful login — one valid credential does not reset it', async () => {
		const { h, hasher, services } = harness()
		const address = '203.0.113.11'
		const ctx = new TestContext()
		const principalId = seedUser(h.sqlite, { sub: 'sub-ok', email: 'person@example.test' })
		await h.repositories.passwords.enableEnrollment(principalId)
		await h.repositories.passwords.upsertCredential(principalId, await hasher.hash(PASSWORD))

		await handleAuth(login({ email: 'other@example.test', password: PASSWORD }), services, AUTH_ENV, ctx, address)
		const success = await handleAuth(login({ email: 'person@example.test', password: PASSWORD }), services, AUTH_ENV, ctx, address)
		expect(success.status).toBe(302)
		// `clearLoginFailures` clears the ACCOUNT key only. An attacker holding one valid credential must
		// not be able to zero its own client bucket between bursts.
		expect(await attemptCount(h, address)).toBe(2)
		await ctx.drain()
	})

	test('recovery has its own client bucket, on its own key', async () => {
		const h = createHarness()
		const services = h.makeServices({
			issuer: ISSUER,
			authentication: { oidc: false, password: true },
			passwordHasher: new CountingHasher(),
			email: { send: () => Promise.resolve({ status: 'accepted', provider: 'test', messageId: 'm' }) },
		})
		const address = '203.0.113.12'
		const ctx = new TestContext()
		await handleAuth(
			new Request(`${ISSUER}/auth/forgot-password`, {
				method: 'POST',
				headers: { Origin: ISSUER, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ email: 'person@example.test' }),
			}),
			services,
			AUTH_ENV,
			ctx,
			address,
		)
		// Recovery's bucket is separate from login's, so exhausting one never silently spends the other —
		// the mail-delivery bound and the password-derivation bound are different budgets.
		expect((await h.repositories.passwords.getLoginThrottle(await clientKey(address, 'password-recovery')))?.attempt_count).toBe(1)
		expect(await h.repositories.passwords.getLoginThrottle(await clientKey(address))).toBeNull()
		await ctx.drain()
	})

	test('no coordinate means no client bucket — the buckets that existed before, unchanged', async () => {
		const { h, hasher, services } = harness()
		const ctx = new TestContext()
		await handleAuth(login({ email: 'person@example.test', password: PASSWORD }), services, AUTH_ENV, ctx, null)
		expect(hasher.hashCalls).toBe(1)
		const rows = h.sqlite.query<{ login_key_hash: string }, []>('SELECT login_key_hash FROM password_login_throttles').all()
		expect(rows).toHaveLength(2)
		await ctx.drain()
	})

	test('the address is stored only as a hash', async () => {
		const { h, services } = harness()
		const address = '203.0.113.13'
		const ctx = new TestContext()
		await handleAuth(login({ email: 'person@example.test', password: PASSWORD }), services, AUTH_ENV, ctx, address)
		const rows = h.sqlite.query<{ login_key_hash: string }, []>('SELECT login_key_hash FROM password_login_throttles').all()
		expect(rows).toHaveLength(3)
		expect(rows.every((row) => !row.login_key_hash.includes(address) && !row.login_key_hash.includes('person'))).toBe(true)
		await ctx.drain()
	})
})

describe('the limit cannot be crossed by concurrency', () => {
	test('a 120-deep burst buys exactly the derivations the limit allows', async () => {
		const { h, hasher, services } = harness()
		const address = '203.0.113.20'
		const ctx = new TestContext()
		const burst = 120

		await Promise.all(
			Array.from(
				{ length: burst },
				(_unused, i) => handleAuth(login({ email: `burst-${i}@example.test`, password: PASSWORD }), services, AUTH_ENV, ctx, address),
			),
		)

		// Were admission a read followed by a write, every one of the 120 would have read "not blocked"
		// and spent a derivation. Admission is instead the RETURNING of the increment itself, so each
		// request sees its own count: 1…99 are admitted, 100 is the one that blocks, and the rest are
		// refused before any work.
		expect(hasher.hashCalls).toBe(CLIENT_MAX - 1)
		const row = await h.repositories.passwords.getLoginThrottle(await clientKey(address))
		expect(row?.attempt_count).toBe(CLIENT_MAX)
		expect(row?.blocked_until).toBeGreaterThan(Math.floor(Date.now() / 1000))
		await ctx.drain()
	})
})

// ── The composition-level spoofing tests: one per provider shape ──────────────

const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

function appEnv(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: '[]',
		ENVIRONMENT: 'stage',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		EMAIL_PROVIDER: 'none',
		ISSUER: ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
	}
}

describe('a caller cannot choose its own bucket on either composition', () => {
	const forged = { [CLIENT_ADDRESS_HEADER]: '203.0.113.66', [CLOUDFLARE_HEADER]: '203.0.113.77' }

	test('Cloudflare: the edge header keys the bucket and a forged proxy header does not', async () => {
		const h = createHarness()
		// The Worker root's own wiring (`src/index.ts`): IAM is reached through Cloudflare's edge, which
		// writes `CF-Connecting-IP` and replaces a caller's.
		const app = createIamApp({ clientAddressHeader: CLOUDFLARE_HEADER })
		await app.fetch(login({ email: 'person@example.test', password: PASSWORD }, forged), appEnv(h), { waitUntil() {} })

		expect(await h.repositories.passwords.getLoginThrottle(await clientKey('203.0.113.77'))).not.toBeNull()
		expect(await h.repositories.passwords.getLoginThrottle(await clientKey('203.0.113.66'))).toBeNull()
	})

	test('Caddy/Bun: the proxy header keys the bucket and a forged edge header does not', async () => {
		const h = createHarness()
		// The Bun root's own wiring (`src/node/server.ts`): Caddy writes `X-Fabrika-Client-Ip` after
		// deleting the caller's, and IAM is not publicly routed.
		const app = createIamApp({ clientAddressHeader: CLIENT_ADDRESS_HEADER })
		await app.fetch(login({ email: 'person@example.test', password: PASSWORD }, forged), appEnv(h), { waitUntil() {} })

		expect(await h.repositories.passwords.getLoginThrottle(await clientKey('203.0.113.66'))).not.toBeNull()
		expect(await h.repositories.passwords.getLoginThrottle(await clientKey('203.0.113.77'))).toBeNull()
	})

	test('an installation that names no header keys nothing, whatever the caller sends', async () => {
		const h = createHarness()
		await createIamApp().fetch(login({ email: 'person@example.test', password: PASSWORD }, forged), appEnv(h), { waitUntil() {} })

		const rows = h.sqlite.query<{ login_key_hash: string }, []>('SELECT login_key_hash FROM password_login_throttles').all()
		expect(rows).toHaveLength(2)
	})
})
