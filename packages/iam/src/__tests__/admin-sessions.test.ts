/**
 * The operator session surface (backlog 52).
 *
 * Before it, `revokeSessionByHash` was reachable from `/auth/logout` and nowhere else, so the only
 * answer an operator had to "that session should not exist" was to disable the whole principal —
 * which also locks the person out. These tests pin the three things that makes true: an operator can
 * SEE a principal's sessions, END one, and end ALL of them; and revoking the IAM parent ends every
 * app session derived from it WITHOUT a sweep, because the lookup joins to the parent (ADR-0021).
 */

import type { SessionDto } from '@fabrika/iam-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedGrant, seedRole, seedUser } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const IAM_APP = 'propustka'
const exec = { waitUntil() {} }
const FUTURE = Math.floor(Date.now() / 1000) + 3600
const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: JSON.stringify([ORIGIN]),
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		SESSION_COOKIE_DOMAIN: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

function call(h: Harness, session: string, method: string, input: unknown): Promise<Response> {
	return createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `px_session=${session}` },
			body: JSON.stringify({ method, input }),
		}),
		env(h),
		exec,
	)
}

async function admin(h: Harness): Promise<string> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	return h.signSession(id)
}

/** An IAM session for `principalId`, returning both the row id and the cookie value. */
async function openSession(
	h: Harness,
	principalId: string,
	options: { token: string; app?: string | null; parentSessionId?: string; method?: 'oidc' | 'password' },
): Promise<string> {
	return h.repositories.sessions.createSession({
		tokenHash: await hashToken(options.token),
		principalId,
		idpSub: options.method === 'password' ? null : `idp-${principalId}`,
		authenticationMethod: options.method ?? 'oidc',
		expiresAt: FUTURE,
		...(options.app !== undefined ? { app: options.app } : {}),
		...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
	})
}

/** The `result` of a successful RPC call. */
async function ok(h: Harness, session: string, method: string, input: unknown): Promise<unknown> {
	const response = await call(h, session, method, input)
	expect(response.status).toBe(200)
	return prop(await response.json(), 'result')
}

function sessionItems(result: unknown): SessionDto[] {
	const items = prop(result, 'items')
	if (!Array.isArray(items)) throw new Error('expected a session list')
	return items.map((item) => {
		const method = prop(item, 'authenticationMethod')
		const status = prop(item, 'status')
		return {
			id: String(prop(item, 'id')),
			principalId: String(prop(item, 'principalId')),
			authenticationMethod: method === 'password' ? 'password' : 'oidc',
			app: typeof prop(item, 'app') === 'string' ? String(prop(item, 'app')) : null,
			parentSessionId: typeof prop(item, 'parentSessionId') === 'string' ? String(prop(item, 'parentSessionId')) : null,
			status: status === 'revoked' ? 'revoked' : status === 'expired' ? 'expired' : 'active',
			createdAt: Number(prop(item, 'createdAt')),
			expiresAt: Number(prop(item, 'expiresAt')),
			revokedAt: typeof prop(item, 'revokedAt') === 'number' ? Number(prop(item, 'revokedAt')) : null,
		}
	})
}

describe('sessions.list', () => {
	test("lists a principal's sessions newest first, with the method, the app binding and the parent", async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-user', email: 'user@example.com' })
		const parent = await openSession(h, user, { token: 'iam-1' })
		const child = await openSession(h, user, { token: 'app-1', app: 'opice', parentSessionId: parent })
		await openSession(h, user, { token: 'pw-1', method: 'password' })

		const items = sessionItems(await ok(h, session, 'sessions.list', { principalId: user }))

		expect(items).toHaveLength(3)
		// UUIDv7 is monotonic with creation, so newest-first is descending by id.
		expect(items.map((item) => item.id)).toEqual([...items].sort((a, b) => (a.id < b.id ? 1 : -1)).map((item) => item.id))
		const bound = items.find((item) => item.id === child)
		expect(bound?.app).toBe('opice')
		expect(bound?.parentSessionId).toBe(parent)
		expect(items.find((item) => item.id === parent)?.app).toBeNull()
		expect(items.some((item) => item.authenticationMethod === 'password')).toBe(true)
		expect(items.every((item) => item.status === 'active')).toBe(true)
	})

	test('never returns the cookie or its hash — a session is addressed by id', async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-secret', email: 'secret@example.com' })
		await openSession(h, user, { token: 'top-secret-cookie' })

		const serialized = JSON.stringify(await ok(h, session, 'sessions.list', { principalId: user }))

		expect(serialized).not.toContain('top-secret-cookie')
		expect(serialized).not.toContain(await hashToken('top-secret-cookie'))
		expect(serialized).not.toContain('token_hash')
	})

	test('an unknown principal is a 404, not an empty page', async () => {
		const h = createHarness()
		const response = await call(h, await admin(h), 'sessions.list', { principalId: 'nobody' })
		expect(response.status).toBe(404)
	})

	test('pages with the same keyset cursor every other admin list uses', async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-page', email: 'page@example.com' })
		for (const token of ['a', 'b', 'c']) {
			await openSession(h, user, { token })
		}

		const first = await ok(h, session, 'sessions.list', { principalId: user, limit: 2 })
		const firstPage = sessionItems(first)
		expect(firstPage).toHaveLength(2)
		const cursor = prop(first, 'nextCursor')
		expect(cursor).toBe(firstPage[1]?.id)

		const second = sessionItems(await ok(h, session, 'sessions.list', { principalId: user, limit: 2, before: cursor }))
		expect(second).toHaveLength(1)
		expect(second[0]?.id).not.toBe(firstPage[0]?.id)
	})
})

