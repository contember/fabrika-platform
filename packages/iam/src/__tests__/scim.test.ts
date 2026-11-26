// SCIM 2.0 provisioning of users (ADR-0091), end to end through `createIamApp`, on SQLite and on Postgres when
// `FABRIKA_TEST_POSTGRES_URL` is set. The request bodies are Microsoft Entra ID's, as Microsoft documents them for a
// SCIM endpoint ("Tutorial: Develop and plan provisioning for a SCIM endpoint in Microsoft Entra ID", the user
// operations, and "Known issues and resolutions with SCIM 2.0 protocol compliance" for the pre-compliance PATCH forms).
//
// The deprovisioning witness: after `active=false` or DELETE, the very next mint from the person's existing session,
// key or OAuth grant is refused, without waiting for any token lifetime.

import type { SqlDatabase } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { createIamRepositories, createPostgresIamRepositories, type IamRepositories } from '../db'
import type { Env } from '../env'
import { prop } from '../json'
import { stateOf } from '../scim/resource'
import { saveUser } from '../scim/users'
import { hashToken } from '../secret'
import { mintFromKey, mintToken } from '../tokens'
import { adminTokenFor, makeServicesFor, TEST_SIGNING_KEYS, TestSqlDatabase } from './helpers/harness'
import { allMigrations } from './helpers/migrations'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const ORIGIN = 'https://iam.example.test'
const BASE = `${ORIGIN}/scim/v2`
const ROOT = 'root@example.com'
/** A bootstrap administrator no principal holds yet: its first password recovery creates it. */
const BREAK_GLASS = 'breakglass@example.com'
const APP = 'notes@prod'
const MINT_ENV = { FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS, ENVIRONMENT: 'stage' }
const exec = { waitUntil() {} }
const now = () => Math.floor(Date.now() / 1000)

// ── Microsoft's documented request bodies ───────────────────────────────────

/** "Create User" request. */
function entraCreateUser(userName: string, email: string, externalId = '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef') {
	return {
		schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
		externalId,
		userName,
		active: true,
		emails: [{ primary: true, type: 'work', value: email }],
		meta: { resourceType: 'User' },
		name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' },
		roles: [],
	}
}

/** "Update User [Multi-valued properties]". */
const entraPatchMultiValued = (email: string) => ({
	schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
	Operations: [
		{ op: 'Replace', path: 'emails[type eq "work"].value', value: email },
		{ op: 'Replace', path: 'name.familyName', value: 'updatedFamilyName' },
	],
})

/** "Update User [Single-valued properties]". */
const entraPatchUserName = (userName: string) => ({
	schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
	Operations: [{ op: 'Replace', path: 'userName', value: userName }],
})

/** "Disable User", the compliant form. */
const entraDisable = {
	Operations: [{ op: 'Replace', path: 'active', value: false }],
	schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
}

/** The pre-compliance form: a capitalized op and `active` as the string "False". */
const entraDisableLegacy = {
	schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
	Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
}

/** The pre-compliance form without a path: the value is an object of attributes. */
const entraPathless = (value: Record<string, unknown>) => ({
	schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
	Operations: [{ op: 'Add', value }],
})

// ── The engines ─────────────────────────────────────────────────────────────

interface Engine {
	readonly repositories: IamRepositories
	readonly db: SqlDatabase
}

