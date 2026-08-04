/**
 * `runIamMaintenance` — the whole scheduled sweep, with rows seeded on EACH SIDE of every cutoff.
 *
 * There was no test at all, and that is how `pruneSessions` came to be written, unit-tested as a
 * repository method, and never called: `sessions.test.ts` certified it as working while `sessions`
 * grew for the life of every installation (SEC-13). So this test asserts a row count per TABLE rather
 * than exercising the repositories, which makes adding or dropping one a visible change here.
 *
 * The retained side of each pair matters as much as the pruned side: a sweep that deletes everything
 * also passes a "did it delete?" assertion.
 */

import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { AUTH_LOG_RETENTION_SECONDS, PASSWORD_TRANSIENT_RETENTION_SECONDS, runIamMaintenance } from '../cron'
import { createIamRepositories } from '../db'
import type { Env } from '../env'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const NOW_MS = 1_800_000_000_000
const NOW = Math.floor(NOW_MS / 1000)
const DAY = 24 * 60 * 60

/** The tables the sweep is responsible for, and how to count them. */
const SWEPT_TABLES = ['auth_log', 'password_action_tokens', 'password_login_throttles', 'auth_codes', 'sessions'] as const

function counts(sqlite: Database): Record<string, number> {
	const out: Record<string, number> = {}
	for (const table of SWEPT_TABLES) {
		const row = sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
		out[table] = row?.n ?? -1
	}
	return out
}

