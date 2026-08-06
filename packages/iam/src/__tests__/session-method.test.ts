// A session may only be used while the installation still enables the method that created it
// (backlog 55). Disabling OIDC or password used to change what the NEXT login could do and nothing
// about the sessions already issued, so an installation that moved to password-only kept honouring
// every OIDC login for the rest of its 30-day life.
//
// `sessionUsable` is checked at all three USE sites, and there is one test per site here — twice, once
// against SQLite and once against a real Postgres, because the two schemas carry the method column and
// its CHECKs independently.
//
// The Postgres half skips (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — helpers/postgres.ts.

import { AUTH_CALLBACK_PATH, AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import { PostgresDatabase } from '@fabrika/platform-node'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAdmin } from '../admin/router'
import { LOCAL_DEV_ADMIN_ID, sessionUsable } from '../auth'
import { handleAuth } from '../auth/routes'
import { type AuthenticationMethod, createIamRepositories, type IamRepositories } from '../db'
import type { RequestContext } from '../env'
import { applyMigrations, postgresMigrations } from '../node/migrate'
import { pkceChallenge } from '../oidc'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { mintToken } from '../tokens'
import { createHarness, makeServicesFor, seedUser } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

const ISSUER = 'https://iam.test'
const APP_ORIGIN = 'https://app.test'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ADMIN_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', FABRIKA_IAM_PROVISIONING_KEY: '', ENVIRONMENT: 'stage' }
const HANDOFF_STATE = 'session-method-state'
const HANDOFF_CHALLENGE = await pkceChallenge('session-method-verifier')

if (!hasPostgres) {
	console.warn(`session-method.test.ts (Postgres half) ${skipReason}`)
}

class TestContext implements RequestContext {
	waitUntil(): void {}
}

/** The login page (200) rather than the 302 carrying a handoff code — i.e. `currentSession` said no. */
async function handoffStatus(services: Services, session: string): Promise<number> {
	const url = new URL('/auth/login', ISSUER)
	url.searchParams.set('app', 'notes')
	url.searchParams.set('redirect', `${APP_ORIGIN}/private`)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, HANDOFF_STATE)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, HANDOFF_CHALLENGE)
	const response = await handleAuth(
		new Request(url, {
			headers: { Cookie: `${SESSION_COOKIE}=${session}` },
		}),
		services,
		AUTH_ENV,
		new TestContext(),
	)
	if (response.status === 302) {
		expect(new URL(response.headers.get('location') ?? '').pathname).toBe(AUTH_CALLBACK_PATH)
	}
	return response.status
}

describe('sessionUsable', () => {
	const config = (oidc: boolean, password: boolean, localDevLogin: boolean) => ({
		authentication: { oidc: { enabled: oidc }, password: { enabled: password } },
		localDevLogin,
	})

	test('answers for every method the column can hold, and answers only from configuration', () => {
		const method = (authentication_method: AuthenticationMethod) => ({ authentication_method })
		expect(sessionUsable(method('oidc'), config(true, false, false))).toBe(true)
		expect(sessionUsable(method('oidc'), config(false, true, true))).toBe(false)
		expect(sessionUsable(method('password'), config(false, true, false))).toBe(true)
		expect(sessionUsable(method('password'), config(true, false, true))).toBe(false)
		// The bypass is the case the naive rule broke: a local installation runs with OIDC off.
		expect(sessionUsable(method('local_dev'), config(false, true, true))).toBe(true)
		expect(sessionUsable(method('local_dev'), config(true, true, false))).toBe(false)
	})
})