function sqliteEngine(): Engine {
	const sqlite = new Database(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(allMigrations())
	const db = new TestSqlDatabase(sqlite)
	return { db, repositories: createIamRepositories(db) }
}

let postgres: PostgresFixture | null = null
let postgresEngine: Engine | null = null

beforeAll(async () => {
	if (!hasPostgres) return
	postgres = await createPostgres('scim', { max: 2 })
	postgresEngine = { db: postgres.db, repositories: createPostgresIamRepositories(postgres.db) }
})

afterAll(async () => {
	await postgres?.close()
})

/** One installation: IAM as `createIamApp` composes it, its root administrator and the SCIM token it created. */
interface Installation {
	readonly engine: Engine
	fetch(request: Request): Promise<Response>
	rpc(bearer: string, method: string): Promise<Response>
	scim(method: string, path: string, body?: unknown, token?: string): Promise<Response>
	readonly token: string
	readonly root: string
	rootBearer(): Promise<string>
}

let seq = 0
const id = (prefix: string) => `${prefix}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

async function seedUser(engine: Engine, email: string): Promise<string> {
	const principal = id('user')
	await engine.db
		.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?)`)
		.bind(principal, `sub-${principal}`, email.toLowerCase(), email, now(), now())
		.run()
	await engine.db.prepare('INSERT INTO principal_email_claims (normalized_email, principal_id) VALUES (?, ?)').bind(email.toLowerCase(), principal)
		.run()
	return principal
}

function envOf(engine: Engine): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: engine.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: JSON.stringify([ROOT, BREAK_GLASS]),
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

