// External principals (ADR-0051) on BOTH backends: an external principal holds only grants of a role its application
// declares external. Each lock is witnessed where it lives — every grant-writing path refuses an internal role, a
// reconcile refuses to narrow a role an external holds, and resolution ignores a grant that breaks the rule — and so
// are the identity edges: OIDC never claims an external row, a bootstrap mailbox makes an external no admin, and only
// an administrator's promotion makes it internal.

import type { AppSchema, MembershipCaller, Scope } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, ExternalGrantError, type IamRepositories } from '../db'
import { acceptInvitation, assignMember, createScope, listMembers, requestDelegation } from '../membership'
import { resolvePermissionsAt, resolveUserPrincipal } from '../resolve'
import { createHarness, makeServicesFor } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	NOTES_SCHEMA,
	ORIGIN,
	type Person,
} from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`external-principals.test.ts ${skipReason}`)
}

/** The notes schema with `partner`, a membership role of `workspace` an external principal may hold. */
const PARTNER_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	roles: {
		...NOTES_SCHEMA.roles,
		partner: { name: 'Partner', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true },
	},
}

/** The same schema with `partner` narrowed to internal people. */
const NARROWED_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	roles: { ...NOTES_SCHEMA.roles, partner: { name: 'Partner', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}

interface Store {
	readonly repositories: IamRepositories
	/** Run raw SQL behind every repository, for a state no supported path reaches. */
	exec(sql: string): Promise<void>
}

interface Backend {
	readonly name: string
	readonly skip: boolean
	store(): Promise<Store>
}

const postgresFixtures: PostgresFixture[] = []
afterEach(async () => {
	for (const fixture of postgresFixtures.splice(0)) await fixture.close()
})

const BACKENDS: Backend[] = [
	{
		name: 'SQLite',
		skip: false,
		store() {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				exec(sql) {
					harness.sqlite.exec(sql)
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'Postgres',
		skip: !hasPostgres,
		async store() {
			const fixture = await createPostgres('iam_external')
			postgresFixtures.push(fixture)
			return {
				repositories: createPostgresIamRepositories(fixture.db),
				async exec(sql) {
					await fixture.db.prepare(sql).run()
				},
			}
		},
	},
]

let requestSeq = 0

async function caller(person: Person): Promise<MembershipCaller> {
	requestSeq += 1
	return { app: APP, credential: await person.token(), requestId: `ext-req-${requestSeq}` }
}

async function delegated(f: MembershipFixture, person: Person, endpoint = INVITE_ENDPOINT) {
	const call = await caller(person)
	const result = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...call, endpoint })
	if (!result.ok) throw new Error(`no delegation: ${result.reason}`)
	return { ...call, delegation: result.grant }
}

async function partnerFixture(
	backend: Backend,
	email: CapturingEmail | null = null,
): Promise<MembershipFixture & { exec(sql: string): Promise<void> }> {
	const store = await backend.store()
	const f = await membershipFixture(store.repositories, { email })
	const reconciled = await f.putSchema(PARTNER_SCHEMA)
	if (reconciled.status !== 200) throw new Error(`schema refused: ${await reconciled.text()}`)
	return { ...f, exec: store.exec }
}

async function workspaceOf(f: MembershipFixture, owner: Person): Promise<Scope> {
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!result.ok) throw new Error(`no workspace: ${result.reason}`)
	return result.scope
}

async function permissionsOf(f: MembershipFixture, id: string, app = APP) {
	const principal = await f.repositories.principals.getPrincipalById(id)
	if (principal === null) throw new Error(`no principal ${id}`)
	return resolvePermissionsAt(f.services, principal, app)
}

async function rpcBody(response: Response): Promise<unknown> {
	return response.json()
}