describe('a session whose method the installation has since disabled — SQLite', () => {
	/** An OIDC session, plus services for an installation that has moved to password-only. */
	async function oidcSessionAfter(oidcEnabled: boolean) {
		const harness = createHarness()
		const services = harness.makeServices({
			issuer: ISSUER,
			environment: 'stage',
			authentication: { oidc: oidcEnabled, password: true },
		})
		await services.repositories.handoff.setReturnOrigins('notes', [APP_ORIGIN])
		const principalId = seedUser(harness.sqlite, { email: 'human@contember.com', sub: 'sub-1' })
		const session = await harness.signSession(principalId, { email: 'human@contember.com' })
		return { services, session, principalId }
	}

	test('is refused at MINT', async () => {
		const live = await oidcSessionAfter(true)
		expect((await mintToken(live.services, AUTH_ENV, { app: 'notes', session: live.session, requestId: 'r1' })).result.ok).toBe(true)

		const dead = await oidcSessionAfter(false)
		const outcome = await mintToken(dead.services, AUTH_ENV, { app: 'notes', session: dead.session, requestId: 'r1' })
		expect(outcome.result).toEqual({ ok: false, reason: 'invalid_session' })
		// The principal is still reported, so the refusal reaches the auth_log with a subject.
		expect(outcome.principalId).toBe(dead.principalId)
	})

	test('is refused at currentSession, so it cannot father a handoff', async () => {
		const live = await oidcSessionAfter(true)
		expect(await handoffStatus(live.services, live.session)).toBe(302)

		const dead = await oidcSessionAfter(false)
		expect(await handoffStatus(dead.services, dead.session)).toBe(200)
	})

	test('is refused at resolveAdmin', async () => {
		const live = await oidcSessionAfter(true)
		expect((await resolveAdmin(live.services, ADMIN_ENV, { bearer: null, session: live.session, requestId: 'r1' })).ok).toBe(true)

		const dead = await oidcSessionAfter(false)
		expect(await resolveAdmin(dead.services, ADMIN_ENV, { bearer: null, session: dead.session, requestId: 'r1' })).toEqual({
			ok: false,
			status: 401,
			reason: 'invalid_session',
		})
	})
})

