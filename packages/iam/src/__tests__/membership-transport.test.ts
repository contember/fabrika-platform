// The membership transport (`src/membership-http.ts`), end to end the way an application on Zerops reaches it: Control
// issues the environment's key through `membershipKeys.issue` with the provisioning key, and the application calls
// `POST /membership/<method>` with `@fabrika/auth`'s `HttpIamMembership`. The key pins the application id and adds no
// authority: the caller is the end user's token, and scope creation and membership changes spend the proxy's grant.

import { HttpIamMembership, IamTransportError } from '@fabrika/auth'
import { type AppSchema, type MembershipCaller, type Scope, WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createIamApp } from '../app'
import { resolveCaller } from '../auth'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import type { Env } from '../env'
import { prop } from '../json'
import { requestDelegation } from '../membership'
import { mintFromKey } from '../tokens'
import { createHarness, TEST_SIGNING_KEYS } from './helpers/harness'
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

const PROVISIONING_KEY = `px_${'p'.repeat(43)}`
const DAY = 24 * 60 * 60
const exec = { waitUntil() {} }

interface Transport {
	readonly f: MembershipFixture
	/** IAM as the Bun process composes it, with the transport mounted. */
	fetch(request: Request): Promise<Response>
	/** A fresh key for `app`, issued as Control issues it. */
	issue(app?: string, keep?: string | null): Promise<{ key: string; id: string }>
	client(key: string): HttpIamMembership
}

function envOf(f: MembershipFixture): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: f.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

async function issueKey(fetchIam: (request: Request) => Promise<Response>, input: { app: string; expiresAt: number; keep: string | null }) {
	return fetchIam(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { authorization: `Bearer ${PROVISIONING_KEY}`, 'content-type': 'application/json' },
			body: JSON.stringify({ method: 'membershipKeys.issue', input }),
		}),
	)
}

async function transport(options: { mounted?: boolean; repositories?: IamRepositories } = {}): Promise<Transport> {
	const f = await membershipFixture(options.repositories ?? createHarness().repositories)
	const app = createIamApp({ membershipTransport: options.mounted ?? true })
	const fetchIam = (request: Request) => app.fetch(request, envOf(f), exec)
	return {
		f,
		fetch: fetchIam,
		async issue(forApp = APP, keep = null) {
			const response = await issueKey(fetchIam, { app: forApp, expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY, keep })
			expect(response.status).toBe(200)
			const result = prop(await response.json(), 'result')
			const key = prop(result, 'key')
			const id = prop(result, 'id')
			if (typeof key !== 'string' || typeof id !== 'string') throw new Error('expected an issued key')
			return { key, id }
		},
		client: (key) => new HttpIamMembership({ origin: ORIGIN, key, fetch: (input, init) => fetchIam(new Request(input, init)) }),
	}
}

/** The schema with no dimension that declares members. */
function withoutMembers(schema: AppSchema): AppSchema {
	return { ...schema, scopes: schema.scopes.map(({ members: _members, ...scope }) => scope) }
}

let requestSeq = 0

async function caller(person: Person, app = APP, tokenApp = app): Promise<MembershipCaller> {
	requestSeq += 1
	return { app, credential: await person.token(tokenApp), requestId: `transport-${requestSeq}` }
}

/** The grant the proxy obtains on `/auth/mint/delegation` for one request; the transport never issues one. */
async function delegated(f: MembershipFixture, person: Person, endpoint: string): Promise<MembershipCaller & { delegation: string }> {
	const call = await caller(person)
	const result = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...call, endpoint })
	if (!result.ok) throw new Error(`no delegation: ${result.reason}`)
	return { ...call, delegation: result.grant }
}

