// What a person's token an agent holds (`act`, ADR-0090) reaches at IAM itself, on both engines: a `read` scope makes
// no membership, scope or link change and obtains no delegation grant; an agent's link revocation is held to its own
// entries; `audit` records the agent from the verified token; and no administration path accepts the token.
// Postgres runs when FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import {
	accessTokenPayload,
	AGENT_CLIENT_ID,
	type AgentScopeMode,
	type AppSchema,
	type AppScopeDef,
	buildAccessClaims,
	narrowToValue,
	type Scope,
} from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { handleAdmin, resolveAdmin } from '../admin/router'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { assignMember, createScope, findMember, issueLink, listMembers, requestDelegation, revokeLink, revokeMember } from '../membership'
import { resolvePermissionsAt } from '../resolve'
import { createIamRpc } from '../rpc'
import { getSigner } from '../signing'
import { bearerRpc } from './helpers/app-people'
import { CONSOLE_APP, createHarness, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
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
	console.warn(`agent-token.test.ts ${skipReason}`)
}

let postgres: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_agent_token')
})
afterAll(async () => {
	await postgres?.close()
})

const engines: { name: string; repositories: () => IamRepositories; skip: boolean }[] = [
	{ name: 'SQLite', repositories: () => createHarness().repositories, skip: false },
	{
		name: 'Postgres',
		repositories: () => {
			if (postgres === null) throw new Error('postgres')
			return createPostgresIamRepositories(postgres.db)
		},
		skip: !hasPostgres,
	},
]

const GRANT_ID = '0198cafe-0000-7000-8000-00000000a9e7'

/** The token the exchange signs for `person` at `app`: the live set narrowed to `within`, with `act`. */
async function agentToken(f: MembershipFixture, person: Person, mode: AgentScopeMode, within: Scope | null, app = APP): Promise<string> {
	const principal = await f.repositories.principals.getPrincipalById(person.id)
	if (principal === null) throw new Error('no principal')
	const live = await resolvePermissionsAt(f.services, principal, app)
	const now = Math.floor(Date.now() / 1000)
	return (await getSigner(TEST_SIGNING_ENV)).sign(accessTokenPayload(
		buildAccessClaims({
			iss: ORIGIN,
			app,
			subject: principal.id,
			type: 'user',
			label: principal.label,
			permissions: within === null ? live : narrowToValue(live, within),
			issuedAt: now,
			expiresAt: now + 300,
			act: { sub: AGENT_CLIENT_ID, grant: GRANT_ID, scope: { mode, within }, label: 'release bot' },
		}),
		'entries',
	))
}

let sequence = 0
const call = (credential: string) => ({ app: APP, credential, requestId: `req-agent-${++sequence}` })

/** A workspace created by `owner` with its own session token, through the creating endpoint. */
async function workspaceOf(f: MembershipFixture, owner: Person): Promise<Scope> {
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const own = call(await owner.token())
	const delegation = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...own, endpoint: CREATE_ENDPOINT })
	if (!delegation.ok) throw new Error(`no delegation: ${delegation.reason}`)
	const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...own, delegation: delegation.grant, dimension: 'workspace' })
	if (!created.ok) throw new Error(`no workspace: ${created.reason}`)
	return created.scope
}

