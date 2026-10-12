// Durable audit (WU18), on BOTH backends: every IAM-owned change writes its `audit_events` row in the change's own
// batch, a login, a refused login and a logout write `auth_log` before the answer, and every request of an
// installation admin writes one `iam.admin.access` row before it runs. A fault is injected into the audit insert
// itself — a trigger on SQLite, a NOT VALID check constraint on Postgres — so the test proves the rollback, not a
// mocked repository. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import type { Scope } from '@fabrika/auth-core'
import { SESSION_COOKIE } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { handleAuth } from '../auth/routes'
import { handleLogout, issueSession } from '../auth/sessions'
import { runIamMaintenance } from '../cron'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import type { Env } from '../env'
import { exchangeAuthCode, issueAuthCode } from '../handoff'
import { prop } from '../json'
import { assignMember, createScope, requestDelegation, revokeMember } from '../membership'
import { pkceChallenge, randomToken } from '../oidc'
import { resolveUserPrincipal } from '../resolve'
import { hashToken } from '../secret'
import { adminTokenFor, createHarness, makeServicesFor, TEST_SIGNING_KEYS, TestSqlDatabase } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	ORIGIN,
	PendingWork,
	type Person,
} from './helpers/membership'
import { oauthFixture, tokenBody } from './helpers/oauth'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`durable-audit.test.ts ${skipReason}`)
}

interface Backend {
	readonly repositories: IamRepositories
	readonly db: SqlDatabase
	/** Make every insert into `table` whose `column` equals `value` fail, until the returned function runs. */
	fault(table: 'audit_events' | 'auth_log', column: string, value: string): Promise<() => Promise<void>>
}

function sqliteBackend(): Backend {
	const h = createHarness()
	return {
		repositories: h.repositories,
		db: new TestSqlDatabase(h.sqlite),
		fault(table, column, value) {
			h.sqlite.run(
				`CREATE TRIGGER injected_fault BEFORE INSERT ON ${table} WHEN NEW.${column} = '${value}' BEGIN SELECT RAISE(ABORT, 'injected fault'); END`,
			)
			return Promise.resolve(() => {
				h.sqlite.run('DROP TRIGGER injected_fault')
				return Promise.resolve()
			})
		},
	}
}

function postgresBackend(db: SqlDatabase): Backend {
	return {
		repositories: createPostgresIamRepositories(db),
		db,
		async fault(table, column, value) {
			await db.prepare(`ALTER TABLE ${table} ADD CONSTRAINT injected_fault CHECK (${column} <> '${value}') NOT VALID`).run()
			return async () => {
				await db.prepare(`ALTER TABLE ${table} DROP CONSTRAINT injected_fault`).run()
			}
		},
	}
}

/** The audit rows of one action about one resource. */
async function events(b: Backend, action: string, resourceId: string): Promise<{ metadata: string | null }[]> {
	const { results } = await b.db
		.prepare('SELECT metadata FROM audit_events WHERE action = ? AND resource_id = ?')
		.bind(action, resourceId)
		.all<{ metadata: string | null }>()
	return results
}

async function eventsOfRequest(b: Backend, requestId: string): Promise<{ action: string; resource_id: string | null; app: string }[]> {
	const { results } = await b.db
		.prepare('SELECT action, resource_id, app FROM audit_events WHERE request_id = ? ORDER BY id')
		.bind(requestId)
		.all<{ action: string; resource_id: string | null; app: string }>()
	return results
}

async function authLogOf(b: Backend, requestId: string): Promise<{ kind: string; decision: string; reason: string | null; privileged: number }[]> {
	const { results } = await b.db
		.prepare('SELECT kind, decision, reason, privileged FROM auth_log WHERE request_id = ? ORDER BY id')
		.bind(requestId)
		.all<{ kind: string; decision: string; reason: string | null; privileged: number }>()
	return results
}

function env(repositories: IamRepositories): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	}
}

let seq = 0
function unique(prefix: string): string {
	seq += 1
	return `${prefix}-${seq}-${crypto.randomUUID().slice(0, 8)}`
}

interface Admin {
	readonly id: string
	call(method: string, input: unknown, requestId: string): Promise<Response>
	get(path: string, requestId: string): Promise<Response>
	send(method: string, path: string, requestId: string): Promise<Response>
}

