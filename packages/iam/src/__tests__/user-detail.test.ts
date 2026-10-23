import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { listConnections, revokeConnection } from '../admin/connections'
import { type AdminContext, adminEvent } from '../admin/context'
import { adminUseCases } from '../admin/handlers'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { createHarness, makeServicesFor, TestSqlDatabase } from './helpers/harness'
import { APP, membershipFixture, ONBOARDING_SCHEMA } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const future = () => Math.floor(Date.now() / 1000) + 3600

async function fixture(repositories: IamRepositories) {
	const f = await membershipFixture(repositories)
	await f.putSchema(ONBOARDING_SCHEMA)
	const admin = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const user = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const url = new URL('https://iam.example.test/admin/rpc')
	const context: AdminContext = {
		services: makeServicesFor(repositories, { authentication: { oidc: true, password: true } }),
		admin: { id: admin.id, label: admin.label, type: 'user', permissions: [{ action: '*', scope: null, source: 'grant' }] },
		administration: { kind: 'installation' },
		app: 'propustka',
		requestId: crypto.randomUUID(),
		url,
		request: new Request(url),
		ctx: f.ctx,
	}
	const grant = await adminUseCases.createGrant(context, {
		principalId: user.id,
		app: APP,
		roleKey: 'editor',
		scopeType: 'workspace',
		scopeValue: 'alpha',
	})
	const session = (parentSessionId?: string, expiresAt = future()) =>
		repositories.sessions.createSession({
			principalId: user.id,
			tokenHash: crypto.randomUUID(),
			authenticationMethod: 'password',
			expiresAt,
			...(parentSessionId ? { parentSessionId, app: APP } : {}),
		})
	return { repositories, context, user, admin, grant, session }
}