describe('sessions.revoke', () => {
	test('REVOKING THE PARENT CASCADES to every app session derived from it, with no sweep', async () => {
		// The child row is NOT rewritten — `getActiveSessionByHash` joins to the parent on every use, so
		// the derived session stops resolving the moment the parent carries `revoked_at`. That is what
		// makes this one call instead of a walk over app sessions IAM cannot set a cookie for.
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-cascade', email: 'cascade@example.com' })
		const parent = await openSession(h, user, { token: 'iam-cookie' })
		const child = await openSession(h, user, { token: 'app-cookie', app: 'opice', parentSessionId: parent })
		const other = await openSession(h, user, { token: 'other-cookie' })

		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken('app-cookie'))).not.toBeNull()

		expect(await ok(h, session, 'sessions.revoke', { id: parent })).toEqual({ revoked: 1 })

		// Both the parent and the session derived from it are dead at USE…
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken('iam-cookie'))).toBeNull()
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken('app-cookie'))).toBeNull()
		// …and the child's own row was never touched, which is the mechanism, not an oversight.
		expect((await h.repositories.sessions.getSessionById(child))?.revoked_at).toBeNull()
		// An unrelated IAM session of the same principal keeps working.
		expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken('other-cookie'))).not.toBeNull()
		expect((await h.repositories.sessions.getSessionById(other))?.revoked_at).toBeNull()
	})

	test('is idempotent — a second revoke reports zero rather than failing', async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-twice', email: 'twice@example.com' })
		const id = await openSession(h, user, { token: 'once' })

		expect(await ok(h, session, 'sessions.revoke', { id })).toEqual({ revoked: 1 })
		expect(await ok(h, session, 'sessions.revoke', { id })).toEqual({ revoked: 0 })
	})

	test('an unknown session id is a 404', async () => {
		const h = createHarness()
		expect((await call(h, await admin(h), 'sessions.revoke', { id: 'no-such-session' })).status).toBe(404)
	})

	test('writes an audit entry naming the principal whose session it was', async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-audit', email: 'audited@example.com' })
		const id = await openSession(h, user, { token: 'audited' })

		await ok(h, session, 'sessions.revoke', { id })

		const row = h.sqlite.query<{ resource_id: string; metadata: string | null }, []>(
			"SELECT resource_id, metadata FROM audit_events WHERE action = 'iam.session.revoke'",
		).get()
		expect(row?.resource_id).toBe(id)
		expect(row?.metadata).toContain(user)
	})

	test('a NON-ADMIN cannot revoke a session — the same gate that guards every principal operation', async () => {
		const h = createHarness()
		seedRole(h.sqlite, IAM_APP, 'viewer', ['project.read'])
		const viewer = seedUser(h.sqlite, { sub: 'sub-viewer', email: 'viewer@example.com' })
		seedGrant(h.sqlite, viewer, 'viewer', null, IAM_APP)
		const victim = seedUser(h.sqlite, { sub: 'sub-victim', email: 'victim@example.com' })
		const id = await openSession(h, victim, { token: 'victim-cookie' })

		const response = await call(h, await h.signSession(viewer), 'sessions.revoke', { id })

		expect(response.status).toBe(403)
		expect((await h.repositories.sessions.getSessionById(id))?.revoked_at).toBeNull()
	})
})

describe('sessions.revokeAll', () => {
	test('ends every live session the principal holds and leaves the person able to sign in again', async () => {
		const h = createHarness()
		const session = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-all', email: 'all@example.com' })
		const parent = await openSession(h, user, { token: 'all-1' })
		await openSession(h, user, { token: 'all-2', app: 'opice', parentSessionId: parent })
		await openSession(h, user, { token: 'all-3', method: 'password' })

		expect(await ok(h, session, 'sessions.revokeAll', { id: user })).toEqual({ revoked: 3 })
		for (const token of ['all-1', 'all-2', 'all-3']) {
			expect(await h.repositories.sessions.getActiveSessionByHash(await hashToken(token))).toBeNull()
		}
		// Not the same thing as disabling the principal, which is exactly the point.
		expect((await h.repositories.principals.getPrincipalById(user))?.disabled_at).toBeNull()

		// Already-revoked rows are not counted again.
		expect(await ok(h, session, 'sessions.revokeAll', { id: user })).toEqual({ revoked: 0 })
	})

	test('an unknown principal is a 404', async () => {
		const h = createHarness()
		expect((await call(h, await admin(h), 'sessions.revokeAll', { id: 'nobody' })).status).toBe(404)
	})
})