async function admin(b: Backend): Promise<Admin> {
	const tag = unique('admin')
	const user = await b.repositories.principals.createUser(`sub-${tag}`, `${tag}@example.test`)
	await b.repositories.grants.createGrant({ principalId: user.id, roleKey: 'admin' })
	const bearer = await adminTokenFor(b.repositories, user.id, { issuer: ORIGIN })
	const app = createIamApp({ requestIdHeader: 'x-request-id' })
	const send = (request: Request) => app.fetch(request, env(b.repositories), { waitUntil() {} })
	return {
		id: user.id,
		call: (method, input, requestId) =>
			send(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'x-request-id': requestId },
					body: JSON.stringify({ method, input }),
				}),
			),
		get: (path, requestId) => send(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${bearer}`, 'x-request-id': requestId } })),
		send: (method, path, requestId) =>
			send(new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'x-request-id': requestId } })),
	}
}

async function delegated(f: MembershipFixture, person: Person, endpoint = INVITE_ENDPOINT) {
	const call = { app: APP, credential: await person.token(), requestId: unique('req') }
	const result = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...call, endpoint })
	if (!result.ok) throw new Error(`no delegation: ${result.reason}`)
	return { ...call, delegation: result.grant }
}

async function workspaceOf(f: MembershipFixture, owner: Person): Promise<Scope> {
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!result.ok) throw new Error(`no workspace: ${result.reason}`)
	return result.scope
}

function durableAuditSuite(backend: () => Backend): void {
	describe('membership', () => {
		test('a fault in the audit insert rolls back the assignment; a committed one has exactly one row', async () => {
			const b = backend()
			const f = await membershipFixture(b.repositories)
			const owner = await f.person(unique('owner'))
			const editor = await f.person(unique('editor'))
			const scope = await workspaceOf(f, owner)
			const assign = async () =>
				assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role: 'editor', member: { principalId: editor.id } })
			const scopeId = `${scope.type}:${scope.value}`

			const restore = await b.fault('audit_events', 'action', 'iam.member.assign')
			const faulted = await assign().catch((err: unknown) => err)
			await restore()
			expect(faulted).toBeInstanceOf(Error)
			expect(await f.repositories.membership.listRoleGrantsAt(APP, editor.id, scope)).toEqual([])
			expect(await events(b, 'iam.member.assign', scopeId)).toEqual([])

			expect((await assign()).ok).toBe(true)
			// A repeat is a held role: no change, so no second row.
			expect((await assign()).ok).toBe(true)
			expect((await f.repositories.membership.listRoleGrantsAt(APP, editor.id, scope)).map((grant) => grant.role_key)).toEqual(['editor'])
			expect(await events(b, 'iam.member.assign', scopeId)).toHaveLength(1)
		})

		test('a revoke records each role it removed once, and a repeated revoke records nothing', async () => {
			const b = backend()
			const f = await membershipFixture(b.repositories)
			const owner = await f.person(unique('owner'))
			const editor = await f.person(unique('editor'))
			const scope = await workspaceOf(f, owner)
			const scopeId = `${scope.type}:${scope.value}`
			for (const role of ['editor', 'manager']) {
				await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role, member: { principalId: editor.id } })
			}
			const revoke = async () =>
				revokeMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, member: { principalId: editor.id } })

			const restore = await b.fault('audit_events', 'action', 'iam.member.revoke')
			expect(await revoke().catch((err: unknown) => err)).toBeInstanceOf(Error)
			await restore()
			expect((await f.repositories.membership.listRoleGrantsAt(APP, editor.id, scope)).map((grant) => grant.role_key)).toEqual(['editor', 'manager'])

			expect(await revoke()).toEqual({ ok: true })
			expect(await revoke()).toEqual({ ok: true })
			const rows = await events(b, 'iam.member.revoke', scopeId)
			expect(rows.map((row) => prop(JSON.parse(row.metadata ?? 'null'), 'role')).sort()).toEqual(['editor', 'manager'])
		})

		test('the last creator keeps every role, and nothing is recorded', async () => {
			const b = backend()
			const f = await membershipFixture(b.repositories)
			const owner = await f.person(unique('owner'))
			const scope = await workspaceOf(f, owner)
			await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role: 'manager', member: { principalId: owner.id } })

			const result = await revokeMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, member: { principalId: owner.id } })
			expect(result).toEqual({ ok: false, reason: 'last_creator' })
			expect((await f.repositories.membership.listRoleGrantsAt(APP, owner.id, scope)).map((grant) => grant.role_key)).toEqual(['manager', 'owner'])
			expect(await events(b, 'iam.member.revoke', `${scope.type}:${scope.value}`)).toEqual([])
		})
	})

	describe('administration', () => {
		test('a fault in the audit insert rolls back an admin grant; a committed grant has exactly one row', async () => {
			const b = backend()
			const a = await admin(b)
			const grantee = await b.repositories.principals.createUser(`sub-${unique('grantee')}`, `${unique('grantee')}@example.test`)
			const grant = { principalId: grantee.id, roleKey: 'admin', app: null }

			const restore = await b.fault('audit_events', 'action', 'iam.grant.create')
			const faulted = await a.call('grants.create', grant, unique('req'))
			await restore()
			expect(faulted.status).toBe(500)
			expect(await b.repositories.grants.listGrants(grantee.id)).toEqual([])

			const requestId = unique('req')
			const created = await a.call('grants.create', grant, requestId)
			expect(created.status).toBe(200)
			const id = prop(prop(await created.json(), 'result'), 'id')
			if (typeof id !== 'string') throw new Error('expected a grant id')
			expect(await events(b, 'iam.grant.create', id)).toHaveLength(1)
			// One mutation event, and the extra privileged-access event of the same request.
			expect((await eventsOfRequest(b, requestId)).map((row) => row.action)).toEqual(['iam.admin.access', 'iam.grant.create'])
		})

		test('an admin read writes one access row, naming the route and the procedure, under the gateway app', async () => {
			const b = backend()
			await membershipFixture(b.repositories)
			const a = await admin(b)
			const requestId = unique('req')
			expect((await a.call('principals.list', {}, requestId)).status).toBe(200)
			expect(await eventsOfRequest(b, requestId)).toEqual([{ action: 'iam.admin.access', resource_id: '/admin/rpc#principals.list', app: 'vozka' }])

			const schemaRead = unique('req')
			expect((await a.get(`/admin/apps/${encodeURIComponent('notes@prod')}/schema`, schemaRead)).status).toBe(200)
			expect(await eventsOfRequest(b, schemaRead)).toEqual([{ action: 'iam.admin.access', resource_id: '/admin/apps/:app/schema', app: 'vozka' }])
		})

		test('an admin request whose access cannot be recorded does not run', async () => {
			const b = backend()
			const a = await admin(b)
			const grantee = await b.repositories.principals.createUser(`sub-${unique('grantee')}`, `${unique('grantee')}@example.test`)
			const restore = await b.fault('audit_events', 'action', 'iam.admin.access')
			const refused = await a.call('grants.create', { principalId: grantee.id, roleKey: 'admin', app: null }, unique('req'))
			await restore()
			expect(refused.status).toBe(503)
			expect(await b.repositories.grants.listGrants(grantee.id)).toEqual([])
		})

		test('a no-op change records nothing: revoking a revoked session, disabling a disabled principal', async () => {
			const b = backend()
			const a = await admin(b)
			const target = await b.repositories.principals.createUser(`sub-${unique('target')}`, `${unique('target')}@example.test`)
			const sessionId = await b.repositories.sessions.createSession({
				tokenHash: await hashToken(unique('token')),
				principalId: target.id,
				idpSub: 'sub',
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			})

			for (let attempt = 0; attempt < 2; attempt++) {
				expect((await a.call('sessions.revoke', { id: sessionId }, unique('req'))).status).toBe(200)
				expect((await a.call('principals.update', { principalId: target.id, disabled: true }, unique('req'))).status).toBe(200)
			}
			expect(await events(b, 'iam.session.revoke', sessionId)).toHaveLength(1)
			expect(await events(b, 'iam.principal.disable', target.id)).toHaveLength(1)
		})

		test('a fault rolls back a provisioned API key whole: no principal, grant or credential survives', async () => {
			const b = backend()
			const a = await admin(b)
			const label = unique('svc')
			const restore = await b.fault('audit_events', 'action', 'iam.apikey.create')
			const faulted = await a.call('apiKeys.provision', { label, type: 'service', roleKey: 'admin', app: null }, unique('req'))
			await restore()
			expect(faulted.status).toBe(500)
			const { results } = await b.db.prepare('SELECT id FROM principals WHERE label = ?').bind(label).all()
			expect(results).toEqual([])
		})
	})

	test('the retention settings prune auth_log and audit_events at their values', async () => {
		const b = backend()
		const tag = unique('retention')
		const day = 24 * 60 * 60
		const now = Math.floor(Date.now() / 1000)
		for (const age of [5, 9, 40]) {
			await b.db
				.prepare(`INSERT INTO auth_log (request_id, app, kind, principal_id, credential_id, decision, reason, privileged, created_at)
					VALUES (?, 'opice', 'authenticate', NULL, NULL, 'allow', NULL, 0, ?)`)
				.bind(tag, now - age * day)
				.run()
			await b.db
				.prepare(`INSERT INTO audit_events (id, request_id, principal_id, principal_label, app, action, resource_type, created_at)
					VALUES (?, ?, NULL, 'seed', 'opice', 'seed.event', 'seed', ?)`)
				.bind(unique('event'), tag, now - age * day)
				.run()
		}
		const settled: Promise<unknown>[] = []
		runIamMaintenance(
			{ ...env(b.repositories), AUTH_LOG_RETENTION_DAYS: '7', AUDIT_RETENTION_DAYS: '30' },
			{ waitUntil: (promise) => settled.push(promise) },
		)
		await Promise.all(settled)
		expect(await authLogOf(b, tag)).toHaveLength(1)
		expect(await eventsOfRequest(b, tag)).toHaveLength(2)
	})

	describe('every change of security state carries its own record', () => {
		test('a password completion records itself; a fault in the record leaves the token unspent and no credential', async () => {
			const b = backend()
			const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
			await b.repositories.passwords.enableEnrollment(user.id)
			const tokenHash = await hashToken(unique('action'))
			await b.repositories.passwords.issueActionToken({
				principalId: user.id,
				purpose: 'enrollment',
				tokenHash,
				expiresAt: Math.floor(Date.now() / 1000) + 600,
			})
			const password = { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: 'hash' }
			const complete = () =>
				b.repositories.passwords.completeAction({ tokenHash, purpose: 'enrollment', password }, {
					requestId: unique('req'),
					principalId: user.id,
					principalLabel: user.id,
					app: 'propustka',
					action: 'iam.password.enrollment.complete',
					resourceType: 'principal',
					resourceId: user.id,
				})

			const restore = await b.fault('audit_events', 'action', 'iam.password.enrollment.complete')
			expect(await complete().catch((err: unknown) => err)).toBeInstanceOf(Error)
			await restore()
			expect(await b.repositories.passwords.getCredential(user.id)).toBeNull()

			expect(await complete()).toEqual({ principalId: user.id })
			expect(await complete()).toBeNull()
			expect(await events(b, 'iam.password.enrollment.complete', user.id)).toHaveLength(1)
		})

		test('a password rehash records itself in its own batch', async () => {
			const b = backend()
			const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
			const event = {
				requestId: unique('req'),
				principalId: user.id,
				principalLabel: user.id,
				app: 'propustka',
				action: 'iam.password.rehash',
				resourceType: 'principal',
				resourceId: user.id,
			}
			const restore = await b.fault('audit_events', 'action', 'iam.password.rehash')
			const faulted = await b.repositories.passwords.upsertCredential(
				user.id,
				{ algorithm: 'test', parameters: '{}', salt: 's', passwordHash: 'h' },
				event,
			).catch((err: unknown) => err)
			await restore()
			expect(faulted).toBeInstanceOf(Error)
			expect(await b.repositories.passwords.getCredential(user.id)).toBeNull()
		})

		test('an OIDC login creates, claims and refreshes its principal with one record each, and a fault creates nothing', async () => {
			const b = backend()
			const sub = `sub-${unique('oidc')}`
			const email = `${unique('oidc')}@example.test`
			const restore = await b.fault('audit_events', 'action', 'iam.principal.create')
			expect(await resolveUserPrincipal(b.repositories.principals, sub, email, unique('req'))).toEqual({ ok: false, reason: 'unknown_principal' })
			await restore()
			expect(await b.repositories.principals.getUserByExternalId(sub)).toBeNull()

			const created = await resolveUserPrincipal(b.repositories.principals, sub, email, unique('req'))
			if (!created.ok) throw new Error('expected a principal')
			expect(await events(b, 'iam.principal.create', created.principal.id)).toHaveLength(1)
			// The same identity again changes nothing and records nothing; a new mailbox is a refresh.
			await resolveUserPrincipal(b.repositories.principals, sub, email, unique('req'))
			await resolveUserPrincipal(b.repositories.principals, sub, `moved-${email}`, unique('req'))
			expect(await events(b, 'iam.principal.refresh', created.principal.id)).toHaveLength(1)

			const invitedEmail = `${unique('invited')}@example.test`
			const invited = await b.repositories.principals.inviteUser(invitedEmail)
			expect((await resolveUserPrincipal(b.repositories.principals, `sub-${unique('claim')}`, invitedEmail, unique('req'))).ok).toBe(true)
			expect(await events(b, 'iam.principal.claim', invited.id)).toHaveLength(1)
		})

		test("a first workload key creates its principal in the key's transaction; a fault leaves no principal", async () => {
			const b = backend()
			const a = await admin(b)
			const name = `job_${unique('w').replaceAll('-', '_')}`
			const issue = (requestId: string) =>
				a.call('workloads.issueKey', { app: 'notes@prod', kind: 'job', name, expiresAt: Math.floor(Date.now() / 1000) + 3600, keep: null }, requestId)

			const restore = await b.fault('audit_events', 'action', 'iam.workload.key.issue')
			expect((await issue(unique('req'))).status).toBe(500)
			await restore()
			expect(await b.repositories.workloads.findPrincipal('notes@prod', 'job', name)).toBeNull()
			const { results } = await b.db.prepare('SELECT principal_id FROM workload_principals WHERE name = ?').bind(name).all()
			expect(results).toEqual([])

			const issued = await issue(unique('req'))
			expect(issued.status).toBe(200)
			const principalId = prop(prop(await issued.json(), 'result'), 'principalId')
			if (typeof principalId !== 'string') throw new Error('expected a principal id')
			expect(await events(b, 'iam.workload.key.issue', principalId)).toHaveLength(1)
		})

		test('a bulk revocation that revokes nothing records nothing: workload keys, an API key', async () => {
			const b = backend()
			const a = await admin(b)
			const name = `job_${unique('w').replaceAll('-', '_')}`
			const workload = { app: 'notes@prod', kind: 'job', name }
			expect((await a.call('workloads.issueKey', { ...workload, expiresAt: Math.floor(Date.now() / 1000) + 3600, keep: null }, unique('req'))).status)
				.toBe(200)
			const provisioned = await a.call('apiKeys.provision', { label: unique('svc'), type: 'service', roleKey: 'admin', app: null }, unique('req'))
			const apiKeyPrincipal = prop(prop(await provisioned.json(), 'result'), 'principalId')
			if (typeof apiKeyPrincipal !== 'string') throw new Error('expected a principal id')

			for (let attempt = 0; attempt < 2; attempt++) {
				expect((await a.call('workloads.revokeKeys', workload, unique('req'))).status).toBe(200)
				expect((await a.call('apiKeys.revoke', { principalId: apiKeyPrincipal }, unique('req'))).status).toBe(200)
			}
			const workloadPrincipal = await b.repositories.workloads.findPrincipalId('notes@prod', 'job', name)
			expect(await events(b, 'iam.workload.key.revoke', workloadPrincipal ?? '')).toHaveLength(1)
			expect(await events(b, 'iam.apikey.revoke', apiKeyPrincipal)).toHaveLength(1)
		})

		test('an audit row holds no email: the admin is labelled by its id, and an invitation names no address', async () => {
			const b = backend()
			const a = await admin(b)
			const requestId = unique('req')
			const email = `${unique('invitee')}@example.test`
			expect((await a.call('principals.invite', { email }, requestId)).status).toBe(200)
			const { results } = await b.db
				.prepare('SELECT principal_label, metadata FROM audit_events WHERE request_id = ?')
				.bind(requestId)
				.all<{ principal_label: string; metadata: string | null }>()
			expect(results).toHaveLength(2)
			for (const row of results) {
				expect(row.principal_label).toBe(a.id)
				expect(row.metadata ?? '').not.toContain('@')
			}
		})

		test('a malformed password login is a logged refusal, and one that cannot be logged answers 503', async () => {
			const b = backend()
			const services = makeServicesFor(b.repositories, { environment: 'stage', issuer: ORIGIN, authentication: { oidc: false, password: true } })
			const login = (requestId: string) =>
				handleAuth(
					new Request(`${ORIGIN}/auth/login`, {
						method: 'POST',
						headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({ email: 'not an address', password: 'whatever' }),
					}),
					services,
					{ FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS, ENVIRONMENT: 'stage' },
					{ waitUntil() {} },
					null,
					requestId,
				)
			const requestId = unique('req')
			expect((await login(requestId)).status).toBe(401)
			expect(await authLogOf(b, requestId)).toEqual([{ kind: 'authenticate', decision: 'deny', reason: 'password_malformed', privileged: 0 }])

			const restore = await b.fault('auth_log', 'reason', 'password_malformed')
			expect((await login(unique('req'))).status).toBe(503)
			await restore()
		})
	})

	describe('public recovery, handoff redemption, and every admin route', () => {
		function recoveryServices(b: Backend, email: CapturingEmail, bootstrapAdmins: string[] = []) {
			return makeServicesFor(b.repositories, {
				environment: 'stage',
				issuer: ORIGIN,
				authentication: { oidc: false, password: true },
				email,
				bootstrapAdmins: new Set(bootstrapAdmins),
			})
		}

		async function forgot(b: Backend, services: ReturnType<typeof recoveryServices>, address: string, requestId: string): Promise<void> {
			const pending = new PendingWork()
			const response = await handleAuth(
				new Request(`${ORIGIN}/auth/forgot-password`, {
					method: 'POST',
					headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ email: address }),
				}),
				services,
				{ FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS, ENVIRONMENT: 'stage' },
				pending,
				null,
				requestId,
			)
			expect(response.status).toBe(200)
			await Promise.allSettled(pending.pending)
		}

		async function tokensOf(b: Backend, principalId: string): Promise<number> {
			const { results } = await b.db.prepare('SELECT id FROM password_action_tokens WHERE principal_id = ?').bind(principalId).all()
			return results.length
		}

		test('a recovery request issues its reset token with its record; a fault issues nothing', async () => {
			const b = backend()
			const address = `${unique('reset')}@example.test`
			const user = await b.repositories.principals.createUser(`sub-${unique('reset')}`, address)
			await b.repositories.passwords.upsertCredential(user.id, { algorithm: 'test', parameters: '{}', salt: 's', passwordHash: 'h' })
			const services = recoveryServices(b, new CapturingEmail())

			const restore = await b.fault('audit_events', 'action', 'iam.password.reset.issue')
			await forgot(b, services, address, unique('req'))
			await restore()
			expect(await tokensOf(b, user.id)).toBe(0)

			await forgot(b, services, address, unique('req'))
			expect(await tokensOf(b, user.id)).toBe(1)
			expect(await events(b, 'iam.password.reset.issue', user.id)).toHaveLength(1)
		})

		test("a bootstrap admin's recovery opts it into enrollment in its token's batch; a fault leaves no account", async () => {
			const b = backend()
			const address = `${unique('boot')}@example.test`
			const services = recoveryServices(b, new CapturingEmail(), [address])

			const restore = await b.fault('audit_events', 'action', 'iam.password.enrollment.issue')
			await forgot(b, services, address, unique('req'))
			await restore()
			const principal = await b.repositories.principals.getUserByEmail(address)
			if (principal === null) throw new Error('expected the bootstrap principal')
			expect(await events(b, 'iam.principal.bootstrap', principal.id)).toHaveLength(1)
			expect(await b.repositories.passwords.getAccount(principal.id)).toBeNull()
			expect(await tokensOf(b, principal.id)).toBe(0)

			await forgot(b, services, address, unique('req'))
			expect((await b.repositories.passwords.getAccount(principal.id))?.state).toBe('pending')
			expect(await tokensOf(b, principal.id)).toBe(1)
			expect(await events(b, 'iam.password.enrollment.issue', principal.id)).toHaveLength(1)
		})

		test('a handoff redemption opens its child session with its auth_log row; a fault opens none', async () => {
			const b = backend()
			const services = recoveryServices(b, new CapturingEmail())
			const user = await b.repositories.principals.createUser(`sub-${unique('handoff')}`, `${unique('handoff')}@example.test`)
			const parentId = await b.repositories.sessions.createSession({
				tokenHash: await hashToken(unique('token')),
				principalId: user.id,
				idpSub: 'sub',
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			})
			const redeem = async (requestId: string) => {
				const verifier = randomToken(32)
				const { code } = await issueAuthCode(services, {
					app: APP,
					parentSessionId: parentId,
					returnUrl: 'https://notes.example/',
					challenge: await pkceChallenge(verifier),
				})
				return exchangeAuthCode(services, { app: APP, code, verifier, requestId })
			}
			const children = async () => (await b.repositories.sessions.listSessionsForPrincipal(user.id, { limit: 10 })).filter((row) => row.app !== null)

			const restore = await b.fault('auth_log', 'reason', 'handoff')
			expect(await redeem(unique('req')).catch((err: unknown) => err)).toBeInstanceOf(Error)
			await restore()
			expect(await children()).toEqual([])

			const requestId = unique('req')
			expect((await redeem(requestId)).result.ok).toBe(true)
			expect(await children()).toHaveLength(1)
			expect(await authLogOf(b, requestId)).toEqual([{ kind: 'authenticate', decision: 'allow', reason: 'handoff', privileged: 0 }])
		})

		test('an OAuth consent records its grant; a fault grants nothing; a revocation records once', async () => {
			const b = backend()
			const f = await oauthFixture(b.repositories)
			try {
				const grantsOf = async () =>
					(await b.db.prepare('SELECT id FROM oauth_grants WHERE principal_id = ?').bind(f.principal.id).all<{ id: string }>()).results
				const restore = await b.fault('audit_events', 'action', 'iam.oauth.grant.create')
				expect(await f.approve().catch((err: unknown) => err)).toBeInstanceOf(Error)
				await restore()
				expect(await grantsOf()).toEqual([])

				const first = await tokenBody(await f.exchange(await f.approve()))
				const [grant] = await grantsOf()
				if (grant === undefined) throw new Error('expected a grant')
				expect(await events(b, 'iam.oauth.grant.create', grant.id)).toHaveLength(1)
				for (let attempt = 0; attempt < 2; attempt++) {
					expect((await f.post('/oauth/revoke', { client_id: f.clientId, token: first.refresh_token ?? '' })).status).toBe(200)
				}
				expect(await events(b, 'iam.oauth.grant.revoke', grant.id)).toHaveLength(1)
			} finally {
				f.restoreFetch()
			}
		})

		test("an admin's refused route still writes its access row, under a fixed template", async () => {
			const b = backend()
			const a = await admin(b)
			const methodRefused = unique('req')
			expect((await a.send('POST', '/admin/apps/notes%40prod/schema', methodRefused)).status).toBe(405)
			expect(await eventsOfRequest(b, methodRefused)).toEqual([{ action: 'iam.admin.access', resource_id: '/admin/apps/:app/schema', app: 'vozka' }])
			const unmatched = unique('req')
			expect((await a.send('GET', '/admin/secret-path/x', unmatched)).status).toBe(404)
			expect(await eventsOfRequest(b, unmatched)).toEqual([{ action: 'iam.admin.access', resource_id: '/admin/*', app: 'vozka' }])
		})

		test('an oversized or cross-origin password form is a logged refusal', async () => {
			const b = backend()
			const services = recoveryServices(b, new CapturingEmail())
			const post = (requestId: string, body: string, origin: string) =>
				handleAuth(
					new Request(`${ORIGIN}/auth/login`, {
						method: 'POST',
						headers: { origin, 'sec-fetch-site': origin === ORIGIN ? 'same-origin' : 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
						body,
					}),
					services,
					{ FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS, ENVIRONMENT: 'stage' },
					{ waitUntil() {} },
					null,
					requestId,
				)
			const oversized = unique('req')
			expect((await post(oversized, `email=a%40example.test&password=x&padding=${'p'.repeat(20_000)}`, ORIGIN)).status).toBe(400)
			expect(await authLogOf(b, oversized)).toEqual([{ kind: 'authenticate', decision: 'deny', reason: 'password_malformed', privileged: 0 }])
			const crossOrigin = unique('req')
			expect((await post(crossOrigin, 'email=a%40example.test&password=x', 'https://evil.example')).status).toBe(403)
			expect(await authLogOf(b, crossOrigin)).toEqual([{ kind: 'authenticate', decision: 'deny', reason: 'login_cross_origin', privileged: 0 }])
		})
	})

	describe('logins and logouts', () => {
		async function login(b: Backend, principalId: string, requestId: string): Promise<Response> {
			const services = (await membershipFixture(b.repositories)).services
			return issueSession(new Request(`${ORIGIN}/auth/login`), services, { waitUntil() {} }, {
				principalId,
				email: null,
				authenticationMethod: 'password',
				redirect: ORIGIN,
				reason: 'password_login',
				requestId,
			})
		}

		test('a login writes its auth_log row with the session; a fault opens no session and answers 503', async () => {
			const b = backend()
			const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
			const restore = await b.fault('auth_log', 'kind', 'authenticate')
			const faulted = await login(b, user.id, unique('req'))
			await restore()
			expect(faulted.status).toBe(503)
			expect(await b.repositories.sessions.listSessionsForPrincipal(user.id, { limit: 10 })).toEqual([])

			const requestId = unique('req')
			expect((await login(b, user.id, requestId)).status).toBe(302)
			expect(await authLogOf(b, requestId)).toEqual([{ kind: 'authenticate', decision: 'allow', reason: 'password_login', privileged: 0 }])
		})

		test('the login of an installation admin is marked privileged', async () => {
			const b = backend()
			const a = await admin(b)
			const requestId = unique('req')
			expect((await login(b, a.id, requestId)).status).toBe(302)
			expect(await authLogOf(b, requestId)).toEqual([{ kind: 'authenticate', decision: 'allow', reason: 'password_login', privileged: 1 }])
		})

		test('a logout writes one logout row with the revocation, and a fault leaves the session live', async () => {
			const b = backend()
			const services = (await membershipFixture(b.repositories)).services
			const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
			const token = unique('token')
			await b.repositories.sessions.createSession({
				tokenHash: await hashToken(token),
				principalId: user.id,
				email: null,
				authenticationMethod: 'password',
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			})
			const logout = (requestId: string) =>
				handleLogout(
					new Request(`${ORIGIN}/auth/logout`, {
						method: 'POST',
						headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: `${SESSION_COOKIE}=${token}` },
					}),
					services,
					requestId,
				)

			const restore = await b.fault('auth_log', 'kind', 'logout')
			expect((await logout(unique('req'))).status).toBe(503)
			await restore()
			expect(await b.repositories.sessions.getActiveSessionByHash(await hashToken(token))).not.toBeNull()

			const requestId = unique('req')
			expect((await logout(requestId)).status).toBe(302)
			expect(await logout(unique('req'))).toHaveProperty('status', 302)
			expect(await authLogOf(b, requestId)).toEqual([{ kind: 'logout', decision: 'allow', reason: 'logout', privileged: 0 }])
			expect(await b.repositories.sessions.getActiveSessionByHash(await hashToken(token))).toBeNull()
		})
	})
}

describe('durable audit — SQLite', () => {
	durableAuditSuite(sqliteBackend)
})

let fixture: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let postgres: Backend | null = null

beforeAll(async () => {
	if (!hasPostgres || postgresUrl === null) return
	fixture = await createPostgres('iam_durable_audit')
	// A pool of its own, as the service runs: the maintenance sweep issues its prunes concurrently.
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 4 })
	postgres = postgresBackend(pool)
})

afterAll(async () => {
	await pool?.close()
	await fixture?.close()
})

describe.skipIf(!hasPostgres)('durable audit — Postgres', () => {
	durableAuditSuite(() => {
		if (postgres === null) throw new Error('postgres backend not ready')
		return postgres
	})
})

describe.skipIf(!hasPostgres)('durable audit — concurrent guarded changes on Postgres', () => {
	/** The audit rows written under one request id — one call's record. */
	async function recorded(b: Backend, requestId: string): Promise<number> {
		return (await eventsOfRequest(b, requestId)).length
	}

	function event(action: string, resourceId: string) {
		return { requestId: unique('req'), principalId: null, principalLabel: 'test', app: 'propustka', action, resourceType: 'test', resourceId }
	}

	test('a bulk session revocation racing new logins records exactly when it revoked something', async () => {
		if (postgres === null) throw new Error('postgres backend not ready')
		const b = postgres
		const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
		const login = async () =>
			b.repositories.sessions.createSession({
				tokenHash: await hashToken(unique('token')),
				principalId: user.id,
				idpSub: 'sub',
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			})
		for (let round = 0; round < 20; round++) {
			const revocation = event('test.session.revoke_all', user.id)
			const [, revoked] = await Promise.all([login(), b.repositories.sessions.revokeSessionsForPrincipal(user.id, revocation)])
			expect(await recorded(b, revocation.requestId)).toBe(revoked > 0 ? 1 : 0)
		}
	})

	test('a membership assignment racing an admin grant of the same role: each call records exactly its own change', async () => {
		if (postgres === null) throw new Error('postgres backend not ready')
		const b = postgres
		const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
		const scope = { type: 'workspace', value: unique('ws') }
		for (let round = 0; round < 10; round++) {
			const membershipEvent = event('test.member.assign', scope.value)
			const adminEvent = event('test.grant.create', scope.value)
			const [assigned, granted] = await Promise.all([
				b.repositories.membership.grantMembershipRole({ app: APP, principalId: user.id, roleKey: 'editor', scope, grantedBy: user.id }, membershipEvent),
				b.repositories.grants.createRoleGrantUnlessHeld(
					{ principalId: user.id, app: APP, roleKey: 'editor', scopeType: scope.type, scopeValue: scope.value },
					() => adminEvent,
				),
			])
			expect([assigned !== null, granted !== null].filter(Boolean)).toHaveLength(1)
			expect(await recorded(b, membershipEvent.requestId)).toBe(assigned === null ? 0 : 1)
			expect(await recorded(b, adminEvent.requestId)).toBe(granted === null ? 0 : 1)
			await b.db.prepare('DELETE FROM grants WHERE principal_id = ?').bind(user.id).run()
		}
	})

	test('a member revocation racing an admin delete of the same grant: each call records exactly its own change', async () => {
		if (postgres === null) throw new Error('postgres backend not ready')
		const b = postgres
		const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
		const scope = { type: 'workspace', value: unique('ws') }
		for (let round = 0; round < 10; round++) {
			const grant = await b.repositories.grants.createRoleGrantUnlessHeld({
				principalId: user.id,
				app: APP,
				roleKey: 'editor',
				scopeType: scope.type,
				scopeValue: scope.value,
			})
			if (grant === null) throw new Error('expected a grant')
			const membershipEvent = event('test.member.revoke', scope.value)
			const adminEvent = event('test.grant.revoke', grant.id)
			const [removed, deleted] = await Promise.all([
				b.repositories.membership.revokeMemberRoles(
					{ app: APP, principalId: user.id, scope, roles: ['editor'], creatorRole: 'owner' },
					() => membershipEvent,
				),
				b.repositories.grants.deleteGrant(grant.id, adminEvent),
			])
			expect([removed.length > 0, deleted].filter(Boolean)).toHaveLength(1)
			expect(await recorded(b, membershipEvent.requestId)).toBe(removed.length)
			expect(await recorded(b, adminEvent.requestId)).toBe(deleted ? 1 : 0)
		}
	})

	test('two concurrent first issuances of a workload key end with one principal and two recorded keys', async () => {
		if (postgres === null) throw new Error('postgres backend not ready')
		const b = postgres
		const name = `job_${unique('w').replaceAll('-', '_')}`
		const issue = () =>
			b.repositories.workloads.issueKey(
				{
					app: APP,
					kind: 'job',
					name,
					credentialId: crypto.randomUUID(),
					tokenHash: crypto.randomUUID(),
					issuedBy: 'provisioning-admin',
					expiresAt: Math.floor(Date.now() / 1000) + 3600,
					keep: null,
				},
				event('test.workload.key.issue', ''),
			)
		const [first, second] = await Promise.all([issue(), issue()])
		expect(first).toBe(second)
		const { results } = await b.db.prepare("SELECT id FROM audit_events WHERE action = 'test.workload.key.issue' AND resource_id = ?").bind(first).all()
		expect(results).toHaveLength(2)
	})

	test('two concurrent revocations of one credential and one session each record one change', async () => {
		if (postgres === null) throw new Error('postgres backend not ready')
		const b = postgres
		const user = await b.repositories.principals.createUser(`sub-${unique('user')}`, `${unique('user')}@example.test`)
		const credentialId = await b.repositories.credentials.createCredential({
			tokenHash: await hashToken(unique('key')),
			principalId: user.id,
			issuedBy: user.id,
			grants: [],
		})
		const sessionId = await b.repositories.sessions.createSession({
			tokenHash: await hashToken(unique('token')),
			principalId: user.id,
			idpSub: 'sub',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		const event = (action: string, resourceId: string) => ({
			requestId: unique('req'),
			principalId: user.id,
			principalLabel: 'user',
			app: 'propustka',
			action,
			resourceType: 'test',
			resourceId,
		})

		for (let round = 0; round < 3; round++) {
			const [credentials, sessions] = await Promise.all([
				Promise.all([1, 2].map(() => b.repositories.credentials.revokeCredential(credentialId, event('test.credential.revoke', credentialId)))),
				Promise.all([1, 2].map(() => b.repositories.sessions.revokeSessionById(sessionId, event('test.session.revoke', sessionId)))),
			])
			if (round === 0) {
				expect(credentials.filter(Boolean)).toHaveLength(1)
				expect(sessions.filter(Boolean)).toHaveLength(1)
			}
		}
		expect(await events(b, 'test.credential.revoke', credentialId)).toHaveLength(1)
		expect(await events(b, 'test.session.revoke', sessionId)).toHaveLength(1)
	})
})