function suite(label: string, backend: () => { repositories: IamRepositories; db: SqlDatabase }) {
	describe(`user detail (${label})`, () => {
		test('resolves each application separately, preserves the grant origin, and shows no usable permissions for disabled people', async () => {
			const f = await fixture(backend().repositories)
			const parent = await f.session()
			await f.session(parent)
			await adminUseCases.createGrant(f.context, { principalId: f.user.id, roleKey: 'admin' })
			const detail = await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })
			expect(detail.access.find((entry) => entry.app === APP)?.permissions.map((entry) => entry.action)).toEqual([
				'notes.read',
				'notes.write',
				'notes.share',
			])
			expect(detail.access.find((entry) => entry.app === 'propustka')?.permissions).toEqual([{ action: '*', scope: null, source: 'grant' }])
			expect(detail.access.find((entry) => entry.app === APP)?.lastSignInAt).toBeGreaterThan(0)
			expect(detail.grants.find((entry) => entry.id === f.grant.id)).toMatchObject({
				roleName: 'Editor',
				rolePermissions: ['notes.read', 'notes.write', 'notes.share'],
				grantedByLabel: f.admin.label,
				canManage: true,
			})
			await adminUseCases.updatePrincipal(f.context, { principalId: f.user.id, disabled: true })
			const disabled = await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })
			expect(disabled.grants).toHaveLength(2)
			expect(disabled.permissions).toEqual([])
			expect(disabled.access.every((entry) => entry.permissions.length === 0)).toBe(true)
			expect(disabled.disabledAt).not.toBeNull()
		})

		test('edits access in place, invalidates delegated authority and audits the exact change only once', async () => {
			const f = await fixture(backend().repositories)
			const changes = { id: f.grant.id, roleKey: 'publisher', scopeType: 'workspace', scopeValue: 'beta', expiresAt: future() }
			const updated = await adminUseCases.updateGrant(f.context, changes)
			expect(updated).toMatchObject({ ...f.grant, roleKey: 'publisher', scopeValue: 'beta', expiresAt: changes.expiresAt })
			expect((await f.repositories.principals.getPrincipalById(f.user.id))?.grant_revision).toBeGreaterThan(f.user.grant_revision)
			const events = await adminUseCases.listAudit(f.context, { subjectPrincipalId: f.user.id, action: 'iam.grant.update' })
			expect(events.items).toHaveLength(1)
			expect(events.items[0]?.diff).toEqual({
				before: { roleKey: 'editor', permissions: null, scopeType: 'workspace', scopeValue: 'alpha', expiresAt: null },
				after: { roleKey: 'publisher', permissions: null, scopeType: 'workspace', scopeValue: 'beta', expiresAt: changes.expiresAt },
			})
			await adminUseCases.updateGrant(f.context, changes)
			expect((await adminUseCases.listAudit(f.context, { subjectPrincipalId: f.user.id, action: 'iam.grant.update' })).items).toHaveLength(1)
		})

		test('refuses duplicate, invalid membership and external-role edits without losing the existing access', async () => {
			const f = await fixture(backend().repositories)
			const reader = await adminUseCases.createGrant(f.context, {
				principalId: f.user.id,
				app: APP,
				roleKey: 'publisher',
				scopeType: 'workspace',
				scopeValue: 'alpha',
			})
			await expect(adminUseCases.updateGrant(f.context, { id: reader.id, roleKey: 'editor', scopeType: 'workspace', scopeValue: 'alpha' })).rejects
				.toThrow('already has')
			await expect(adminUseCases.updateGrant(f.context, { id: reader.id, roleKey: 'publisher' })).rejects.toThrow()
			await expect(
				adminUseCases.updateGrant(f.context, { id: reader.id, roleKey: 'publisher', scopeType: 'workspace', scopeValue: 'alpha', expiresAt: 1 }),
			).rejects.toThrow('future')
			const external = await f.repositories.principals.inviteUser(`${crypto.randomUUID()}@partner.test`, 'External', undefined, 'external')
			const grant = await adminUseCases.createGrant(f.context, {
				principalId: external.id,
				app: APP,
				roleKey: 'partner',
				scopeType: 'workspace',
				scopeValue: 'alpha',
			})
			await expect(adminUseCases.updateGrant(f.context, { id: grant.id, roleKey: 'publisher', scopeType: 'workspace', scopeValue: 'alpha' })).rejects
				.toThrow()
			expect((await f.repositories.grants.getGrantById(reader.id))?.role_key).toBe('publisher')
			expect((await f.repositories.grants.getGrantById(grant.id))?.role_key).toBe('partner')
		})

		test('a stale edit cannot overwrite a concurrent edit or fabricate its before-value in history', async () => {
			const f = await fixture(backend().repositories)
			const before = await f.repositories.grants.getGrantById(f.grant.id)
			if (before === null) throw new Error('grant')
			await adminUseCases.updateGrant(f.context, { id: before.id, roleKey: 'publisher', scopeType: 'workspace', scopeValue: 'alpha' })
			const stale = await f.repositories.grants.updateGrant(before, {
				principalId: f.user.id,
				app: APP,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValue: 'beta',
			}, adminEvent(f.context, { action: 'iam.grant.update', resourceType: 'grant', resourceId: before.id, metadata: { principalId: f.user.id } }))
			expect(stale).toBeNull()
			expect((await f.repositories.grants.getGrantById(before.id))?.scope_value).toBe('alpha')
			expect((await adminUseCases.listAudit(f.context, { subjectPrincipalId: f.user.id, action: 'iam.grant.update' })).items).toHaveLength(1)
		})

		test('subject history survives removal of access, differs from actor history, and pages through malformed legacy metadata', async () => {
			const b = backend()
			const f = await fixture(b.repositories)
			await adminUseCases.deleteGrant(f.context, { id: f.grant.id })
			await b.repositories.audit.writeAuditEvent({
				requestId: 'malformed',
				principalId: f.user.id,
				principalLabel: f.user.id,
				app: APP,
				action: 'unrelated',
				resourceType: 'other',
			})
			await b.db.prepare("UPDATE audit_events SET metadata = 'not-json' WHERE principal_id = ? AND action = 'unrelated'").bind(f.user.id).run()
			const subject = await adminUseCases.listAudit(f.context, { subjectPrincipalId: f.user.id, limit: 1 })
			expect(subject.items.map((event) => event.action)).toEqual(['iam.grant.revoke'])
			expect(subject.nextCursor).not.toBeNull()
			const older = await adminUseCases.listAudit(f.context, { subjectPrincipalId: f.user.id, before: subject.nextCursor ?? undefined })
			expect(older.items.map((event) => event.action)).toEqual(['iam.grant.create'])
			expect((await adminUseCases.listAudit(f.context, { principalId: f.user.id })).items.map((event) => event.action)).toEqual(['unrelated'])
		})

		test('pages sign-ins with their applications and reports parent, account and method unavailability truthfully', async () => {
			const f = await fixture(backend().repositories)
			const expired = await f.session(undefined, 1)
			const expiredChild = await f.session(expired)
			const parent = await f.session()
			const child = await f.session(parent)
			const page = await adminUseCases.listSessions(f.context, { principalId: f.user.id, signInsOnly: true, limit: 1 })
			expect(page.items.map((item) => item.id)).toEqual([parent])
			expect(page.applications.map((item) => item.id)).toEqual([child])
			expect(page.applications[0]?.unavailableReason).toBeNull()
			const older = await adminUseCases.listSessions(f.context, { principalId: f.user.id, signInsOnly: true, before: page.nextCursor ?? undefined })
			expect(older.applications).toMatchObject([{ id: expiredChild, unavailableReason: 'parent_ended' }])
			await adminUseCases.revokeSession(f.context, { id: parent })
			const ended = await adminUseCases.listSessions(f.context, { principalId: f.user.id })
			expect(ended.items.find((item) => item.id === child)?.unavailableReason).toBe('parent_ended')
			const fresh = await f.session()
			await adminUseCases.updatePrincipal(f.context, { principalId: f.user.id, disabled: true })
			expect((await adminUseCases.listSessions(f.context, { principalId: f.user.id })).items.find((item) => item.id === fresh)?.unavailableReason).toBe(
				'account_disabled',
			)
			await adminUseCases.updatePrincipal(f.context, { principalId: f.user.id, disabled: false })
			const passwordOff = { ...f.context, services: makeServicesFor(f.repositories, { authentication: { oidc: true, password: false } }) }
			expect((await adminUseCases.listSessions(passwordOff, { principalId: f.user.id })).items.find((item) => item.id === fresh)?.unavailableReason)
				.toBe('method_disabled')
		})

		test('password-link metadata distinguishes an open link from a closed one without revealing a token', async () => {
			const f = await fixture(backend().repositories)
			await adminUseCases.issuePasswordEnrollment(f.context, { principalId: f.user.id })
			const detail = await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })
			expect(detail.authentication.password).toMatchObject({
				state: 'pending',
				delivery: 'manual',
				latestAction: { purpose: 'enrollment', closedAt: null },
			})
			expect(JSON.stringify(detail.authentication)).not.toContain('token')
			await adminUseCases.disablePassword(f.context, { principalId: f.user.id })
			expect((await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })).authentication.password.latestAction?.closedAt).not.toBeNull()
		})

		test('connected clients use token-renewal eligibility and disconnect atomically with a user-targeted event', async () => {
			const f = await fixture(backend().repositories)
			const session = await f.session()
			const clientId = 'https://client.example.test/metadata'
			const resource = 'https://notes.example.test/mcp'
			const context = {
				...f.context,
				services: makeServicesFor(f.repositories, {
					authentication: { oidc: false, password: true },
					oauth: {
						clients: [{ provider: 'claude', clientId, metadataUrl: clientId, redirectUris: ['https://client.example.test/callback'] }],
						resources: [{ app: APP, resource, defaultScopes: ['read'], scopeGrants: [{ scope: 'read', permissions: [{ action: 'notes.read' }] }] }],
					},
				}),
			}
			const id = crypto.randomUUID()
			await f.repositories.oauth.createGrant({
				id,
				principal_id: f.user.id,
				session_id: session,
				client_id: clientId,
				app: APP,
				resource,
				scopes: '["read"]',
				created_at: future() - 3600,
				expires_at: future(),
				revoked_at: null,
			}, { token_hash: crypto.randomUUID(), redirect_uri: 'https://client.example.test/callback', challenge: 'challenge', expires_at: future() })
			expect((await listConnections(context, { principalId: f.user.id })).items[0]?.status).toBe('active')
			expect((await listConnections(f.context, { principalId: f.user.id })).items[0]?.status).toBe('unavailable')
			await adminUseCases.revokeSession(context, { id: session })
			expect((await listConnections(context, { principalId: f.user.id })).items[0]?.status).toBe('unavailable')
			await revokeConnection(context, { id })
			await revokeConnection(context, { id })
			expect((await listConnections(context, { principalId: f.user.id })).items[0]?.status).toBe('revoked')
			expect((await adminUseCases.listAudit(context, { subjectPrincipalId: f.user.id, action: 'iam.oauth.grant.revoke' })).items).toHaveLength(1)
		})
	})
}

suite('SQLite', () => {
	const h = createHarness()
	return { repositories: h.repositories, db: new TestSqlDatabase(h.sqlite) }
})

if (!hasPostgres) console.warn(`user-detail.test.ts ${skipReason}`)
describe.skipIf(!hasPostgres)('on Postgres', () => {
	let backend: PostgresFixture | null = null
	beforeAll(async () => {
		backend = await createPostgres('iam_user_detail')
	})
	afterAll(async () => {
		await backend?.close()
	})
	suite('Postgres', () => {
		if (backend === null) throw new Error('fixture')
		return { db: backend.db, repositories: createPostgresIamRepositories(backend.db) }
	})
})
