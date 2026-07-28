// The Postgres port, proved end to end against a REAL Postgres.
//
// This is the acceptance test for `migrations-postgres/`: it applies the shipped files with the
// shipped runner and then drives the SAME `src/db.ts` the Worker uses — every method, unmodified —
// against the result. If the two migration sets ever diverge in a way that matters, a call in here
// fails; a schema that merely LOOKS equivalent is not what is being asserted.
//
// It also pins the three things that behave differently from D1 and cannot be discovered any other
// way: `auth_log.id` comes back as a STRING, the partial unique indexes still infer for `ON
// CONFLICT`, and the seconds-valued timestamp columns still come back as `number`.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { createBackgroundTasks, type PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Db } from '../db'
import type { Env } from '../env'
import { prop } from '../json'
import { applyMigrations } from '../node/migrate'
import type { Runtime } from '../node/runtime'
import { createFetchHandler } from '../node/server'
import { MINT_KEY_PATH, MINT_SESSION_PATH } from '../rpc-http'
import { hashToken } from '../secret'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`postgres-schema.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let raw: PostgresDatabase
let db: Db

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('iam')
	raw = fixture.db
	db = new Db(raw)
})

afterAll(async () => {
	await fixture?.close()
})

/** Remove everything a test may have written. `principals` cascades to grants/credentials/sessions. */
async function reset(): Promise<void> {
	for (
		const table of [
			'auth_log',
			'audit_events',
			'credential_grants',
			'credentials',
			'sessions',
			'grants',
			'principals',
			'roles',
			'app_actions',
			'app_scopes',
		]
	) {
		await raw.prepare(`DELETE FROM ${table}`).run()
	}
}

function now(): number {
	return Math.floor(Date.now() / 1000)
}

describe.skipIf(!hasPostgres)('migrations-postgres — the runner', () => {
	test('applies every shipped file and is a no-op on the second run', async () => {
		// The fixture already applied them once. `run.initCommands` re-runs this on EVERY container
		// start, so "already current" must be the normal, silent outcome and not an error.
		expect(await applyMigrations(raw)).toEqual([])
		const { results } = await raw.prepare('SELECT name FROM schema_migrations ORDER BY name').all<{ name: string }>()
		expect(results.map((r) => r.name)).toEqual(['0001_init.sql', '0002_provisioning_principal.sql'])
	})

	test('seeds the provisioning principal (0002), idempotently', async () => {
		const row = await db.getPrincipalById('provisioning-admin')
		expect(row?.type).toBe('service')
		expect(row?.label).toBe('provisioning')
	})

	test('creates exactly the tables the service reads/writes, and none of the retired ones', async () => {
		const { results } = await raw
			.prepare(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?`)
			.bind(fixture?.schema ?? '')
			.all<{ name: string }>()
		const names = results.map((r) => r.name)
		for (
			const table of [
				'principals',
				'app_scopes',
				'app_actions',
				'roles',
				'grants',
				'audit_events',
				'auth_log',
				'credentials',
				'credential_grants',
				'sessions',
			]
		) {
			expect(names).toContain(table)
		}
		// Retired by migrations/0003, /0006 and /0007 — this set never creates them in the first place.
		expect(names).not.toContain('projects')
		expect(names).not.toContain('capability_tokens')
		expect(names).not.toContain('capability_grants')
		expect(names).not.toContain('group_role_mappings')
	})
})