for (const backend of BACKENDS) {
	describe.skipIf(backend.skip)(`external principals on ${backend.name}`, () => {
		test('admin grants.create gives an external principal only a role declared external', async () => {
			const f = await partnerFixture(backend)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			const at = { principalId: external.id, app: APP, scopeType: scope.type, scopeValue: scope.value }
			const policy = await f.adminRpc('policies.create', { app: APP, policy: { key: 'reader-policy', name: 'Reader', permissions: ['notes.read'] } })
			expect(policy.status).toBe(200)

			// The built-in `admin` of a contract application is already refused for its wildcard (400); cross-app it is the rule's.
			const refusals: [unknown, number][] = [
				[{ ...at, permissions: ['notes.read'] }, 409],
				[{ principalId: external.id, app: null, roleKey: 'admin' }, 409],
				[{ principalId: external.id, app: APP, roleKey: 'admin' }, 400],
				[{ principalId: external.id, app: APP, roleKey: 'reader-policy' }, 409],
				[{ ...at, roleKey: 'editor' }, 409],
			]
			for (const [refused, status] of refusals) {
				expect((await f.adminRpc('grants.create', refused)).status).toBe(status)
			}
			expect(await f.repositories.grants.listGrants(external.id)).toEqual([])

			const allowed = await f.adminRpc('grants.create', { ...at, roleKey: 'partner' })
			expect(allowed.status).toBe(200)
			expect(await permissionsOf(f, external.id)).toEqual([{ action: 'notes.read', scope, source: 'grant' }])
		})

		test('every repository write carries the condition itself', async () => {
			const f = await partnerFixture(backend)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			const grants = f.repositories.grants

			await expect(grants.createGrant({ principalId: external.id, app: APP, permissions: ['notes.read'] })).rejects.toBeInstanceOf(ExternalGrantError)
			await expect(grants.createRoleGrantUnlessHeld({ principalId: external.id, roleKey: 'admin' })).rejects.toBeInstanceOf(ExternalGrantError)
			await expect(
				grants.createRoleGrantUnlessHeld({ principalId: external.id, app: APP, roleKey: 'editor', scopeType: 'workspace', scopeValue: scope.value }),
			)
				.rejects.toBeInstanceOf(ExternalGrantError)
			expect(
				await f.repositories.membership.grantMembershipRole({ app: APP, principalId: external.id, roleKey: 'editor', scope, grantedBy: owner.id }),
			).toBeNull()
			const created = await f.repositories.membership.createScope({
				app: APP,
				scope: { type: 'workspace', value: crypto.randomUUID() },
				createdBy: external.id,
				roleKey: 'owner',
			})
			expect(created).toBe(false)
			expect(await grants.listGrants(external.id)).toEqual([])

			expect(await f.repositories.membership.grantMembershipRole({ app: APP, principalId: external.id, roleKey: 'partner', scope, grantedBy: owner.id }))
				.not.toBeNull()
		})

		test('assigning by principal id refuses an internal role for an external, and an internal may hold an external role', async () => {
			const f = await partnerFixture(backend)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			const colleague = await f.person(`staff-${crypto.randomUUID()}`)

			const refused = await assignMember(f.services, CALLER_ENV, f.ctx, {
				...(await delegated(f, owner)),
				scope,
				role: 'editor',
				member: { principalId: external.id },
			})
			expect(refused).toMatchObject({ ok: false, reason: 'invalid_request' })
			expect(await f.repositories.grants.listGrants(external.id)).toEqual([])

			for (const member of [external, colleague]) {
				expect(
					await assignMember(f.services, CALLER_ENV, f.ctx, {
						...(await delegated(f, owner)),
						scope,
						role: 'partner',
						member: { principalId: member.id },
					}),
				)
					.toEqual({ ok: true, assigned: { principalId: member.id, role: 'partner' } })
				expect(await permissionsOf(f, member.id)).toContainEqual({ action: 'notes.read', scope, source: 'grant' })
			}

			const listed = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), scope })
			if (!listed.ok) throw new Error(`no list: ${listed.reason}`)
			const affiliations = Object.fromEntries(listed.members.map((member) => [member.principalId, member.affiliation]))
			expect(affiliations).toEqual({ [owner.id]: 'internal', [external.id]: 'external', [colleague.id]: 'internal' })
		})

		test('an external accepts an invitation only to a role declared external; a refused one stays open', async () => {
			const email = new CapturingEmail()
			const f = await partnerFixture(backend, email)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			const principal = await f.repositories.principals.getPrincipalById(external.id)
			if (principal === null || principal.email === null) throw new Error('no external principal')

			const invite = async (role: string) => {
				const result = await assignMember(f.services, CALLER_ENV, f.ctx, {
					...(await delegated(f, owner)),
					scope,
					role,
					member: { email: principal.label },
				})
				if (!result.ok || !('invited' in result)) throw new Error('no invitation')
				return { id: result.invited.invitationId, token: email.lastToken() }
			}

			const editor = await invite('editor')
			expect(await acceptInvitation(f.services, principal, editor.token, 'req-accept-editor')).toEqual({ ok: false, reason: 'not_eligible' })
			expect((await f.repositories.membership.getInvitationById(editor.id))?.accepted_at).toBeNull()
			expect(await f.repositories.grants.listGrants(external.id)).toEqual([])

			const partner = await invite('partner')
			expect(await acceptInvitation(f.services, principal, partner.token, 'req-accept-partner')).toMatchObject({ ok: true })
			expect(await permissionsOf(f, external.id)).toEqual([{ action: 'notes.read', scope, source: 'grant' }])
		})

		test('a reconcile refuses to narrow a role an external holds, and its batch guard rolls a narrowing back', async () => {
			const f = await partnerFixture(backend)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			const grant = await f.repositories.membership.grantMembershipRole({
				app: APP,
				principalId: external.id,
				roleKey: 'partner',
				scope,
				grantedBy: owner.id,
			})
			if (grant === null) throw new Error('no partner grant')

			const narrowed = await f.putSchema(NARROWED_SCHEMA)
			expect(narrowed.status).toBe(409)
			expect(await narrowed.text()).toContain(grant.id)
			expect((await f.repositories.appSchema.getRole(APP, 'partner'))?.external).toBe(1)

			// The 409 is read before the batch; the batch's own guard refuses what got past it.
			await expect(f.repositories.appSchema.reconcileAppSchema({
				app: APP,
				scopes: [{ scopeType: 'workspace', creatorRole: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } }],
				actions: [{ action: 'notes.read' }, { action: 'notes.admin' }],
				roles: [
					{ roleKey: 'owner', name: 'Owner', permissions: ['notes.read', 'notes.admin'], memberScope: 'workspace', assignableBy: ['owner'] },
					{ roleKey: 'partner', name: 'Partner', permissions: ['notes.read'], memberScope: 'workspace', assignableBy: ['owner'] },
				],
				contract: true,
			})).rejects.toThrow()
			expect((await f.repositories.appSchema.getRole(APP, 'partner'))?.external).toBe(1)
		})

		test('a grant written before a narrowing contributes nothing', async () => {
			const f = await partnerFixture(backend)
			const owner = await f.person(`owner-${crypto.randomUUID()}`)
			const scope = await workspaceOf(f, owner)
			const external = await f.external(`ext-${crypto.randomUUID()}`)
			await f.repositories.membership.grantMembershipRole({ app: APP, principalId: external.id, roleKey: 'partner', scope, grantedBy: owner.id })
			expect(await permissionsOf(f, external.id)).toHaveLength(1)

			// A narrowing both earlier locks missed; resolution is the third.
			await f.exec(`UPDATE roles SET external = 0 WHERE role_key = 'partner'`)
			expect(await permissionsOf(f, external.id)).toEqual([])
		})

		test('an OIDC login presenting an external mailbox is refused and claims nothing, until promotion', async () => {
			const f = await partnerFixture(backend)
			const name = `ext-${crypto.randomUUID()}`
			const external = await f.external(name)
			const mailbox = `${name}@partner.test`
			const sub = `idp-${name}`

			expect(await resolveUserPrincipal(f.repositories.principals, sub, mailbox, 'req-oidc-1')).toEqual({ ok: false, reason: 'external_principal' })
			const row = await f.repositories.principals.getPrincipalById(external.id)
			expect(row?.external_id).toBeNull()
			expect(await f.repositories.principals.getUserByExternalId(sub)).toBeNull()

			const promoted = await f.adminRpc('principals.promote', { principalId: external.id })
			expect(promoted.status).toBe(200)
			expect(await rpcBody(promoted)).toMatchObject({ result: { id: external.id, affiliation: 'internal' } })
			expect((await f.adminRpc('principals.promote', { principalId: external.id })).status).toBe(409)
			const audited = await f.repositories.audit.listAuditEvents({ resourceId: external.id, limit: 10 })
			expect(audited.map((event) => event.action)).toContain('iam.principal.promote')

			const claimed = await resolveUserPrincipal(f.repositories.principals, sub, mailbox, 'req-oidc-2')
			expect(claimed).toMatchObject({ ok: true, principal: { id: external.id, external_id: sub, affiliation: 'internal' } })
		})

		test('a bootstrap mailbox held by an external principal is no admin', async () => {
			const f = await partnerFixture(backend)
			const name = `ext-${crypto.randomUUID()}`
			const external = await f.external(name)
			const services = makeServicesFor(f.repositories, { environment: 'stage', issuer: ORIGIN, bootstrapAdmins: new Set([`${name}@partner.test`]) })
			const principal = await f.repositories.principals.getPrincipalById(external.id)
			if (principal === null) throw new Error('no external principal')

			expect(await resolvePermissionsAt(services, principal, 'propustka')).toEqual([])
			await f.repositories.principals.promoteToInternal(external.id)
			const promoted = await f.repositories.principals.getPrincipalById(external.id)
			if (promoted === null) throw new Error('no promoted principal')
			expect(await resolvePermissionsAt(services, promoted, 'propustka')).toContainEqual({ action: '*', scope: null, source: 'bootstrap' })
		})
	})
}