describe.skipIf(!hasPostgres)('a session whose method the installation has since disabled — Postgres', () => {
	let fixture: PostgresFixture | null = null
	let repositories: IamRepositories

	beforeAll(async () => {
		if (!hasPostgres) return
		fixture = await createPostgres('session_method')
		repositories = createIamRepositories(fixture.db)
	})

	afterAll(async () => {
		await fixture?.close()
	})

	let seq = 0

	/** A principal + one session of `method`, and services for an installation with `oidc` as given. */
	async function scenario(method: AuthenticationMethod, options: { oidc: boolean; localDevLogin?: boolean }) {
		seq += 1
		// The session's subject is the bypass's fixed one; the PRINCIPAL's is per-scenario, because only
		// one principal may ever carry `local-dev-admin` and each scenario wants its own.
		const idpSub = method === 'local_dev' ? LOCAL_DEV_ADMIN_ID : `sub-${seq}`
		const principal = await repositories.principals.createUser(`sub-${seq}`, `human-${seq}@contember.com`)
		const session = `session-token-${seq}`
		await repositories.sessions.createSession({
			tokenHash: await hashToken(session),
			principalId: principal.id,
			...(method === 'password' ? {} : { idpSub }),
			email: principal.email,
			authenticationMethod: method,
			expiresAt: Math.floor(Date.now() / 1000) + 3_600,
		})
		await repositories.handoff.setReturnOrigins('notes', [APP_ORIGIN])
		const services = makeServicesFor(repositories, {
			issuer: ISSUER,
			environment: options.localDevLogin === true ? 'local' : 'stage',
			...(options.localDevLogin === true ? { localDevLogin: true } : {}),
			authentication: { oidc: options.oidc, password: true },
		})
		return { services, session, principalId: principal.id }
	}

	test('is refused at MINT', async () => {
		const live = await scenario('oidc', { oidc: true })
		expect((await mintToken(live.services, AUTH_ENV, { app: 'notes', session: live.session, requestId: 'r1' })).result.ok).toBe(true)

		const dead = await scenario('oidc', { oidc: false })
		expect((await mintToken(dead.services, AUTH_ENV, { app: 'notes', session: dead.session, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
	})

	test('is refused at currentSession, so it cannot father a handoff', async () => {
		const live = await scenario('oidc', { oidc: true })
		expect(await handoffStatus(live.services, live.session)).toBe(302)

		const dead = await scenario('oidc', { oidc: false })
		expect(await handoffStatus(dead.services, dead.session)).toBe(200)
	})

	test('is refused at resolveAdmin', async () => {
		const live = await scenario('oidc', { oidc: true })
		expect((await resolveAdmin(live.services, ADMIN_ENV, { bearer: null, session: live.session, requestId: 'r1' })).ok).toBe(true)

		const dead = await scenario('oidc', { oidc: false })
		expect(await resolveAdmin(dead.services, ADMIN_ENV, { bearer: null, session: dead.session, requestId: 'r1' })).toEqual({
			ok: false,
			status: 401,
			reason: 'invalid_session',
		})
	})

	test('the local-dev bypass survives OIDC being off — the reason it has a method of its own', async () => {
		const bypass = await scenario('local_dev', { oidc: false, localDevLogin: true })
		expect((await mintToken(bypass.services, AUTH_ENV, { app: 'notes', session: bypass.session, requestId: 'r1' })).result.ok).toBe(true)

		const off = await scenario('local_dev', { oidc: false })
		expect((await mintToken(off.services, AUTH_ENV, { app: 'notes', session: off.session, requestId: 'r1' })).result).toEqual({
			ok: false,
			reason: 'invalid_session',
		})
	})
})

// ── The upgrade path ──────────────────────────────────────────────────────────
//
// A bypass session issued BEFORE the method existed is stored as `oidc` with the fixed subject. Left
// alone it would read as an OIDC session in an installation that runs OIDC off, so the migration
// renames exactly those rows — which is also why a local stack stays signed in across the upgrade.

const SQLITE_DIR = join(import.meta.dir, '..', '..', 'migrations')
const SQLITE_MIGRATION = '0013_session_method_local_dev.sql'
const POSTGRES_MIGRATION = '0007_session_method_local_dev.sql'
const T = 1_782_896_400

/** Apply one file the way `wrangler d1 migrations apply` does — statement by statement. */
function applySqlite(db: Database, sql: string): void {
	for (const statement of sql.split(/;\s*\n/).map((s) => s.trim())) {
		if (statement === '' || statement.split('\n').every((line) => line.trim().startsWith('--'))) continue
		db.query(statement).run()
	}
}

describe('the migration renames the sessions the bypass already minted', () => {
	test('SQLite', () => {
		const db = new Database(':memory:')
		db.exec('PRAGMA foreign_keys = ON')
		for (const name of readdirSync(SQLITE_DIR).filter((f) => f.endsWith('.sql') && f < SQLITE_MIGRATION).sort()) {
			db.exec(readFileSync(join(SQLITE_DIR, name), 'utf8'))
		}
		db.run(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
			VALUES ('p1', 'user', 'local-dev-admin', 'admin@local.test', 'admin@local.test', ${T}, ${T})`)
		db.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at)
			VALUES ('s-bypass', 'h-bypass', 'p1', 'local-dev-admin', 'admin@local.test', 'oidc', ${T}, ${T + 100})`)
		db.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at)
			VALUES ('s-oidc', 'h-oidc', 'p1', 'google-sub', 'human@x.cz', 'oidc', ${T}, ${T + 100})`)

		applySqlite(db, readFileSync(join(SQLITE_DIR, SQLITE_MIGRATION), 'utf8'))

		expect(db.query<{ id: string; authentication_method: string }, []>('SELECT id, authentication_method FROM sessions ORDER BY id').all())
			.toEqual([
				{ id: 's-bypass', authentication_method: 'local_dev' },
				{ id: 's-oidc', authentication_method: 'oidc' },
			])
	})

	test.skipIf(!hasPostgres)('Postgres', async () => {
		const url = postgresUrl ?? ''
		const schema = `session_method_upgrade_${Math.random().toString(36).slice(2, 10)}`
		const admin = PostgresDatabase.connect(url)
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		const db = PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 1 })
		try {
			await applyMigrations(db, postgresMigrations().filter((m) => m.name < POSTGRES_MIGRATION))
			await db.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).bind('p1', 'user', 'local-dev-admin', 'admin@local.test', 'admin@local.test', T, T).run()
			for (const [id, hash, sub] of [['s-bypass', 'h-bypass', 'local-dev-admin'], ['s-oidc', 'h-oidc', 'google-sub']]) {
				await db.prepare(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id ?? '', hash ?? '', 'p1', sub ?? '', 'oidc', T, T + 100).run()
			}

			expect(await applyMigrations(db)).toEqual([POSTGRES_MIGRATION])

			const { results } = await db.prepare('SELECT id, authentication_method FROM sessions ORDER BY id')
				.all<{ id: string; authentication_method: string }>()
			expect(results).toEqual([
				{ id: 's-bypass', authentication_method: 'local_dev' },
				{ id: 's-oidc', authentication_method: 'oidc' },
			])
		} finally {
			await db.close()
			const cleanup = PostgresDatabase.connect(url)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		}
	})
})