describe.skipIf(!hasPostgres)('the Postgres schema — column types the row shapes depend on', () => {
	test('every seconds-valued timestamp column is int4, so it decodes as a JS number', async () => {
		// The rule from the migration header: a column a row shape types `number` must be INTEGER,
		// because Bun decodes int8/numeric as a STRING by column OID. This asserts the schema side.
		const { results } = await raw
			.prepare(`SELECT table_name, column_name, data_type FROM information_schema.columns
				WHERE table_schema = ? AND column_name IN ('created_at','disabled_at','expires_at','revoked_at')
				ORDER BY table_name, column_name`)
			.bind(fixture?.schema ?? '')
			.all<{ table_name: string; column_name: string; data_type: string }>()
		expect(results.length).toBeGreaterThan(0)
		for (const column of results) {
			expect(`${column.table_name}.${column.column_name}:${column.data_type}`).toBe(`${column.table_name}.${column.column_name}:integer`)
		}
	})

	test('auth_log.id is the ONE bigint — and therefore decodes as a string', async () => {
		await reset()
		const principal = await db.createUser('sub-bigint', 'bigint@x.cz')
		await db.writeAuthLog({ requestId: 'r-bigint', app: 'opice', kind: 'authenticate', principalId: principal.id, decision: 'allow' })

		const { results } = await raw
			.prepare(`SELECT data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'auth_log' AND column_name = 'id'`)
			.bind(fixture?.schema ?? '')
			.all<{ data_type: string }>()
		expect(results[0]?.data_type).toBe('bigint')

		// The consequence, pinned: `AuthLogRow.id` is `number | string` because of exactly this.
		const [row] = await db.listAuthLog({ limit: 1 })
		expect(typeof row?.id).toBe('string')
		// …and it must still be a usable cursor after `toAuthLogDto` normalises it.
		expect(Number(row?.id)).toBeGreaterThan(0)
	})

	test('the identity default assigns ids when writeAuthLog omits the column', async () => {
		await reset()
		await db.writeAuthLog({ requestId: 'r1', app: 'opice', kind: 'authenticate', principalId: null, decision: 'deny', reason: 'invalid_key' })
		await db.writeAuthLog({ requestId: 'r2', app: 'opice', kind: 'authenticate', principalId: null, decision: 'allow' })
		const rows = await db.listAuthLog({ limit: 10 })
		expect(rows).toHaveLength(2)
		// Descending by id — the keyset order the admin log pages by.
		expect(rows.map((r) => r.request_id)).toEqual(['r2', 'r1'])
		expect(Number(rows[0]?.id)).toBeGreaterThan(Number(rows[1]?.id))
	})
})