async function workspace(t: Transport, client: HttpIamMembership, owner: Person): Promise<Scope> {
	await t.f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const created = await client.createScope({ ...(await delegated(t.f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!created.ok) throw new Error(`no workspace: ${created.reason}`)
	return created.scope
}

async function rolesOf(f: MembershipFixture, person: Person, scope: Scope): Promise<string[]> {
	return (await f.repositories.membership.listRoleGrantsAt(APP, person.id, scope)).map((grant) => grant.role_key ?? '')
}

describe('the membership transport', () => {
	test('an application with its key creates a workspace and assigns a member, as its caller', async () => {
		const t = await transport()
		const client = t.client((await t.issue()).key)
		const owner = await t.f.person('owner')
		const member = await t.f.person('member')
		const scope = await workspace(t, client, owner)
		expect(await rolesOf(t.f, owner, scope)).toEqual(['owner'])

		const assigned = await client.assignMember({
			...(await delegated(t.f, owner, INVITE_ENDPOINT)),
			scope,
			role: 'editor',
			member: { principalId: member.id },
		})
		expect(assigned).toEqual({ ok: true, assigned: { principalId: member.id, role: 'editor' } })
		expect(await rolesOf(t.f, member, scope)).toEqual(['editor'])
		const listed = await client.listMembers({ ...(await caller(owner)), scope })
		expect(listed.ok && listed.members.map((row) => row.principalId).sort()).toEqual([owner.id, member.id].sort())
	})

	test('a write without the delegation grant the proxy obtained is refused', async () => {
		const t = await transport()
		const client = t.client((await t.issue()).key)
		const owner = await t.f.person('owner')
		const member = await t.f.person('member')
		const scope = await workspace(t, client, owner)
		const refused = await client.assignMember({
			...(await caller(owner)),
			delegation: 'not-a-grant',
			scope,
			role: 'editor',
			member: { principalId: member.id },
		})
		expect(refused).toEqual({ ok: false, reason: 'invalid_delegation' })
		expect(await rolesOf(t.f, member, scope)).toEqual([])
	})

	test('a key acts for its own application environment and no other', async () => {
		const t = await transport()
		const owner = await t.f.person('owner')
		const member = await t.f.person('member')
		const scope = await workspace(t, t.client((await t.issue()).key), owner)
		const stage = t.client((await t.issue('notes@stage')).key)
		const other = t.client((await t.issue('billing@prod')).key)
		const assign = async (client: HttpIamMembership, call: MembershipCaller) =>
			client.assignMember({
				...call,
				delegation: (await delegated(t.f, owner, INVITE_ENDPOINT)).delegation,
				scope,
				role: 'editor',
				member: { principalId: member.id },
			})

		// Naming the other application is refused before the operation runs.
		expect(await assign(stage, await caller(owner))).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await assign(other, await caller(owner))).toEqual({ ok: false, reason: 'not_allowed' })
		// Naming the key's own application with a token of another is the caller's token refused.
		expect(await assign(stage, await caller(owner, 'notes@stage', APP))).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await stage.listMembers({ ...(await caller(owner, 'notes@stage', APP)), scope })).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await rolesOf(t.f, member, scope)).toEqual([])
	})

	test('an absent, unknown or malformed key is no transport, and the surface obtains no delegation grant', async () => {
		const t = await transport()
		const owner = await t.f.person('owner')
		const issued = await t.issue()
		const list = (client: HttpIamMembership) =>
			client.listMembers({ app: APP, credential: null, requestId: 'r', scope: { type: 'workspace', value: 'w' } })
		await expect(list(t.client(`px_${'x'.repeat(27)}`))).rejects.toBeInstanceOf(IamTransportError)
		await expect(list(t.client('not-a-key'))).rejects.toBeInstanceOf(IamTransportError)
		const anonymous = await t.fetch(new Request(`${ORIGIN}/membership/listMembers`, { method: 'POST', body: '{}' }))
		expect(anonymous.status).toBe(401)
		await expect(t.client(issued.key).requestDelegation({ ...(await caller(owner)), endpoint: INVITE_ENDPOINT }))
			.rejects.toBeInstanceOf(IamTransportError)
		const unknown = await t.fetch(
			new Request(`${ORIGIN}/membership/issueKey`, { method: 'POST', headers: { authorization: `Bearer ${issued.key}` }, body: '{}' }),
		)
		expect(unknown.status).toBe(404)
	})

	test('the key mints nothing and calls no other operation', async () => {
		const t = await transport()
		const { key } = await t.issue()
		const { result } = await mintFromKey(t.f.services, CALLER_ENV, { app: APP, key, requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })
		const exchanged = await t.fetch(
			new Request(`${ORIGIN}${WORKLOAD_TOKEN_PATH}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify({ app: APP }),
			}),
		)
		const exchange: unknown = await exchanged.json()
		expect(exchange).toEqual({ ok: false, reason: 'invalid_key' })
		expect(await resolveCaller(t.f.services, CALLER_ENV, { app: APP, credential: key, requestId: 'r' })).toEqual({ ok: false, reason: 'invalid_token' })
		const admin = await t.fetch(
			new Request(`${ORIGIN}/admin/rpc`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ method: 'me' }),
			}),
		)
		expect(admin.status).toBe(401)
	})

	test('is not mounted unless the composition mounts it', async () => {
		const t = await transport({ mounted: false })
		const { key } = await t.issue()
		const response = await t.fetch(
			new Request(`${ORIGIN}/membership/listMembers`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' }),
		)
		expect(response.status).toBe(404)
	})

	test('a key lookup that fails is IAM unavailable, and nothing logs the key', async () => {
		const t = await transport()
		const { key } = await t.issue()
		const lookup = spyOn(t.f.repositories.membershipTransport, 'appOfKey').mockRejectedValue(new Error('connection refused'))
		const lines: string[] = []
		const spies = (['error', 'warn', 'info', 'log', 'debug'] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(' '))
			})
		)
		try {
			const response = await t.fetch(
				new Request(`${ORIGIN}/membership/listMembers`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' }),
			)
			expect(response.status).toBe(503)
			lookup.mockRestore()
			await t.client(key).listMembers({ app: APP, credential: 'garbage', requestId: 'r', scope: { type: 'workspace', value: 'w' } })
		} finally {
			for (const spy of spies) spy.mockRestore()
		}
		expect(lines.length).toBeGreaterThan(0)
		expect(lines.some((line) => line.includes(key))).toBe(false)
	})
})

describe('membershipKeys.issue', () => {
	test('keeps the key the caller recorded and deletes every other key of the environment', async () => {
		const t = await transport()
		const owner = await t.f.person('owner')
		const active = await t.issue()
		// Control asks for a second key and fails to record it: the active key stays, the orphan goes at the next issuance.
		const orphan = await t.issue(APP, active.id)
		const replacement = await t.issue(APP, active.id)
		const list = async (key: string) => t.client(key).listMembers({ ...(await caller(owner)), scope: { type: 'workspace', value: 'w' } })
		expect(await list(active.key)).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await list(replacement.key)).toEqual({ ok: false, reason: 'not_allowed' })
		await expect(list(orphan.key)).rejects.toBeInstanceOf(IamTransportError)
		// Once the replacement is recorded, the next rotation keeps it and deletes the key it replaced.
		await t.issue(APP, replacement.id)
		await expect(list(active.key)).rejects.toBeInstanceOf(IamTransportError)
		expect(await list(replacement.key)).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('issues only for an application environment, and at most 30 days ahead', async () => {
		const t = await transport()
		const now = Math.floor(Date.now() / 1000)
		expect((await issueKey(t.fetch, { app: 'vozka', expiresAt: now + DAY, keep: null })).status).toBe(400)
		expect((await issueKey(t.fetch, { app: APP, expiresAt: now + 31 * DAY, keep: null })).status).toBe(400)
		expect((await issueKey(t.fetch, { app: APP, expiresAt: now - 1, keep: null })).status).toBe(400)
	})

	test('a reconcile that leaves the application no delegated endpoint, no link mount and no listed members deletes its keys', async () => {
		const t = await transport()
		const owner = await t.f.person('owner')
		const { key } = await t.issue()
		const list = async () => t.client(key).listMembers({ ...(await caller(owner)), scope: { type: 'workspace', value: 'w' } })
		const { links: _links, delegations, ...rest } = NOTES_SCHEMA
		expect((await t.f.putSchema({ ...rest, delegations })).status).toBe(200)
		expect(await list()).toEqual({ ok: false, reason: 'not_allowed' })
		// A dimension that lists its members keeps the key: a read endpoint's member directory calls listMembers.
		expect((await t.f.putSchema(rest)).status).toBe(200)
		expect(await list()).toEqual({ ok: false, reason: 'not_allowed' })
		expect((await t.f.putSchema(withoutMembers(rest))).status).toBe(200)
		await expect(list()).rejects.toBeInstanceOf(IamTransportError)
	})

	test("a member lists its value's members through the key with no delegation grant; a non-member is refused", async () => {
		const t = await transport()
		const owner = await t.f.person('owner')
		const editor = await t.f.person('editor')
		const stranger = await t.f.person('stranger')
		const { key } = await t.issue()
		const client = t.client(key)
		const scope = await workspace(t, client, owner)
		const assigned = await client.assignMember({
			...(await delegated(t.f, owner, INVITE_ENDPOINT)),
			scope,
			role: 'editor',
			member: { principalId: editor.id },
		})
		expect(assigned.ok).toBe(true)
		const { links: _links, delegations: _delegations, ...rest } = NOTES_SCHEMA
		expect((await t.f.putSchema(rest)).status).toBe(200)

		const listed = await client.listMembers({ ...(await caller(editor)), scope })
		if (!listed.ok) throw new Error(`expected a list: ${listed.reason}`)
		expect(listed.members.map((member) => [member.principalId, member.label, member.email]).sort()).toEqual(
			[[owner.id, null, null], [editor.id, null, null]].sort(),
		)
		expect(listed.invitations).toEqual([])
		expect(await client.listMembers({ ...(await caller(stranger)), scope })).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

if (!hasPostgres) {
	console.warn(`membership-transport.test.ts (Postgres) ${skipReason}`)
}

describe.skipIf(!hasPostgres)('the membership transport on Postgres', () => {
	let fixture: PostgresFixture | null = null
	beforeAll(async () => {
		fixture = await createPostgres('iam_membership_transport')
	})
	afterAll(async () => {
		await fixture?.close()
	})

	test('a key is issued, rotated, serves its application and goes with a reconcile that needs none', async () => {
		if (fixture === null) throw new Error('no Postgres fixture')
		const t = await transport({ repositories: createPostgresIamRepositories(fixture.db) })
		const owner = await t.f.person('owner')
		const member = await t.f.person('member')
		const first = await t.issue()
		const second = await t.issue(APP, first.id)
		const client = t.client(second.key)
		const scope = await workspace(t, client, owner)
		const assigned = await client.assignMember({
			...(await delegated(t.f, owner, INVITE_ENDPOINT)),
			scope,
			role: 'editor',
			member: { principalId: member.id },
		})
		expect(assigned.ok).toBe(true)
		expect(await t.client(first.key).listMembers({ ...(await caller(owner)), scope })).toMatchObject({ ok: true })
		await t.issue(APP, second.id)
		await expect(t.client(first.key).listMembers({ ...(await caller(owner)), scope })).rejects.toBeInstanceOf(IamTransportError)
		const { links: _links, delegations: _delegations, ...rest } = NOTES_SCHEMA
		expect((await t.f.putSchema(withoutMembers(rest))).status).toBe(200)
		await expect(client.listMembers({ ...(await caller(owner)), scope })).rejects.toBeInstanceOf(IamTransportError)
	})
})
