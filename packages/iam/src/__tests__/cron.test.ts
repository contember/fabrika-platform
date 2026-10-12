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
import { INVITATION_RETENTION_SECONDS, PASSWORD_TRANSIENT_RETENTION_SECONDS, runIamMaintenance } from '../cron'
import { createIamRepositories } from '../db'
import type { Env } from '../env'
import { hashToken } from '../secret'
import { buildServices } from '../services'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const NOW_MS = 1_800_000_000_000
const NOW = Math.floor(NOW_MS / 1000)
const DAY = 24 * 60 * 60
/** IAM's default `auth_log` retention, 30 days. */
const AUTH_LOG_RETENTION_SECONDS = 30 * DAY

/** The tables the sweep is responsible for, and how to count them. */
const SWEPT_TABLES = [
	'auth_log',
	'password_action_tokens',
	'password_login_throttles',
	'auth_codes',
	'sessions',
	'device_authorizations',
	'oauth_grants',
	'oauth_codes',
	'oauth_refresh_tokens',
	'delegation_grants',
	'membership_invitations',
] as const

function counts(sqlite: Database): Record<string, number> {
	const out: Record<string, number> = {}
	for (const table of SWEPT_TABLES) {
		const row = sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
		out[table] = row?.n ?? -1
	}
	return out
}

function env(h: Harness, overrides: Partial<Env> = {}): Env {
	return {
		...overrides,
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
		ENVIRONMENT: 'stage',
		ISSUER: 'https://iam.example.com',
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
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
	for (const expiry of [NOW - 1, NOW + 1]) {
		const attempt = await h.repositories.device.start({
			app: 'vozka',
			label: 'Cron device',
			permissions: ['deploy.read'],
			keyLifetimeSeconds: DAY,
			approvalChallenge: 'a'.repeat(43),
			redemptionChallenge: 'b'.repeat(43),
		})
		h.sqlite.run('UPDATE device_authorizations SET expires_at = ? WHERE id = ?', [expiry, attempt.attemptId])
	}

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

	// delegation_grants — a spent or expired grant goes at once; a live unspent one stays.
	for (const [id, expiresAt] of [['dg-old', NOW - 1], ['dg-live', NOW + 60]] as const) {
		h.sqlite.run(
			`INSERT INTO delegation_grants (id, grant_hash, app, principal_id, endpoint, request_id, expires_at, created_at)
				VALUES (?, ?, 'notes@prod', ?, 'api.invite', 'req', ?, ?)`,
			[id, await hashToken(id), principal, expiresAt, NOW - 60],
		)
	}

	// membership_invitations — cutoff is `expires_at < now - 7d`, whatever the state.
	for (const [id, expiresAt] of [['inv-old', NOW - INVITATION_RETENTION_SECONDS - DAY], ['inv-live', NOW + DAY]] as const) {
		h.sqlite.run(
			`INSERT INTO membership_invitations (id, token_hash, app, scope_type, scope_value, role_key, email, invited_by, expires_at, created_at)
				VALUES (?, ?, 'notes@prod', 'workspace', ?, 'editor', 'invitee@example.com', ?, ?, ?)`,
			[id, await hashToken(id), id, principal, expiresAt, NOW - 10 * DAY],
		)
	}

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
	const expiredSession = await h.repositories.sessions.createSession({
		tokenHash: await hashToken('session-expired'),
		principalId: principal,
		idpSub: 'sub-cron',
		expiresAt: NOW - DAY,
	})
	const revoked = await hashToken('session-revoked')
	await h.repositories.sessions.createSession({ tokenHash: revoked, principalId: principal, idpSub: 'sub-cron', expiresAt: NOW + DAY })
	await h.repositories.sessions.revokeSessionByHash(revoked)
	const liveSessionId = await h.repositories.sessions.createSession({
		tokenHash: await hashToken('session-live'),
		principalId: principal,
		idpSub: 'sub-cron',
		expiresAt: NOW + DAY,
	})

	// oauth_grants go with their session row; codes and refresh tokens go at their own expiry.
	for (const [grantId, sessionId] of [['grant-doomed', expiredSession], ['grant-live', liveSessionId]] as const) {
		await h.repositories.oauth.createGrant(
			{
				id: grantId,
				principal_id: principal,
				session_id: sessionId,
				client_id: 'https://claude.example.test/cimd',
				app: 'control',
				resource: 'https://control.example.test/mcp',
				scopes: '["authoring"]',
				created_at: NOW - DAY,
				expires_at: NOW + DAY,
				revoked_at: null,
			},
			{ token_hash: `code-${grantId}`, redirect_uri: 'https://claude.example.test/cb', challenge: 'c'.repeat(43), expires_at: NOW + 60 },
		)
	}
	h.sqlite.run(`UPDATE oauth_codes SET expires_at = ? WHERE token_hash = 'code-grant-live'`, [NOW - 1])
	h.sqlite.run(
		`INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, challenge, expires_at) VALUES ('code-fresh', 'grant-live', 'x', 'c', ?)`,
		[
			NOW + 60,
		],
	)
	for (const [hash, expiresAt] of [['refresh-old', NOW - 1], ['refresh-live', NOW + DAY]] as const) {
		await h.repositories.oauth.insertRefreshToken({ token_hash: hash, grant_id: 'grant-live', expires_at: expiresAt })
	}

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
			device_authorizations: 2,
			oauth_grants: 2,
			oauth_codes: 3,
			oauth_refresh_tokens: 2,
			delegation_grants: 2,
			membership_invitations: 2,
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
			device_authorizations: 1,
			oauth_grants: 1,
			oauth_codes: 1,
			oauth_refresh_tokens: 1,
			delegation_grants: 1,
			membership_invitations: 1,
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
			device_authorizations: 1,
			oauth_grants: 1,
			oauth_codes: 1,
			oauth_refresh_tokens: 1,
			delegation_grants: 1,
			membership_invitations: 1,
		})
	})
})