describe.skipIf(!hasPostgres)('the Postgres schema — constraints', () => {
	test('the partial unique indexes behave exactly as on SQLite', async () => {
		await reset()
		const p = await db.createUser('sub-uq', 'uq@x.cz')

		await db.createGrant({ principalId: p.id, roleKey: 'editor' })
		// A second GLOBAL role grant for the same (principal, role, app) — rejected despite NULL scope
		// and NULL app, because COALESCE(app,'*') folds the NULLs that would otherwise compare distinct.
		await expect(db.createGrant({ principalId: p.id, roleKey: 'editor' })).rejects.toThrow()

		// The same role for a DIFFERENT app is fine; the same app twice is not.
		await db.createGrant({ principalId: p.id, roleKey: 'editor', app: 'opice' })
		await expect(db.createGrant({ principalId: p.id, roleKey: 'editor', app: 'opice' })).rejects.toThrow()

		// Scoped grants differ by scope value.
		await db.createGrant({ principalId: p.id, roleKey: 'viewer', scopeType: 'team', scopeValue: 'acme' })
		await db.createGrant({ principalId: p.id, roleKey: 'viewer', scopeType: 'team', scopeValue: 'globex' })
		await expect(db.createGrant({ principalId: p.id, roleKey: 'viewer', scopeType: 'team', scopeValue: 'acme' })).rejects.toThrow()

		// Inline grants are deliberately unconstrained — each is its own attachment.
		await db.createGrant({ principalId: p.id, permissions: ['report.export'], scopeType: 'team', scopeValue: 'acme', app: 'opice' })
		await db.createGrant({ principalId: p.id, permissions: ['report.export'], scopeType: 'team', scopeValue: 'acme', app: 'opice' })
	})

	test('a grant carries EITHER a role_key OR inline permissions, and scope is both-or-neither', async () => {
		await reset()
		const p = await db.createUser('sub-xor', 'xor@x.cz')
		await expect(db.createGrant({ principalId: p.id, roleKey: 'editor', permissions: ['project.read'] })).rejects.toThrow()
		await expect(db.createGrant({ principalId: p.id })).rejects.toThrow()
		await expect(db.createGrant({ principalId: p.id, roleKey: 'editor', scopeType: 'team' })).rejects.toThrow()
		await expect(db.createGrant({ principalId: p.id, roleKey: 'editor', scopeValue: 'acme' })).rejects.toThrow()
	})

	test('at most one user principal per email, and unique (type, external_id)', async () => {
		await reset()
		await db.inviteUser('dup@x.cz')
		await expect(db.inviteUser('dup@x.cz')).rejects.toThrow()
		// …but two INVITED users (external_id NULL) with different emails coexist: the partial index on
		// (type, external_id) skips NULLs, which is the whole reason it is partial.
		await db.inviteUser('other@x.cz')
		await db.createUser('sub-shared', 'first@x.cz')
		await expect(db.createUser('sub-shared', 'second@x.cz')).rejects.toThrow()
	})

	test('roles.permissions accepts junk — JSON validity is NOT a DB constraint on either dialect', async () => {
		await reset()
		await raw.prepare(`INSERT INTO roles (app, role_key, name, permissions, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.bind('opice', 'editor', 'Editor', 'not json', 'app', now())
			.run()
		// `origin`, by contrast, IS constrained: `CHECK (x IN (...))` is portable, so it stayed.
		await expect(
			raw.prepare(`INSERT INTO roles (app, role_key, name, permissions, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
				.bind('opice', 'viewer', 'Viewer', '[]', 'bogus', now())
				.run(),
		).rejects.toThrow()
	})

	test('credential_grants cascade-delete with their credential', async () => {
		await reset()
		const p = await db.createUser('sub-casc', 'casc@x.cz')
		const id = await db.createCredential({ tokenHash: 'h-casc', issuedBy: p.id, grants: [{ action: 'report.read' }] })
		expect(await db.getCredentialGrants(id)).toHaveLength(1)
		await raw.prepare('DELETE FROM credentials WHERE id = ?').bind(id).run()
		expect(await db.getCredentialGrants(id)).toHaveLength(0)
	})
})

describe.skipIf(!hasPostgres)('src/db.ts — the whole query surface, unmodified, on Postgres', () => {
	test('principals: create, claim, lookup, search, refresh, disable/enable, delete', async () => {
		await reset()
		const created = await db.createUser('sub-1', 'alice@x.cz')
		// The seconds-valued columns decode as numbers — the reason they are int4 and not bigint.
		expect(typeof created.created_at).toBe('number')
		expect(created.disabled_at).toBeNull()

		expect((await db.getUserByExternalId('sub-1'))?.id).toBe(created.id)
		expect((await db.getUserByEmail('alice@x.cz'))?.id).toBe(created.id)
		expect((await db.getPrincipalById(created.id))?.label).toBe('alice@x.cz')
		expect(await db.getServiceByExternalId('sub-1')).toBeNull()

		// LOWER() on both sides: Postgres LIKE is case-SENSITIVE where SQLite's folds ASCII.
		expect((await db.listPrincipals({ q: 'ALICE' })).map((p) => p.id)).toEqual([created.id])
		expect(await db.listPrincipals({ type: 'service' })).toHaveLength(0)

		// `IS DISTINCT FROM` (not SQLite's `IS NOT <expr>`) — a no-op when nothing changed.
		await db.refreshUserLabel(created.id, 'alice2@x.cz')
		expect((await db.getPrincipalById(created.id))?.email).toBe('alice2@x.cz')

		const invited = await db.inviteUser('bob@x.cz')
		expect(invited.external_id).toBeNull()
		const claimed = await db.claimInvitedUser(invited.id, 'sub-bob', 'bob@x.cz')
		expect(claimed?.external_id).toBe('sub-bob')
		// The guard is single-shot: a second claim of the same row matches nothing.
		expect(await db.claimInvitedUser(invited.id, 'sub-bob2', 'bob@x.cz')).toBeNull()

		const service = await db.createService('ci-runner')
		expect(service.type).toBe('service')

		expect(await db.disablePrincipal(created.id)).toBe(true)
		expect(await db.disablePrincipal(created.id)).toBe(false) // guarded UPDATE → changes 0
		expect(await db.enablePrincipal(created.id)).toBe(true)
		expect(await db.enablePrincipal(created.id)).toBe(false)
		expect(await db.deletePrincipal(created.id)).toBe(true)
		expect(await db.deletePrincipal(created.id)).toBe(false)
	})

	test('grants: create, list, expiry filtering, app filtering, delete, cascade', async () => {
		await reset()
		const p = await db.createUser('sub-g', 'g@x.cz')
		const past = now() - 60
		const future = now() + 3600

		const global = await db.createGrant({ principalId: p.id, roleKey: 'admin' })
		await db.createGrant({ principalId: p.id, roleKey: 'editor', app: 'opice' })
		await db.createGrant({ principalId: p.id, roleKey: 'viewer', app: 'poplach', expiresAt: past })
		await db.createGrant({ principalId: p.id, roleKey: 'auditor', app: 'opice', expiresAt: future })

		expect(await db.listGrants(p.id)).toHaveLength(4)
		expect(await db.getActiveGrants(p.id)).toHaveLength(3) // the expired one drops out
		expect((await db.getActiveGrantsForApp(p.id, 'opice')).map((g) => g.role_key).sort()).toEqual(['admin', 'auditor', 'editor'])
		// A null app is fail-safe: only cross-app (NULL) grants match.
		expect((await db.getActiveGrantsForApp(p.id, null)).map((g) => g.role_key)).toEqual(['admin'])
		expect((await db.getGrantById(global.id))?.role_key).toBe('admin')

		expect(await db.deleteGrant(global.id)).toBe(true)
		expect(await db.deleteGrant(global.id)).toBe(false)
		await db.deleteGrantsForPrincipal(p.id)
		expect(await db.listGrants(p.id)).toHaveLength(0)

		// The FK cascade: deleting the principal takes its grants with it.
		await db.createGrant({ principalId: p.id, roleKey: 'admin' })
		await db.deletePrincipal(p.id)
		expect(await db.listGrants(p.id)).toHaveLength(0)
	})

	test('getPrincipalsForApp returns the app roster (users only, DISTINCT, ordered)', async () => {
		await reset()
		const alice = await db.createUser('sub-a', 'alice@x.cz')
		const bob = await db.createUser('sub-b', 'bob@x.cz')
		const svc = await db.createService('machine')
		await db.createGrant({ principalId: alice.id, roleKey: 'editor', app: 'opice' })
		// Two grants for one principal must still yield ONE row — that is what DISTINCT is for, and
		// `SELECT DISTINCT p.*` is also what keeps `ORDER BY p.label` legal on Postgres.
		await db.createGrant({ principalId: alice.id, roleKey: 'viewer', app: 'opice', scopeType: 'team', scopeValue: 'acme' })
		await db.createGrant({ principalId: bob.id, roleKey: 'admin' })
		await db.createGrant({ principalId: svc.id, roleKey: 'editor', app: 'opice' })
		await db.createGrant({ principalId: (await db.createUser('sub-x', 'expired@x.cz')).id, roleKey: 'editor', app: 'opice', expiresAt: now() - 1 })

		const roster = await db.getPrincipalsForApp('opice')
		expect(roster.map((p) => p.email)).toEqual(['alice@x.cz', 'bob@x.cz'])
	})

	test('app vocabulary: reconcile is atomic, prunes app-origin rows and preserves custom ones', async () => {
		await reset()
		await db.upsertRole({ app: 'opice', roleKey: 'bespoke', name: 'Bespoke', permissions: ['report.export'], origin: 'custom' })

		await db.reconcileAppSchema({
			app: 'opice',
			scopes: [{ scopeType: 'team', label: 'Team' }, { scopeType: 'organization' }],
			actions: [{ action: 'project.read', description: 'read' }, { action: 'project.write' }],
			roles: [{ roleKey: 'editor', name: 'Editor', permissions: ['project.*'] }],
		})
		expect((await db.listAppScopes('opice')).map((s) => s.scope_type)).toEqual(['organization', 'team'])
		expect(await db.listActionCatalog('opice')).toEqual(['project.read', 'project.write'])
		expect((await db.listRoles('opice')).map((r) => r.role_key)).toEqual(['bespoke', 'editor'])

		// A second reconcile with a smaller set prunes the app-origin rows it dropped…
		await db.reconcileAppSchema({ app: 'opice', scopes: [], actions: [{ action: 'project.read' }], roles: [] })
		expect(await db.listAppScopes('opice')).toHaveLength(0)
		expect(await db.listActionCatalog('opice')).toEqual(['project.read'])
		// …and leaves the admin-composed policy alone.
		expect((await db.listRolesByOrigin('opice', 'custom')).map((r) => r.role_key)).toEqual(['bespoke'])
		expect(await db.listRolesByOrigin('opice', 'app')).toHaveLength(0)

		// ON CONFLICT (app, role_key) DO UPDATE — the upsert path, and its RETURNING row.
		const updated = await db.upsertRole({ app: 'opice', roleKey: 'bespoke', name: 'Renamed', permissions: [], origin: 'custom' })
		expect(updated.name).toBe('Renamed')
		expect((await db.getRole('opice', 'bespoke'))?.permissions).toBe('[]')
		expect(await db.deleteRole('opice', 'bespoke')).toBe(true)
		expect(await db.deleteRole('opice', 'bespoke')).toBe(false)

		expect(await db.listKnownApps()).toEqual(['opice'])
		expect(await db.listAppActions('opice')).toHaveLength(1)
	})

	test('credentials: batch insert with grants, validity window, revoke (single and bulk)', async () => {
		await reset()
		const p = await db.createUser('sub-c', 'c@x.cz')

		const bound = await db.createCredential({
			tokenHash: 'hash-bound',
			label: 'ci',
			principalId: p.id,
			issuedBy: p.id,
			grants: [{ action: 'report.read', scopeType: 'team', scopeValue: 'acme' }, { action: 'report.export' }],
		})
		// The credential row and its grant rows land in ONE transaction — the FK could not hold otherwise.
		expect(await db.getCredentialGrants(bound)).toHaveLength(2)
		expect((await db.getActiveCredentialByHash('hash-bound'))?.id).toBe(bound)
		expect((await db.getCredentialById(bound))?.label).toBe('ci')

		const anonymous = await db.createCredential({ tokenHash: 'hash-anon', issuedBy: p.id, grants: [{ action: 'report.read' }] })
		expect((await db.listAnonymousCredentials()).map((c) => c.id)).toEqual([anonymous])
		expect((await db.listCredentialsForPrincipal(p.id)).map((c) => c.id)).toEqual([bound])

		// Expired and revoked credentials are invisible to the resolve path.
		await db.createCredential({ tokenHash: 'hash-expired', issuedBy: p.id, expiresAt: now() - 1, grants: [] })
		expect(await db.getActiveCredentialByHash('hash-expired')).toBeNull()
		expect(await db.revokeCredential(anonymous)).toBe(true)
		expect(await db.revokeCredential(anonymous)).toBe(false)
		expect(await db.getActiveCredentialByHash('hash-anon')).toBeNull()

		expect(await db.revokeCredentialsForPrincipal(p.id)).toBe(1)
		expect(await db.revokeCredentialsForPrincipal(p.id)).toBe(0)
	})

	test('sessions: create, validity window, revoke by hash, list, prune', async () => {
		await reset()
		const p = await db.createUser('sub-s', 's@x.cz')
		const id = await db.createSession({ tokenHash: 'sess-1', principalId: p.id, idpSub: 'sub-s', email: 's@x.cz', expiresAt: now() + 3600 })
		const session = await db.getActiveSessionByHash('sess-1')
		expect(session?.id).toBe(id)
		expect(typeof session?.expires_at).toBe('number')

		await db.createSession({ tokenHash: 'sess-expired', principalId: p.id, idpSub: 'sub-s', expiresAt: now() - 1 })
		expect(await db.getActiveSessionByHash('sess-expired')).toBeNull()

		expect(await db.revokeSessionByHash('sess-1')).toBe(true)
		expect(await db.revokeSessionByHash('sess-1')).toBe(false)
		expect(await db.getActiveSessionByHash('sess-1')).toBeNull()
		expect(await db.listSessionsForPrincipal(p.id)).toHaveLength(2)

		expect(await db.pruneSessions(now())).toBe(2)
		expect(await db.listSessionsForPrincipal(p.id)).toHaveLength(0)
	})

	test('audit: write, filter, keyset-paginate, and prune the auth log', async () => {
		await reset()
		const p = await db.createUser('sub-au', 'au@x.cz')
		await db.writeAuditEvent({
			requestId: 'req-1',
			principalId: p.id,
			principalLabel: 'au@x.cz',
			app: 'opice',
			action: 'project.update',
			resourceType: 'project',
			resourceId: 'proj-1',
			diff: { name: ['old', 'new'] },
			metadata: { via: 'test' },
		})
		await db.writeAuditEvent({
			requestId: 'req-2',
			principalId: null,
			principalLabel: 'anon',
			app: 'opice',
			action: 'report.read',
			resourceType: 'report',
		})

		expect(await db.listAuditEvents({ limit: 10 })).toHaveLength(2)
		expect(await db.listAuditEvents({ limit: 10, resourceType: 'project', resourceId: 'proj-1' })).toHaveLength(1)
		expect(await db.listAuditEvents({ limit: 10, principalId: p.id })).toHaveLength(1)
		expect(await db.listAuditEvents({ limit: 10, action: 'report.read' })).toHaveLength(1)
		expect(await db.listAuditEvents({ limit: 10, requestId: 'req-1' })).toHaveLength(1)
		const [newest] = await db.listAuditEvents({ limit: 1 })
		// The cursor is the UUIDv7 id — a TEXT comparison, so it works identically on both engines.
		expect(await db.listAuditEvents({ limit: 10, before: newest?.id ?? '' })).toHaveLength(1)
		// The JSON-bearing TEXT columns round-trip verbatim; nothing in the DB parses or validates them.
		const [oldest] = await db.listAuditEvents({ limit: 10, requestId: 'req-1' })
		expect(oldest?.diff).toBe('{"name":["old","new"]}')
		expect(oldest?.metadata).toBe('{"via":"test"}')
		expect(newest?.diff).toBeNull()

		await db.writeAuthLog({ requestId: 'req-1', app: 'opice', kind: 'authenticate', principalId: p.id, decision: 'allow', reason: 'mint' })
		await db.writeAuthLog({
			requestId: 'req-2',
			app: 'opice',
			kind: 'authenticate',
			principalId: null,
			credentialId: 'cred-1',
			decision: 'deny',
			reason: 'invalid_key',
		})
		expect(await db.listAuthLog({ limit: 10, decision: 'deny' })).toHaveLength(1)
		expect(await db.listAuthLog({ limit: 10, principalId: p.id })).toHaveLength(1)
		expect(await db.listAuthLog({ limit: 10, requestId: 'req-2' })).toHaveLength(1)
		// The `before` cursor is a JS number bound against a BIGINT column — the bind that had to work.
		const [latest] = await db.listAuthLog({ limit: 1 })
		expect(await db.listAuthLog({ limit: 10, before: Number(latest?.id) })).toHaveLength(1)

		expect(await db.pruneAuthLog(now() + 60)).toBe(2)
		expect(await db.listAuthLog({ limit: 10 })).toHaveLength(0)
	})

	test('deleting a principal SETs NULL on its audit rows rather than removing them', async () => {
		await reset()
		const p = await db.createUser('sub-del', 'del@x.cz')
		await db.writeAuditEvent({ requestId: 'r', principalId: p.id, principalLabel: 'del@x.cz', app: 'opice', action: 'x.y', resourceType: 'x' })
		await db.writeAuthLog({ requestId: 'r', app: 'opice', kind: 'authenticate', principalId: p.id, decision: 'allow' })
		await db.deletePrincipal(p.id)
		// The label snapshot is why the audit trail survives the identity.
		const [event] = await db.listAuditEvents({ limit: 10 })
		expect(event?.principal_id).toBeNull()
		expect(event?.principal_label).toBe('del@x.cz')
		expect((await db.listAuthLog({ limit: 10 }))[0]?.principal_id).toBeNull()
	})
})

describe.skipIf(!hasPostgres)('the Bun entrypoint, end to end on Postgres', () => {
	const RPC_KEY = 'entrypoint-test-key-0123456789abcdef'
	const PROXY_KEY = 'entrypoint-proxy-key-0123456789abcdef'
	const BASE = 'http://localhost:18191'

	/**
	 * The runtime `node/server.ts` would build from `process.env`, assembled by hand so it binds the
	 * SCHEMA-SCOPED pool this fixture owns instead of opening a second one. Everything else — the
	 * routing, the RPC mount, the shared `handleFetch` — is exactly what runs in production.
	 */
	function runtime(): { handler: (request: Request) => Promise<Response>; drain: () => Promise<void> } {
		const tasks = createBackgroundTasks({ label: 'test' })
		const env: Env = {
			DB: raw,
			ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html>spa', { status: 200, headers: { 'content-type': 'text/html' } })) },
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			// 'local' + empty signing keys → an ephemeral signer, so the JWKS route works with no secrets.
			ENVIRONMENT: 'local',
			ISSUER: BASE,
			PROPUSTKA_SIGNING_KEYS: '',
			PROPUSTKA_PROVISIONING_KEY: '',
			SESSION_COOKIE_DOMAIN: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: '',
			OIDC_CLIENT_SECRET: 'dummy',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		const assembled: Runtime = {
			env,
			ctx: { waitUntil: tasks.waitUntil },
			config: { port: 0, assetsDir: '.', rpcKey: RPC_KEY, proxyKey: PROXY_KEY },
			shutdown: () => tasks.drain(),
		}
		return { handler: createFetchHandler(assembled), drain: () => tasks.drain() }
	}

	test('serves liveness, the JWKS, the SPA fallback and the RPC surface from one handler', async () => {
		const { handler } = runtime()

		expect((await handler(new Request(`${BASE}/healthz`))).status).toBe(200)

		// The public auth surface, unchanged from the Worker — same module, same routing.
		const jwks = await handler(new Request(`${BASE}/.well-known/jwks.json`))
		expect(jwks.status).toBe(200)
		const keys: unknown = await jwks.json()
		expect(Array.isArray(prop(keys, 'keys'))).toBe(true)

		// Anything unrouted is the SPA — the `ASSETS` binding's replacement.
		expect(await (await handler(new Request(`${BASE}/principals/abc`))).text()).toContain('spa')

		// The RPC surface is mounted BEFORE the SPA fallback could swallow it, and it is gated.
		expect((await handler(new Request(`${BASE}/rpc/getJwks`, { method: 'POST' }))).status).toBe(401)
	})

	test('an authenticated RPC call reaches the real methods and writes to Postgres', async () => {
		await reset()
		const { handler, drain } = runtime()
		const principal = await db.createUser('sub-rpc', 'rpc@x.cz')

		const res = await handler(
			new Request(`${BASE}/rpc/audit`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${RPC_KEY}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					app: 'opice',
					requestId: 'req-rpc',
					principalId: principal.id,
					principalLabel: 'rpc@x.cz',
					action: 'report.read',
					resourceType: 'report',
					resourceId: 'rep-9',
				}),
			}),
		)
		expect(res.status).toBe(204)

		// `audit` is fire-and-forget through `waitUntil`; draining is what a graceful shutdown does.
		await drain()
		const [event] = await db.listAuditEvents({ limit: 10, requestId: 'req-rpc' })
		expect(event?.action).toBe('report.read')
		expect(event?.principal_id).toBe(principal.id)
	})

	test('an unauthenticated mint attempt never touches the database', async () => {
		await reset()
		const { handler } = runtime()
		const res = await handler(
			new Request(`${BASE}/rpc/mintFromKey`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ app: 'opice', key: 'px_guess', requestId: 'req-x' }),
			}),
		)
		expect(res.status).toBe(401)
		// A mint that reached the method would have written a deny row to auth_log; nothing did.
		expect(await db.listAuthLog({ limit: 10 })).toHaveLength(0)
	})
})