async function installation(engine: Engine): Promise<Installation> {
	const app = createIamApp()
	const env = envOf(engine)
	const fetch = (request: Request) => app.fetch(request, env, exec)
	const root = (await engine.repositories.principals.getUserByEmail(ROOT))?.id ?? await seedUser(engine, ROOT)
	const rootBearer = () => adminTokenFor(engine.repositories, root, { issuer: ORIGIN })
	const rpc = async (bearer: string, method: string) =>
		fetch(
			new Request(`${ORIGIN}/admin/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ method, input: null }),
			}),
		)
	const token = String(prop(await result(await rpc(await rootBearer(), 'scim.rotateToken')), 'token'))
	const scim = (method: string, path: string, body?: unknown, bearer: string = token) =>
		fetch(
			new Request(`${BASE}${path}`, {
				method,
				headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		)
	return { engine, fetch, rpc, scim, token, root, rootBearer }
}

/** A person's ways in: a browser session, a self-bound `px_` key, an OAuth grant and a pending password action. */
async function accessOf(engine: Engine, principalId: string) {
	const session = `sess-${id('s')}`
	await engine.repositories.sessions.createSession({
		tokenHash: await hashToken(session),
		principalId,
		idpSub: `sub-${principalId}`,
		email: 'person@example.com',
		expiresAt: now() + 3600,
	})
	const key = `px_${'k'.repeat(20)}${String(++seq).padStart(7, '0')}`
	await engine.db
		.prepare('INSERT INTO credentials (id, token_hash, principal_id, issued_by, created_at) VALUES (?, ?, ?, ?, ?)')
		.bind(id('cred'), await hashToken(key), principalId, principalId, now())
		.run()
	const sessionRow = await engine.repositories.sessions.getActiveSessionByHash(await hashToken(session))
	const grant = id('grant')
	await engine.db
		.prepare(`INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at)
			VALUES (?, ?, ?, 'https://client.example/metadata.json', 'vozka', 'https://console.example', '[]', ?, ?)`)
		.bind(grant, principalId, sessionRow?.id ?? '', now(), now() + 3600)
		.run()
	await engine.db
		.prepare(`INSERT INTO password_action_tokens (id, token_hash, principal_id, purpose, expires_at, created_at) VALUES (?, ?, ?, 'reset', ?, ?)`)
		.bind(id('pat'), await hashToken(id('action')), principalId, now() + 3600, now())
		.run()
	return { session, key, grant }
}

async function mints(engine: Engine, access: { session: string; key: string }) {
	const services = makeServicesFor(engine.repositories, { issuer: ORIGIN, environment: 'stage' })
	const fromSession = await mintToken(services, MINT_ENV, { app: APP, session: access.session, requestId: 'r' })
	const fromKey = await mintFromKey(services, MINT_ENV, { app: APP, key: access.key, requestId: 'r' })
	return { session: fromSession.result, key: fromKey.result }
}

async function json(response: Response): Promise<unknown> {
	return response.json()
}

/** The answer of an `/admin/rpc` call. */
async function result(response: Response): Promise<unknown> {
	return prop(await response.json(), 'result')
}

const scimError = (status: number, scimType?: string) => ({
	schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
	status: String(status),
	...(scimType === undefined ? {} : { scimType }),
})

const engines: [string, () => Engine | null, boolean][] = [
	['SQLite', () => sqliteEngine(), true],
	['Postgres', () => postgresEngine, hasPostgres],
]

for (const [name, engineOf, available] of engines) {
	describe.skipIf(!available)(`SCIM users on ${name}${available ? '' : ` — ${skipReason}`}`, () => {
		const fresh = async () => {
			const engine = engineOf()
			if (engine === null) throw new Error('no engine')
			// The Postgres schema is shared by the suite: each test starts from an empty installation.
			if (engine === postgresEngine) {
				for (
					const table of [
						'scim_users',
						'scim_tokens',
						'audit_events',
						'oauth_grants',
						'credentials',
						'sessions',
						'password_action_tokens',
						'password_credentials',
						'password_accounts',
						'grants',
						'principal_email_claims',
						'principals',
					]
				) {
					await engine.db.prepare(`DELETE FROM ${table}`).run()
				}
			}
			return installation(engine)
		}

		test('the connection test (a filter on a userName nobody has) is an empty list; anything without the token is 401', async () => {
			const iam = await fresh()
			const probe = await iam.scim('GET', `/Users?filter=${encodeURIComponent('userName eq "e9b4a0ff-1df3-4d1c-9c8b-61f6b3f4d1d7"')}`)
			expect(probe.status).toBe(200)
			expect(probe.headers.get('content-type')).toStartWith('application/scim+json')
			expect(await json(probe)).toEqual({
				schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
				totalResults: 0,
				startIndex: 1,
				itemsPerPage: 0,
				Resources: [],
			})
			for (const bearer of ['', 'px_wrongwrongwrongwrongwrongwr', 'not-a-key']) {
				const refused = await iam.scim('GET', '/Users', undefined, bearer)
				expect(refused.status).toBe(401)
				expect(refused.headers.get('www-authenticate')).toBe('Bearer')
				expect(await json(refused)).toMatchObject(scimError(401))
			}
			expect((await iam.scim('GET', '/ServiceProviderConfig', undefined, '')).status).toBe(401)
		})

		test('create, get, list by userName and externalId, and a second create of the same user is a conflict', async () => {
			const iam = await fresh()
			const created = await iam.scim('POST', '/Users', entraCreateUser('Test_User_ab6490ee@testuser.com', 'Test_User_fd0ea19b@testuser.com'))
			expect(created.status).toBe(201)
			const body = await json(created)
			const userId = String(prop(body, 'id'))
			expect(created.headers.get('location')).toBe(`${BASE}/Users/${userId}`)
			expect(body).toMatchObject({
				schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
				id: userId,
				externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
				userName: 'Test_User_ab6490ee@testuser.com',
				name: { givenName: 'givenName', familyName: 'familyName' },
				active: true,
				emails: [{ value: 'Test_User_fd0ea19b@testuser.com', type: 'work', primary: true }],
				meta: { resourceType: 'User', location: `${BASE}/Users/${userId}` },
			})
			// An internal user its first OIDC login claims: the mailbox normalized, the spelling the label.
			const principal = await iam.engine.repositories.principals.getPrincipalById(userId)
			expect(principal).toMatchObject({
				type: 'user',
				email: 'test_user_fd0ea19b@testuser.com',
				label: 'Test_User_fd0ea19b@testuser.com',
				external_id: null,
				affiliation: 'internal',
				disabled_at: null,
				activated_at: null,
			})

			expect(await json(await iam.scim('GET', `/Users/${userId}`))).toEqual(body)
			// userName compares case-insensitively.
			const byName = await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent('userName eq "test_user_AB6490EE@testuser.com"')}`))
			expect(byName).toMatchObject({ totalResults: 1, Resources: [{ id: userId }] })
			const byExternal = await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef"')}`))
			expect(byExternal).toMatchObject({ totalResults: 1, Resources: [{ id: userId }] })

			const again = await iam.scim('POST', '/Users', entraCreateUser('Test_User_ab6490ee@testuser.com', 'other@testuser.com'))
			expect(again.status).toBe(409)
			expect(await json(again)).toMatchObject(scimError(409, 'uniqueness'))
			expect((await iam.scim('GET', '/Users/no-such-user')).status).toBe(404)
		})

		test('PATCH of multi-valued and single-valued attributes moves the mailbox and renames the user', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('ann@testuser.com', 'ann@testuser.com'))), 'id'))
			const patched = await iam.scim('PATCH', `/Users/${userId}`, entraPatchMultiValued('Ann.New@testuser.com'))
			expect(patched.status).toBe(200)
			expect(await json(patched)).toMatchObject({ emails: [{ value: 'Ann.New@testuser.com' }], name: { familyName: 'updatedFamilyName' } })
			expect(await iam.engine.repositories.principals.getUserByEmail('ann.new@testuser.com')).toMatchObject({ id: userId })
			expect(await iam.engine.repositories.principals.getUserByEmail('ann@testuser.com')).toBeNull()

			const renamed = await json(await iam.scim('PATCH', `/Users/${userId}`, entraPatchUserName('5b50642d@testuser.com')))
			expect(renamed).toMatchObject({ userName: '5b50642d@testuser.com' })
			// An attribute IAM does not store is accepted and ignored, not refused.
			const ignored = await iam.scim('PATCH', `/Users/${userId}`, {
				schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
				Operations: [
					{ op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber', value: '701984' },
					{ op: 'Replace', path: 'title', value: 'Engineer' },
				],
			})
			expect(ignored.status).toBe(200)
			// Another user's mailbox is a conflict.
			await seedUser(iam.engine, 'taken@testuser.com')
			const taken = await iam.scim('PATCH', `/Users/${userId}`, entraPatchMultiValued('taken@testuser.com'))
			expect(taken.status).toBe(409)
		})

		test('PUT replaces the attributes and keeps active when the body leaves it out', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('bob@testuser.com', 'bob@testuser.com'))), 'id'))
			const replaced = await iam.scim('PUT', `/Users/${userId}`, {
				schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
				userName: 'bob@testuser.com',
				emails: [{ value: 'bob@testuser.com', type: 'work', primary: true }],
				displayName: 'Bob',
			})
			expect(replaced.status).toBe(200)
			const body = await json(replaced)
			expect(body).toMatchObject({ displayName: 'Bob', active: true })
			expect(prop(body, 'externalId')).toBeUndefined()
			expect(prop(body, 'name')).toBeUndefined()
		})

		test('active=false revokes every way in at once: the next mint from the existing session or key is refused', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('carol@testuser.com', 'carol@testuser.com'))), 'id'))
			await iam.engine.db.prepare(`INSERT INTO grants (id, principal_id, permissions, app, created_at) VALUES (?, ?, '["notes.read"]', ?, ?)`)
				.bind(id('g'), userId, APP, now()).run()
			const access = await accessOf(iam.engine, userId)
			const consoleBearer = await adminTokenFor(iam.engine.repositories, userId, { issuer: ORIGIN })
			expect(await mints(iam.engine, access)).toMatchObject({ session: { ok: true }, key: { ok: true } })

			const disabled = await iam.scim('PATCH', `/Users/${userId}`, entraDisable)
			expect(disabled.status).toBe(200)
			expect(await json(disabled)).toMatchObject({ active: false })

			// The very next request with what the person already holds, not after a token lifetime.
			expect(await mints(iam.engine, access)).toEqual({
				session: { ok: false, reason: 'invalid_session' },
				key: { ok: false, reason: 'invalid_key' },
			})
			expect((await iam.rpc(consoleBearer, 'me')).status).toBe(403)
			const grant = await iam.engine.db.prepare('SELECT revoked_at FROM oauth_grants WHERE id = ?').bind(access.grant).first<
				{ revoked_at: number | null }
			>()
			expect(grant?.revoked_at).not.toBeNull()
			const pending = await iam.engine.db
				.prepare('SELECT COUNT(*) AS n FROM password_action_tokens WHERE principal_id = ? AND consumed_at IS NULL')
				.bind(userId)
				.first<{ n: number | string }>()
			expect(Number(pending?.n)).toBe(0)
			const audit = await iam.engine.db
				.prepare(`SELECT principal_id, principal_label, app, metadata FROM audit_events WHERE action = 'iam.principal.disable' AND resource_id = ?`)
				.bind(userId)
				.all<{ principal_id: string | null; principal_label: string; app: string; metadata: string }>()
			expect(audit.results.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }))).toEqual([
				{ principal_id: null, principal_label: 'scim', app: 'propustka', metadata: { via: 'scim', token: expect.any(String) } },
			])

			// Re-enabled, in the pre-compliance spelling: the person signs in again; nothing issued before comes back.
			const enabled = await iam.scim('PATCH', `/Users/${userId}`, {
				schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
				Operations: [{ op: 'Replace', path: 'active', value: 'True' }],
			})
			expect(await json(enabled)).toMatchObject({ active: true })
			expect(await mints(iam.engine, access)).toEqual({
				session: { ok: false, reason: 'invalid_session' },
				key: { ok: false, reason: 'invalid_key' },
			})
			const next = await accessOf(iam.engine, userId)
			expect(await mints(iam.engine, next)).toMatchObject({ session: { ok: true }, key: { ok: true } })
		})

		test('the pre-compliance PATCH forms deactivate too: "False" as a string, and a pathless value object', async () => {
			const iam = await fresh()
			for (const body of [entraDisableLegacy, entraPathless({ active: false }), entraPathless({ active: 'false', 'name.givenName': 'Dee' })]) {
				const userId = String(
					prop(await json(await iam.scim('POST', '/Users', entraCreateUser(`${id('u')}@testuser.com`, `${id('m')}@testuser.com`, id('x')))), 'id'),
				)
				const access = await accessOf(iam.engine, userId)
				const patched = await iam.scim('PATCH', `/Users/${userId}`, body)
				expect(patched.status).toBe(200)
				expect(await json(patched)).toMatchObject({ active: false })
				expect(await mints(iam.engine, access)).toMatchObject({ session: { ok: false }, key: { ok: false } })
			}
		})

		test('DELETE deprovisions at once, the user is gone for SCIM, and a later create links the same principal again', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('dan@testuser.com', 'dan@testuser.com'))), 'id'))
			const access = await accessOf(iam.engine, userId)
			const deleted = await iam.scim('DELETE', `/Users/${userId}`)
			expect(deleted.status).toBe(204)
			expect(await mints(iam.engine, access)).toEqual({
				session: { ok: false, reason: 'invalid_session' },
				key: { ok: false, reason: 'invalid_key' },
			})
			expect((await iam.scim('GET', `/Users/${userId}`)).status).toBe(404)
			expect((await iam.scim('DELETE', `/Users/${userId}`)).status).toBe(404)
			expect(await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent('userName eq "dan@testuser.com"')}`))).toMatchObject({
				totalResults: 0,
			})
			expect(await json(await iam.scim('GET', '/Users'))).toMatchObject({ totalResults: 0 })
			// The principal and its history stay.
			expect(await iam.engine.repositories.principals.getPrincipalById(userId)).toMatchObject({ disabled_at: expect.any(Number) })

			const recreated = await iam.scim('POST', '/Users', entraCreateUser('dan@testuser.com', 'dan@testuser.com'))
			expect(recreated.status).toBe(201)
			expect(await json(recreated)).toMatchObject({ id: userId, active: true })
		})

		test('a person who signed in before provisioning is found by userName and taken over, by PATCH or by POST', async () => {
			const iam = await fresh()
			const early = await seedUser(iam.engine, 'Early@Testuser.com')
			const found = await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent('userName eq "early@testuser.com"')}`))
			expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: early, userName: 'Early@Testuser.com', active: true }] })
			// Unprovisioned people are not listed until the provider takes them over.
			expect(await json(await iam.scim('GET', '/Users'))).toMatchObject({ totalResults: 0 })
			const linked = await iam.scim('PATCH', `/Users/${early}`, {
				schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
				Operations: [{ op: 'Add', path: 'externalId', value: 'early-object-id' }],
			})
			expect(await json(linked)).toMatchObject({ id: early, externalId: 'early-object-id' })
			expect(await json(await iam.scim('GET', '/Users'))).toMatchObject({ totalResults: 1 })

			const other = await seedUser(iam.engine, 'other@testuser.com')
			const adopted = await iam.scim('POST', '/Users', entraCreateUser('other@testuser.com', 'other@testuser.com', 'other-object-id'))
			expect(adopted.status).toBe(201)
			expect(await json(adopted)).toMatchObject({ id: other, externalId: 'other-object-id' })
		})

		test("the installation's bootstrap administrator is out of SCIM's reach", async () => {
			const iam = await fresh()
			expect(await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${ROOT}"`)}`))).toMatchObject({ totalResults: 0 })
			expect((await iam.scim('GET', `/Users/${iam.root}`)).status).toBe(404)
			expect((await iam.scim('PATCH', `/Users/${iam.root}`, entraDisable)).status).toBe(404)
			expect((await iam.scim('POST', '/Users', entraCreateUser(ROOT, ROOT))).status).toBe(409)
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('eve@testuser.com', 'eve@testuser.com'))), 'id'))
			expect((await iam.scim('PATCH', `/Users/${userId}`, entraPatchMultiValued(ROOT))).status).toBe(409)
		})

		test('SCIM reaches no external person, and never creates the bootstrap administrator', async () => {
			const iam = await fresh()
			const guest = await seedUser(iam.engine, 'guest@partner.example')
			await iam.engine.db.prepare(`UPDATE principals SET affiliation = 'external' WHERE id = ?`).bind(guest).run()
			expect((await iam.scim('GET', `/Users/${guest}`)).status).toBe(404)
			expect((await iam.scim('PATCH', `/Users/${guest}`, entraDisable)).status).toBe(404)
			expect(await json(await iam.scim('GET', `/Users?filter=${encodeURIComponent('userName eq "guest@partner.example"')}`))).toMatchObject({
				totalResults: 0,
			})
			const claimed = await iam.scim('POST', '/Users', entraCreateUser('guest@partner.example', 'guest@partner.example'))
			expect(claimed.status).toBe(409)
			expect(await iam.engine.repositories.principals.getPrincipalById(guest)).toMatchObject({ affiliation: 'external', disabled_at: null })
			// A link an external principal holds anyway is neither listed nor counted.
			await iam.engine.db
				.prepare(`INSERT INTO scim_users (principal_id, user_name, user_name_key, created_at, updated_at) VALUES (?, 'guest', 'guest', ?, ?)`)
				.bind(guest, now(), now())
				.run()
			expect(await json(await iam.scim('GET', '/Users'))).toMatchObject({ totalResults: 0, itemsPerPage: 0 })

			const breakGlass = await iam.scim('POST', '/Users', { ...entraCreateUser(BREAK_GLASS, BREAK_GLASS), active: false })
			expect(breakGlass.status).toBe(409)
			expect(await iam.engine.repositories.principals.getUserByEmail(BREAK_GLASS)).toBeNull()
		})

		test('a moved mailbox ends the sessions and switches password login off; other attributes leave them', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('fay@testuser.com', 'fay@testuser.com'))), 'id'))
			await iam.engine.db.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at) VALUES (?, 'enabled', ?, ?)`)
				.bind(userId, now(), now()).run()
			await iam.engine.db
				.prepare(`INSERT INTO password_credentials (principal_id, algorithm, parameters, salt, password_hash, created_at, updated_at)
					VALUES (?, 'pbkdf2-sha256', '{}', 'salt', 'hash', ?, ?)`)
				.bind(userId, now(), now())
				.run()
			const kept = await accessOf(iam.engine, userId)
			const renamed = await iam.scim('PATCH', `/Users/${userId}`, entraPathless({ displayName: 'Fay' }))
			expect(renamed.status).toBe(200)
			expect(await mints(iam.engine, kept)).toMatchObject({ session: { ok: true }, key: { ok: true } })

			const moved = await iam.scim('PATCH', `/Users/${userId}`, entraPatchMultiValued('fay.other@testuser.com'))
			expect(moved.status).toBe(200)
			expect(await json(moved)).toMatchObject({ active: true })
			expect(await mints(iam.engine, kept)).toMatchObject({ session: { ok: false, reason: 'invalid_session' } })
			const account = await iam.engine.db.prepare('SELECT state FROM password_accounts WHERE principal_id = ?').bind(userId).first<{ state: string }>()
			expect(account?.state).toBe('disabled')
			const verifiers = await iam.engine.db.prepare('SELECT COUNT(*) AS n FROM password_credentials WHERE principal_id = ?').bind(userId)
				.first<{ n: number | string }>()
			expect(Number(verifiers?.n)).toBe(0)
			const pending = await iam.engine.db
				.prepare('SELECT COUNT(*) AS n FROM password_action_tokens WHERE principal_id = ? AND consumed_at IS NULL')
				.bind(userId)
				.first<{ n: number | string }>()
			expect(Number(pending?.n)).toBe(0)
			const update = await iam.engine.db
				.prepare(`SELECT metadata FROM audit_events WHERE action = 'iam.scim.user.update' AND resource_id = ? ORDER BY id DESC`)
				.bind(userId)
				.first<{ metadata: string }>()
			expect(JSON.parse(update?.metadata ?? '{}')).toMatchObject({ via: 'scim', mailboxMoved: true })
		})

		test('a write that read the person active does not enable them after a concurrent active=false', async () => {
			const iam = await fresh()
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('gil@testuser.com', 'gil@testuser.com'))), 'id'))
			const stale = await iam.engine.repositories.scim.getRecord(userId)
			if (stale === null) throw new Error('no record')
			expect((await iam.scim('PATCH', `/Users/${userId}`, entraDisable)).status).toBe(200)
			const services = makeServicesFor(iam.engine.repositories, { issuer: ORIGIN, environment: 'stage', bootstrapAdmins: new Set([ROOT]) })
			const written = await saveUser(services, { tokenId: 'tok', requestId: 'r' }, stale, { ...stateOf(stale), displayName: 'Late' })
			expect(written).toMatchObject({ display_name: 'Late', disabled_at: expect.any(Number) })

			// What a login racing the deprovisioning left behind ends when the person is enabled again.
			const raced = await accessOf(iam.engine, userId)
			const enabled = await iam.scim('PATCH', `/Users/${userId}`, { Operations: [{ op: 'replace', path: 'active', value: true }] })
			expect(await json(enabled)).toMatchObject({ active: true })
			expect(await mints(iam.engine, raced)).toEqual({
				session: { ok: false, reason: 'invalid_session' },
				key: { ok: false, reason: 'invalid_key' },
			})
		})

		test('a control character in a value or a filter is a 400, on every engine', async () => {
			const iam = await fresh()
			for (const filter of ['userName eq "a\\u0000b"', 'userName eq "a\u0000b"', 'externalId eq "x\u0001"']) {
				const answer = await iam.scim('GET', `/Users?filter=${encodeURIComponent(filter)}`)
				expect(answer.status).toBe(400)
				expect(await json(answer)).toMatchObject(scimError(400, 'invalidFilter'))
			}
			const created = await iam.scim('POST', '/Users', entraCreateUser('nul\u0000@testuser.com', 'nul@testuser.com'))
			expect(await json(created)).toMatchObject(scimError(400, 'invalidValue'))
			const userId = String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser('hal@testuser.com', 'hal@testuser.com'))), 'id'))
			const patched = await iam.scim('PATCH', `/Users/${userId}`, entraPathless({ displayName: 'H\u0000al' }))
			expect(await json(patched)).toMatchObject(scimError(400, 'invalidValue'))
		})

		test('the list pages with startIndex and count; an unsupported filter or op is a 400', async () => {
			const iam = await fresh()
			const ids: string[] = []
			for (const name of ['p1', 'p2', 'p3']) {
				ids.push(String(prop(await json(await iam.scim('POST', '/Users', entraCreateUser(`${name}@testuser.com`, `${name}@testuser.com`, name))), 'id')))
			}
			const page = await json(await iam.scim('GET', '/Users?startIndex=2&count=1'))
			expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1, Resources: [{ id: [...ids].sort()[1] }] })
			const filter = await iam.scim('GET', `/Users?filter=${encodeURIComponent('displayName co "p"')}`)
			expect(filter.status).toBe(400)
			expect(await json(filter)).toMatchObject(scimError(400, 'invalidFilter'))
			const op = await iam.scim('PATCH', `/Users/${ids[0]}`, { Operations: [{ op: 'move', path: 'userName', value: 'x' }] })
			expect(await json(op)).toMatchObject(scimError(400, 'invalidSyntax'))
			const noMailbox = await iam.scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'not-an-address' })
			expect(await json(noMailbox)).toMatchObject(scimError(400, 'invalidValue'))
		})

		test('the discovery documents, and the token an administrator rotates and revokes', async () => {
			const iam = await fresh()
			for (const path of ['/ServiceProviderConfig', '/ResourceTypes', '/ResourceTypes/User', '/Schemas']) {
				expect((await iam.scim('GET', path)).status).toBe(200)
			}
			expect(await json(await iam.scim('GET', '/ServiceProviderConfig'))).toMatchObject({ patch: { supported: true }, bulk: { supported: false } })
			expect((await iam.scim('GET', '/Groups')).status).toBe(404)

			const rotated = await result(await iam.rpc(await iam.rootBearer(), 'scim.rotateToken'))
			expect(rotated).toMatchObject({ endpoint: BASE, configured: true, createdAt: expect.any(Number) })
			expect((await iam.scim('GET', '/Users')).status).toBe(401)
			expect((await iam.scim('GET', '/Users', undefined, String(prop(rotated, 'token')))).status).toBe(200)
			const settings = await result(await iam.rpc(await iam.rootBearer(), 'scim.get'))
			expect(settings).toEqual({ endpoint: BASE, configured: true, createdAt: expect.any(Number) })
			expect(prop(settings, 'token')).toBeUndefined()

			expect(await result(await iam.rpc(await iam.rootBearer(), 'scim.revokeToken'))).toEqual({ endpoint: BASE, configured: false, createdAt: null })
			expect((await iam.scim('GET', '/Users', undefined, String(prop(rotated, 'token')))).status).toBe(401)
			const actions = await iam.engine.db
				.prepare(`SELECT action FROM audit_events WHERE action LIKE 'iam.scim.token.%' ORDER BY id`)
				.all<{ action: string }>()
			expect(actions.results.map((row) => row.action).slice(-3)).toEqual(['iam.scim.token.rotate', 'iam.scim.token.rotate', 'iam.scim.token.revoke'])

			// A key's token cannot manage it, even an installation administrator's.
			const keyBearer = await adminTokenFor(iam.engine.repositories, iam.root, { issuer: ORIGIN, session: false })
			expect((await iam.rpc(keyBearer, 'scim.rotateToken')).status).toBe(403)
		})
	})
}