describe('retention settings', () => {
	/** One `auth_log` and one `audit_events` row per age, in days before NOW. */
	function seedAges(h: Harness, ages: number[]): void {
		for (const age of ages) {
			h.sqlite.run(
				`INSERT INTO auth_log (request_id, app, kind, principal_id, credential_id, decision, reason, created_at)
					VALUES (?, 'opice', 'authenticate', NULL, NULL, 'allow', NULL, ?)`,
				[`req-${age}`, NOW - age * DAY],
			)
			h.sqlite.run(
				`INSERT INTO audit_events (id, request_id, principal_id, principal_label, app, action, resource_type, created_at)
					VALUES (?, ?, NULL, 'seed', 'opice', 'seed.event', 'seed', ?)`,
				[`audit-${age}`, `req-${age}`, NOW - age * DAY],
			)
		}
	}

	async function sweep(h: Harness, overrides: Partial<Env>): Promise<{ authLog: number; audit: number }> {
		const settled: Promise<unknown>[] = []
		runIamMaintenance(env(h, overrides), { waitUntil: (promise) => settled.push(promise) }, NOW_MS)
		await Promise.all(settled)
		const count = (table: string) => h.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1
		return { authLog: count('auth_log'), audit: count('audit_events') }
	}

	test('by default auth_log keeps 30 days and every audit row stays', async () => {
		const h = createHarness()
		seedAges(h, [6, 8, 29, 31, 400])
		expect(await sweep(h, {})).toEqual({ authLog: 3, audit: 5 })
	})

	test('auth_log is pruned at the configured number of days', async () => {
		const h = createHarness()
		seedAges(h, [6, 8, 29, 31, 400])
		expect(await sweep(h, { AUTH_LOG_RETENTION_DAYS: '7' })).toEqual({ authLog: 1, audit: 5 })
	})

	test('audit_events are pruned only where the operator set a retention, at that value', async () => {
		const h = createHarness()
		seedAges(h, [6, 8, 29, 31, 400])
		expect(await sweep(h, { AUDIT_RETENTION_DAYS: '30' })).toEqual({ authLog: 3, audit: 3 })
	})

	test.each(['0', '-1', '7.5', '30d', 'thirty', '100000'])('a retention of %p refuses the boot', (value) => {
		const h = createHarness()
		expect(() => buildServices(env(h, { AUTH_LOG_RETENTION_DAYS: value }))).toThrow('AUTH_LOG_RETENTION_DAYS must be a whole number of days')
		expect(() => buildServices(env(h, { AUDIT_RETENTION_DAYS: value }))).toThrow('AUDIT_RETENTION_DAYS must be a whole number of days')
	})
})