for (const engine of engines) {
	describe.skipIf(engine.skip)(`a person's token an agent holds, at IAM (${engine.name})`, () => {
		test('a read scope is refused every membership, scope and link write and the delegation grant, and still lists', async () => {
			const f = await membershipFixture(engine.repositories())
			const owner = await f.person(`agent-owner-${crypto.randomUUID()}`)
			const member = await f.person(`agent-member-${crypto.randomUUID()}`)
			const workspace = await workspaceOf(f, owner)
			const refused: { ok: false; reason: 'not_allowed' } = { ok: false, reason: 'not_allowed' }

			for (const within of [workspace, null]) {
				const read = call(await agentToken(f, owner, 'read', within))
				expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...read, endpoint: INVITE_ENDPOINT })).toEqual(refused)
				expect(await createScope(f.services, CALLER_ENV, f.ctx, { ...read, delegation: 'unused', dimension: 'workspace' })).toEqual(refused)
				const target = { scope: workspace, delegation: 'unused' }
				expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...read, ...target, role: 'editor', member: { principalId: member.id } }))
					.toEqual(refused)
				expect(await revokeMember(f.services, CALLER_ENV, f.ctx, { ...read, ...target, member: { principalId: member.id } })).toEqual(refused)
				const chain = [{ type: 'note', value: 'n1' }, workspace]
				expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...read, mount: 'shared', chain, days: 1 })).toEqual(refused)
				expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...read, scope: workspace })).toMatchObject({ ok: true })
			}
			// The refusal is the scope's: the same token under `write` obtains the grant.
			const write = call(await agentToken(f, owner, 'write', workspace))
			expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...write, endpoint: INVITE_ENDPOINT })).toMatchObject({ ok: true })
		})

		test('a token narrowed to one workspace lists and finds members there, and at another workspace neither', async () => {
			const f = await membershipFixture(engine.repositories())
			const owner = await f.person(`narrow-owner-${crypto.randomUUID()}`)
			const lookups: AppSchema = {
				...NOTES_SCHEMA,
				scopes: NOTES_SCHEMA.scopes.map((dimension): AppScopeDef =>
					dimension.type === 'workspace' ? { ...dimension, lookups: ['notes.read'] } : dimension
				),
			}
			expect((await f.putSchema(lookups)).status).toBe(200)
			const first = await workspaceOf(f, owner)
			const second = await workspaceOf(f, owner)
			const refused: { ok: false; reason: 'not_allowed' } = { ok: false, reason: 'not_allowed' }
			const lookup = { principalId: owner.id, action: 'notes.read' }

			const narrowed = await agentToken(f, owner, 'read', first)
			expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...call(narrowed), scope: first })).toMatchObject({ ok: true })
			expect(await findMember(f.services, CALLER_ENV, f.ctx, { ...call(narrowed), ...lookup, scope: first })).toMatchObject({ ok: true })
			expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...call(narrowed), scope: second })).toEqual(refused)
			expect(await findMember(f.services, CALLER_ENV, f.ctx, { ...call(narrowed), ...lookup, scope: second })).toEqual(refused)
			// The person reaches both: the narrowing, not a missing membership, keeps the token out of the second.
			const own = await owner.token()
			expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...call(own), scope: second })).toMatchObject({ ok: true })
		})

		test("an agent revokes its person's link only where its entries could issue one", async () => {
			const f = await membershipFixture(engine.repositories())
			const owner = await f.person(`link-owner-${crypto.randomUUID()}`)
			const first = await workspaceOf(f, owner)
			const second = await workspaceOf(f, owner)
			const issued = await issueLink(f.services, CALLER_ENV, f.ctx, {
				...call(await owner.token()),
				mount: 'shared',
				chain: [{ type: 'note', value: 'n2' }, second],
				days: 1,
			})
			if (!issued.ok) throw new Error(`no link: ${issued.reason}`)

			const elsewhere = call(await agentToken(f, owner, 'write', first))
			expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...elsewhere, id: issued.id })).toEqual({ ok: false, reason: 'not_allowed' })
			expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...call(await agentToken(f, owner, 'read', second)), id: issued.id }))
				.toEqual({ ok: false, reason: 'not_allowed' })
			const there = call(await agentToken(f, owner, 'write', second))
			expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...there, id: issued.id })).toEqual({ ok: true })
		})

		test('audit records the agent from the verified token, and an event without one records none', async () => {
			const f = await membershipFixture(engine.repositories())
			const owner = await f.person(`audit-owner-${crypto.randomUUID()}`)
			const ctx = f.ctx
			const rpc = createIamRpc({
				DB: unusedDatabase,
				REPOSITORIES: f.repositories,
				HUMAN_EMAIL_DOMAINS: '[]',
				HUMAN_EMAILS: '[]',
				IAM_BOOTSTRAP_ADMINS: '[]',
				ENVIRONMENT: 'stage',
				OIDC_ENABLED: 'false',
				PASSWORD_ENABLED: 'true',
				ISSUER: ORIGIN,
				FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
				FABRIKA_IAM_PROVISIONING_KEY: '',
			}, ctx)
			const event = (credential: string, requestId: string) => ({
				credential,
				requestId,
				principalId: owner.id,
				principalLabel: owner.id,
				action: 'task.update',
				resourceType: 'task',
				resourceId: 't1',
			})
			const agentRequest = `req-audit-agent-${crypto.randomUUID()}`
			const personRequest = `req-audit-person-${crypto.randomUUID()}`
			await rpc.audit(event(await agentToken(f, owner, 'read', null), agentRequest))
			await rpc.audit(event(await owner.token(), personRequest))
			await ctx.settle()
			const [byAgent] = await f.repositories.audit.listAuditEvents({ requestId: agentRequest, limit: 5 })
			expect(byAgent).toMatchObject({ app: APP, actor_id: `oauth:${GRANT_ID}`, actor_label: 'release bot' })
			const [byPerson] = await f.repositories.audit.listAuditEvents({ requestId: personRequest, limit: 5 })
			expect(byPerson).toMatchObject({ app: APP, actor_id: null, actor_label: null })
		})

		test('no administration path accepts it, at a console audience either', async () => {
			const f = await membershipFixture(engine.repositories())
			const owner = await f.person(`admin-owner-${crypto.randomUUID()}`)
			await f.repositories.grants.createGrant({ principalId: owner.id, roleKey: 'admin' })
			const token = await agentToken(f, owner, 'read', null, CONSOLE_APP)

			const resolution = await resolveAdmin(f.services, CALLER_ENV, { bearer: token, requestId: 'req-admin-agent' })
			expect(resolution).toMatchObject({ ok: false, status: 403 })
			expect((await bearerRpc(f, token, 'appPeople.apps', null)).status).toBe(403)
			expect((await bearerRpc(f, token, 'users.list', {})).status).toBe(403)
			const rest = await handleAdmin(
				new Request(`${ORIGIN}/admin/apps/${encodeURIComponent(APP)}/schema`, { headers: { authorization: `Bearer ${token}` } }),
				f.services,
				CALLER_ENV,
				f.ctx,
			)
			expect(rest.status).toBe(403)
		})
	})
}