describe.skipIf(!hasPostgres)('the proxy mint surface, end to end on Postgres', () => {
	// The contract in `packages/proxy/src/iam.ts` (`HttpIamGateway`), driven against a real database
	// through the real Bun handler. These paths and body shapes are load-bearing on BOTH sides: the
	// gateway maps any non-200 to `IamUnavailableError`, so a mismatch here becomes a 503 on every
	// request behind the proxy, with nothing in the message saying why.
	const PROXY_KEY = 'proxy-mint-key-0123456789abcdefghij'
	const RPC_KEY = 'proxy-mint-rpc-key-0123456789abcdef'
	const BASE = 'http://localhost:18191'

	function handler(options: { proxyKey?: string } = {}): (request: Request) => Promise<Response> {
		const tasks = createBackgroundTasks({ label: 'test' })
		const env: Env = {
			DB: raw,
			ASSETS: { fetch: () => Promise.resolve(new Response('spa')) },
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'local',
			ISSUER: BASE,
			PROPUSTKA_SIGNING_KEYS: '',
			PROPUSTKA_PROVISIONING_KEY: '',
			SESSION_COOKIE_DOMAIN: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: '',
			OIDC_CLIENT_SECRET: 'dummy',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		const assembled: Runtime = {
			env,
			ctx: { waitUntil: tasks.waitUntil },
			config: { port: 0, assetsDir: '.', rpcKey: RPC_KEY, proxyKey: options.proxyKey ?? PROXY_KEY },
			shutdown: () => tasks.drain(),
		}
		return createFetchHandler(assembled)
	}

	function mint(path: string, body: unknown, key: string | null = PROXY_KEY): Request {
		const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' })
		if (key !== null) {
			headers.set('authorization', `Bearer ${key}`)
		}
		return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
	}

	test('POST /auth/mint/session exchanges a live SSO session for a signed token', async () => {
		await reset()
		const principal = await db.createUser('sub-mint', 'mint@x.cz')
		await db.createGrant({ principalId: principal.id, roleKey: 'admin' })
		const session = 'session-plaintext-value'
		await db.createSession({
			tokenHash: await hashToken(session),
			principalId: principal.id,
			idpSub: 'sub-mint',
			email: 'mint@x.cz',
			expiresAt: now() + 3600,
		})

		const res = await handler()(mint(MINT_SESSION_PATH, { app: 'opice', session, requestId: 'req-mint-1' }))
		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		expect(prop(body, 'ok')).toBe(true)
		expect(typeof prop(body, 'token')).toBe('string')
		expect(typeof prop(body, 'expiresAt')).toBe('number')
	})

	test('POST /auth/mint/key exchanges an opaque credential for a signed token', async () => {
		await reset()
		const principal = await db.createUser('sub-key', 'key@x.cz')
		const key = 'px_opaque-credential-value'
		await db.createCredential({ tokenHash: await hashToken(key), principalId: principal.id, issuedBy: principal.id, grants: [] })

		const res = await handler()(mint(MINT_KEY_PATH, { app: 'opice', key, requestId: 'req-mint-2' }))
		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		expect(prop(body, 'ok')).toBe(true)
		expect(typeof prop(body, 'token')).toBe('string')
	})

	test('a DENIAL is a 200 result, never a status code — the gateway reads "no", not "unavailable"', async () => {
		await reset()
		const h = handler()
		for (
			const [path, body, reason] of [
				[MINT_SESSION_PATH, { app: 'opice', session: null, requestId: 'r' }, 'no_session'],
				[MINT_SESSION_PATH, { app: 'opice', session: 'nope', requestId: 'r' }, 'invalid_session'],
				[MINT_KEY_PATH, { app: 'opice', key: 'px_nope', requestId: 'r' }, 'invalid_key'],
			] as const
		) {
			const res = await h(mint(path, body))
			expect(`${path}: ${res.status}`).toBe(`${path}: 200`)
			const decoded: unknown = await res.json()
			expect(prop(decoded, 'ok')).toBe(false)
			expect(prop(decoded, 'reason')).toBe(reason)
		}
	})

	test('the surface requires the proxy key, and the MANAGEMENT key does not open it', async () => {
		await reset()
		const h = handler()
		// No credential at all.
		expect((await h(mint(MINT_SESSION_PATH, { app: 'opice', session: 'x', requestId: 'r' }, null))).status).toBe(401)
		// The management key is a DIFFERENT secret — least privilege, so it must not work here either.
		expect((await h(mint(MINT_KEY_PATH, { app: 'opice', key: 'px_x', requestId: 'r' }, RPC_KEY))).status).toBe(401)
		// Nothing reached the methods: a mint that ran would have written an auth_log deny row.
		expect(await db.listAuthLog({ limit: 10 })).toHaveLength(0)
	})

	test('an unset proxy key disables the surface entirely (404), it does not open it', async () => {
		const res = await handler({ proxyKey: '' })(mint(MINT_SESSION_PATH, { app: 'opice', session: 'x', requestId: 'r' }))
		expect(res.status).toBe(404)
	})

	test('a rejected mint still lands in the auth log, which is how a burst becomes visible', async () => {
		await reset()
		const h = handler()
		await h(mint(MINT_KEY_PATH, { app: 'opice', key: 'px_guess-1', requestId: 'req-burst' }))
		// The write is fire-and-forget through `waitUntil`; give it a turn to settle.
		await Bun.sleep(50)
		const [row] = await db.listAuthLog({ limit: 10, requestId: 'req-burst' })
		expect(row?.decision).toBe('deny')
		expect(row?.reason).toBe('invalid_key')
		expect(row?.app).toBe('opice')
	})
})

describe.skipIf(!hasPostgres)('the Bun handler never leaks internals on an unhandled throw', () => {
	test('a throwing route answers an opaque 500, not Bun default error page', async () => {
		// Bun's default error page embeds the exception message AND the surrounding source lines in the
		// response body. The Workers runtime does not, so this is the one place the two entrypoints would
		// have differed in what they show an attacker. Reproduced with an ASSETS port that throws.
		const tasks = createBackgroundTasks({ label: 'test' })
		const env: Env = {
			DB: raw,
			ASSETS: {
				fetch: () => {
					throw new Error('assets exploded with px_secret-looking-detail')
				},
			},
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'local',
			ISSUER: 'http://localhost:18191',
			PROPUSTKA_SIGNING_KEYS: '',
			PROPUSTKA_PROVISIONING_KEY: '',
			SESSION_COOKIE_DOMAIN: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: '',
			OIDC_CLIENT_SECRET: 'dummy',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		const assembled: Runtime = {
			env,
			ctx: { waitUntil: tasks.waitUntil },
			config: { port: 0, assetsDir: '.', rpcKey: '', proxyKey: '' },
			shutdown: () => tasks.drain(),
		}
		const res = await createFetchHandler(assembled)(new Request('http://localhost:18191/anything'))
		expect(res.status).toBe(500)
		const text = await res.text()
		expect(text).toBe('internal error')
		expect(text).not.toContain('px_secret')
	})
})