function env(h: Harness): Env {
	return {
		DB: {
			prepare: () => {
				throw new Error('unused')
			},
			batch: () => Promise.reject(new Error('unused')),
		},
		REPOSITORIES: createIamRepositories({
			prepare: () => {
				throw new Error('unused')
			},
			batch: () => Promise.reject(new Error('unused')),
		}, h.repositories),
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: 'https://iam.example.com',
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		SESSION_COOKIE_DOMAIN: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		OIDC_ISSUER: '',
		OIDC_CLIENT_ID: '',
		OIDC_CLIENT_SECRET: '',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

/** Seed one doomed and one surviving row in every table the sweep touches. */
async function seedBothSides(h: Harness): Promise<string> {
	const principal = seedUser(h.sqlite, { sub: 'sub-cron', email: 'cron@example.com' })

	// auth_log — cutoff is `created_at < now - 30d`.
	for (const createdAt of [NOW - AUTH_LOG_RETENTION_SECONDS - DAY, NOW - AUTH_LOG_RETENTION_SECONDS + DAY]) {
		h.sqlite.run(
			`INSERT INTO auth_log (request_id, app, kind, principal_id, credential_id, decision, reason, created_at)
				VALUES (?, 'opice', 'authenticate', ?, NULL, 'allow', NULL, ?)`,
			[`req-${createdAt}`, principal, createdAt],
		)
	}

	// password_action_tokens — cutoff is `expires_at < now - 7d` (a consumed token uses the same bound).
	const tokenCutoff = NOW - PASSWORD_TRANSIENT_RETENTION_SECONDS
	// One per (principal, purpose): `uq_password_action_tokens_active` allows only one live token each,
	// so the aged one is parked on a second principal rather than a second purpose.
	const stale = seedUser(h.sqlite, { sub: 'sub-cron-stale', email: 'stale@example.com' })
	for (const [id, owner, expiresAt] of [['tok-old', stale, tokenCutoff - DAY], ['tok-live', principal, tokenCutoff + DAY]] as const) {
		h.sqlite.run(
			`INSERT INTO password_action_tokens (id, principal_id, purpose, token_hash, issued_by, expires_at, created_at)
				VALUES (?, ?, 'reset', ?, NULL, ?, ?)`,
			[id, owner, await hashToken(id), expiresAt, NOW - 10 * DAY],
		)
	}

	// password_login_throttles — cutoff is `updated_at < now - 7d`, and a row still BLOCKING survives
	// whatever its age (deleting it would lift the block).
	h.sqlite.run(
		`INSERT INTO password_login_throttles (login_key_hash, window_started_at, attempt_count, blocked_until, updated_at)
			VALUES ('throttle-old', ?, 1, NULL, ?)`,
		[tokenCutoff - DAY, tokenCutoff - DAY],
	)
	h.sqlite.run(
		`INSERT INTO password_login_throttles (login_key_hash, window_started_at, attempt_count, blocked_until, updated_at)
			VALUES ('throttle-live', ?, 1, NULL, ?)`,
		[tokenCutoff + DAY, tokenCutoff + DAY],
	)

	// auth_codes — a spent or expired code goes at once; a live unconsumed one stays.
	h.sqlite.run(
		`INSERT INTO auth_codes (id, code_hash, app, parent_session_id, return_url, expires_at, consumed_at, created_at) VALUES
			('code-expired', 'h-expired', 'notes', ?, 'https://notes.test/', ?, NULL, ?)`,
		[await liveSession(h, principal, 'parent-for-code'), NOW - 60, NOW - 300],
	)
	h.sqlite.run(
		`INSERT INTO auth_codes (id, code_hash, app, parent_session_id, return_url, expires_at, consumed_at, created_at) VALUES
			('code-live', 'h-live', 'notes', ?, 'https://notes.test/', ?, NULL, ?)`,
		[await liveSession(h, principal, 'parent-for-live-code'), NOW + 120, NOW],
	)

	// sessions — expired and revoked go, live stays. (Two more live ones exist as the codes' parents.)
	await h.repositories.sessions.createSession({
		tokenHash: await hashToken('session-expired'),
		principalId: principal,
		idpSub: 'sub-cron',
		expiresAt: NOW - DAY,
	})
	const revoked = await hashToken('session-revoked')
	await h.repositories.sessions.createSession({ tokenHash: revoked, principalId: principal, idpSub: 'sub-cron', expiresAt: NOW + DAY })
	await h.repositories.sessions.revokeSessionByHash(revoked)
	await h.repositories.sessions.createSession({
		tokenHash: await hashToken('session-live'),
		principalId: principal,
		idpSub: 'sub-cron',
		expiresAt: NOW + DAY,
	})

	return principal
}

async function liveSession(h: Harness, principalId: string, token: string): Promise<string> {
	return h.repositories.sessions.createSession({
		tokenHash: await hashToken(token),
		principalId,
		idpSub: 'sub-cron',
		expiresAt: NOW + 30 * DAY,
	})
}

describe('runIamMaintenance', () => {
	test('prunes exactly the aged rows in every table it owns, and nothing else', async () => {
		const h = createHarness()
		await seedBothSides(h)

		expect(counts(h.sqlite)).toEqual({
			auth_log: 2,
			password_action_tokens: 2,
			password_login_throttles: 2,
			auth_codes: 2,
			sessions: 5,
		})

		const settled: Promise<unknown>[] = []
		runIamMaintenance(env(h), { waitUntil: (promise) => settled.push(promise) }, NOW_MS)
		await Promise.all(settled)

		// One survivor per table — and `sessions` keeps the three live ones (the standalone live session
		// plus the two parents the handoff codes hang off). Sessions were NEVER pruned before: this line
		// is the whole of SEC-13.
		expect(counts(h.sqlite)).toEqual({
			auth_log: 1,
			password_action_tokens: 1,
			password_login_throttles: 1,
			auth_codes: 1,
			sessions: 3,
		})
	})

	test('a second run is a no-op — the sweep is idempotent, as an overlapping cron requires', async () => {
		const h = createHarness()
		await seedBothSides(h)

		for (let run = 0; run < 2; run++) {
			const settled: Promise<unknown>[] = []
			runIamMaintenance(env(h), { waitUntil: (promise) => settled.push(promise) }, NOW_MS)
			await Promise.all(settled)
		}

		expect(counts(h.sqlite)).toEqual({
			auth_log: 1,
			password_action_tokens: 1,
			password_login_throttles: 1,
			auth_codes: 1,
			sessions: 3,
		})
	})
})
