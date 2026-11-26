// The proxy's revocation feed as IAM answers it (ADR-0022), read from the timestamps the revocations already write, on
// SQLite and on Postgres when `FABRIKA_TEST_POSTGRES_URL` is set.

import { REVOCATION_FEED_MAX_SUBJECTS, REVOCATION_FEED_WINDOW_SECONDS } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamRepositories, createPostgresIamRepositories, type IamRepositories } from '../db'
import { revocations } from '../revocation-feed'
import { makeServicesFor, TestSqlDatabase } from './helpers/harness'
import { allMigrations } from './helpers/migrations'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

interface Engine {
	readonly repositories: IamRepositories
	readonly db: SqlDatabase
}

let postgres: PostgresFixture | null = null
let postgresEngine: Engine | null = null

beforeAll(async () => {
	if (!hasPostgres) return
	postgres = await createPostgres('revocations', { max: 2 })
	postgresEngine = { db: postgres.db, repositories: createPostgresIamRepositories(postgres.db) }
})

afterAll(async () => {
	await postgres?.close()
})

const now = () => Math.floor(Date.now() / 1000)
let seq = 0
const id = (prefix: string) => `${prefix}-${++seq}`

async function principal(db: SqlDatabase, disabledAt: number | null = null): Promise<string> {
	const principalId = id('p')
	await db
		.prepare(`INSERT INTO principals (id, type, external_id, email, label, disabled_at, activated_at, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`)
		.bind(principalId, `sub-${principalId}`, `${principalId}@example.com`, principalId, disabledAt, now(), now())
		.run()
	return principalId
}

async function session(db: SqlDatabase, principalId: string, revokedAt: number | null = null): Promise<string> {
	const sessionId = id('s')
	await db
		.prepare(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at, revoked_at)
			VALUES (?, ?, ?, ?, 'oidc', ?, ?, ?)`)
		.bind(sessionId, `hash-${sessionId}`, principalId, `sub-${principalId}`, now(), now() + 3600, revokedAt)
		.run()
	return sessionId
}

async function credential(db: SqlDatabase, principalId: string | null, revokedAt: number | null = null): Promise<string> {
	const credentialId = id('c')
	await db
		.prepare('INSERT INTO credentials (id, token_hash, principal_id, issued_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(credentialId, `hash-${credentialId}`, principalId, principalId, now(), revokedAt)
		.run()
	return credentialId
}

async function oauthGrant(db: SqlDatabase, principalId: string, sessionId: string, revokedAt: number | null = null): Promise<void> {
	await db
		.prepare(`INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at, revoked_at)
			VALUES (?, ?, ?, 'https://client.example/metadata.json', 'vozka', 'https://console.example', '[]', ?, ?, ?)`)
		.bind(id('g'), principalId, sessionId, now(), now() + 3600, revokedAt)
		.run()
}

const engines: [string, () => Engine | null, boolean][] = [
	['SQLite', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		sqlite.exec(allMigrations())
		const db = new TestSqlDatabase(sqlite)
		return { db, repositories: createIamRepositories(db) }
	}, true],
	['Postgres', () => postgresEngine, hasPostgres],
]

for (const [name, engineOf, available] of engines) {
	describe.skipIf(!available)(`the revocation feed on ${name}${available ? '' : ` — ${skipReason}`}`, () => {
		const fresh = async () => {
			const engine = engineOf()
			if (engine === null) throw new Error('no engine')
			if (engine === postgresEngine) {
				for (const table of ['oauth_grants', 'credentials', 'sessions', 'principals']) {
					await engine.db.prepare(`DELETE FROM ${table}`).run()
				}
			}
			return { db: engine.db, read: (since: number | null) => revocations(makeServicesFor(engine.repositories), { since }) }
		}

		test('every source lists its subject once, at its latest revocation, newest first; nothing unrevoked is listed', async () => {
			const { db, read } = await fresh()
			const t = now()
			const disabled = await principal(db, t - 10)
			const keyAndSession = await principal(db)
			await session(db, keyAndSession, t - 20)
			await credential(db, keyAndSession, t - 5)
			const anonymous = await credential(db, null, t - 30)
			const oauth = await principal(db)
			await oauthGrant(db, oauth, await session(db, oauth), t - 40)
			const untouched = await principal(db)
			await session(db, untouched)
			await credential(db, untouched)

			const answer = await read(null)
			expect(answer).toMatchObject({ ok: true, complete: true })
			if (!answer.ok) throw new Error('refused')
			expect(answer.now).toBeGreaterThanOrEqual(t)
			// An anonymous key is its own subject: the token it mints names the credential.
			expect(answer.subjects).toEqual([
				{ subject: keyAndSession, at: t - 5 },
				{ subject: disabled, at: t - 10 },
				{ subject: anonymous, at: t - 30 },
				{ subject: oauth, at: t - 40 },
			])
		})

		test('since reads from the cursor, held to the token lifetime and to the present', async () => {
			const { db, read } = await fresh()
			const t = now()
			await principal(db, t - REVOCATION_FEED_WINDOW_SECONDS - 5)
			const recent = await principal(db, t - 3)
			// Stamped ahead of IAM's clock (a writer's clock may run fast), so no second boundary the test crosses moves it out of the present.
			const current = await principal(db, t + 60)

			// Nothing older than a token lifetime can end a cached token, whatever the cursor asks.
			for (const since of [null, 0, t - 10_000]) {
				const answer = await read(since)
				if (!answer.ok) throw new Error('refused')
				expect(answer.subjects.map((s) => s.subject)).toEqual([current, recent])
			}
			const fromCursor = await read(t - 1)
			if (!fromCursor.ok) throw new Error('refused')
			expect(fromCursor.subjects.map((s) => s.subject)).toEqual([current])
			// A cursor ahead of IAM's clock is held to the present, so it still reads what was stamped from now on.
			const ahead = await read(t + 600)
			if (!ahead.ok) throw new Error('refused')
			expect(ahead.subjects.map((s) => s.subject)).toEqual([current])
		})

		test('more subjects than the bound answers the newest and complete: false', async () => {
			const { db, read } = await fresh()
			const t = now()
			await db
				.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
					INSERT INTO principals (id, type, external_id, email, label, disabled_at, activated_at, created_at)
					SELECT 'bulk-' || i, 'user', 'sub-bulk-' || i, 'bulk-' || i || '@example.com', 'bulk', ?, ?, ? FROM n`)
				.bind(REVOCATION_FEED_MAX_SUBJECTS + 1, t - 1, t, t)
				.run()
			const newest = await principal(db, t)

			const answer = await read(null)
			if (!answer.ok) throw new Error('refused')
			expect(answer.complete).toBe(false)
			expect(answer.subjects).toHaveLength(REVOCATION_FEED_MAX_SUBJECTS)
			expect(answer.subjects[0]).toEqual({ subject: newest, at: t })
		})
	})
}
