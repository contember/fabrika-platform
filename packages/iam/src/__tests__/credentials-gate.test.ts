// ADR-0083 §8: IAM's own key issuance to a machine caller meets the `credentials` mode Control mirrors for each
// application environment, and `apiKeys.provision` keys expire within 30 days. On SQLite always, and on Postgres when
// FABRIKA_TEST_POSTGRES_URL is set.

import { type AppSchema, buildAccessClaims, type IssueKeyInput } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterEach, describe, expect, test } from 'bun:test'
import { grantIdOf } from '../admin/grant-support'
import { createIamApp } from '../app'
import { resolveCaller } from '../auth'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import type { Env } from '../env'
import { resolvePermissionsAt } from '../resolve'
import { createIamRpc } from '../rpc'
import { getSigner } from '../signing'
import { adminTokenFor, createHarness, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'
import { APP, membershipFixture, NOTES_SCHEMA, ORIGIN, PendingWork } from './helpers/membership'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`credentials-gate.test.ts Postgres half ${skipReason}`)

const CONSOLE = 'vozka'
const STAGE = 'notes@stage'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-credentials-gate-suite'
const DAY = 24 * 3600
const now = () => Math.floor(Date.now() / 1000)

const CONSOLE_SCHEMA: AppSchema = {
	displayName: 'Console',
	scopes: [{ type: 'app', label: 'App' }],
	actions: [{ action: 'deploy.read', description: 'Read runs' }],
	roles: {},
}

const backends = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const h = createHarness()
			return Promise.resolve({ repositories: h.repositories, close: () => Promise.resolve(h.sqlite.close()) })
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const pg = await createPostgres('iam_credentials_gate')
			return { repositories: createPostgresIamRepositories(pg.db), close: () => pg.close() }
		},
	},
] as const

interface Answer {
	readonly status: number
	readonly result: unknown
	readonly message: string
}

/** `PUT /admin/apps/:app/schema` as `bearer`; its refusal is a plain `{ error }`. */
async function putSchemaAs(env: Env, bearer: string, app: string, schema: AppSchema): Promise<{ status: number; message: string }> {
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/apps/${encodeURIComponent(app)}/schema`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
			body: JSON.stringify(schema),
		}),
		env,
		{ waitUntil() {} },
	)
	const body: { error?: unknown } = await response.json()
	return { status: response.status, message: typeof body.error === 'string' ? body.error : '' }
}

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a key issued straight through IAM (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		async function world() {
			const opened = await backend.open()
			closing = opened.close
			const repositories: IamRepositories = opened.repositories
			const f = await membershipFixture(repositories)
			expect((await f.putSchema(NOTES_SCHEMA, STAGE)).status).toBe(200)
			expect((await f.putSchema(CONSOLE_SCHEMA, CONSOLE)).status).toBe(200)
			const ada = await f.person('ada')
			await repositories.grants.createGrant({ principalId: ada.id, roleKey: 'admin' })
			const env: Env = {
				DB: unusedDatabase,
				REPOSITORIES: repositories,
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

			async function call(request: Request): Promise<Answer> {
				const response = await createIamApp().fetch(request, env, { waitUntil() {} })
				const body: { result?: unknown; error?: unknown } = await response.json()
				const error = body.error
				const message = typeof error === 'string'
					? error
					: typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
					? error.message
					: ''
				return { status: response.status, result: body.result ?? body, message }
			}

			const rpc = (bearer: string, method: string, input: unknown): Promise<Answer> =>
				call(
					new Request(`${ORIGIN}/admin/rpc`, {
						method: 'POST',
						headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
						body: JSON.stringify({ method, input }),
					}),
				)
			/** The bootstrap's `POST /admin/api-keys`. */
			const bootstrap = (bearer: string, body: unknown): Promise<Answer> =>
				call(
					new Request(`${ORIGIN}/admin/api-keys`, {
						method: 'POST',
						headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
						body: JSON.stringify(body),
					}),
				)

			let revision = 0
			/** Control's mirror of an environment's gates, as its protection change or its maintenance pass writes it. */
			async function mirror(app: string, credentials?: 'off' | 'person' | 'refuse'): Promise<void> {
				revision += 1
				const answer = await rpc(PROVISIONING_KEY, 'grantApproval.set', {
					app,
					required: false,
					revision,
					...(credentials === undefined ? {} : { credentials }),
				})
				expect(answer.status).toBe(200)
			}

			const keyOf = (answer: Answer): { principalId: string; apiKey: string } => {
				const value = answer.result
				if (
					typeof value !== 'object' || value === null || !('principalId' in value) || !('apiKey' in value) || typeof value.principalId !== 'string'
					|| typeof value.apiKey !== 'string'
				) throw new Error(`no key: ${answer.status} ${answer.message}`)
				return { principalId: value.principalId, apiKey: value.apiKey }
			}

			// The machine caller: a `px_` key holding `iam.admin`, as the bootstrap gives the first one.
			const machine = keyOf(await bootstrap(PROVISIONING_KEY, { label: 'ci administrator', type: 'service', roleKey: 'admin' })).apiKey
			const consoleToken = async () => adminTokenFor(repositories, ada.id, { issuer: ORIGIN })
			const asAda = async (method: string, input: unknown) => rpc(await consoleToken(), method, input)

			/** A key at `notes@prod` holding `support`. */
			const notesKey = (overrides: Record<string, unknown> = {}) => ({
				label: 'nightly export',
				type: 'service',
				app: APP,
				roleKey: 'support',
				expiresAt: now() + 7 * DAY,
				...overrides,
			})
			/** A key at Control holding a read of every environment of `notes`. */
			const controlKey = (overrides: Record<string, unknown> = {}) => ({
				label: 'deploy watcher',
				type: 'service',
				app: CONSOLE,
				permissions: ['deploy.read'],
				scopeType: 'app',
				scopeValue: 'notes',
				expiresAt: now() + 7 * DAY,
				...overrides,
			})
			const services = async () => (await repositories.principals.listPrincipals({ type: 'service', limit: 100 })).length

			return { f, repositories, env, ada, machine, rpc, asAda, bootstrap, mirror, keyOf, notesKey, controlKey, services }
		}

		test("a px_ key with `iam.admin`: refused under `person`, naming Control's request path, and issued under `off`", async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			const before = await w.services()
			const refused = await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())
			expect(refused.status).toBe(403)
			expect(refused.message).toContain(APP)
			expect(refused.message).toContain('approvals.requests.create')
			expect(refused.message).toContain('iam.apiKeys.provision')
			expect(refused.message).toContain('fabrika control access request-key')
			expect(await w.services()).toBe(before)

			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())).status).toBe(200)
		})

		test('a person in the console issues under `person`', async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			expect((await w.asAda('apiKeys.provision', w.notesKey())).status).toBe(200)
		})

		test('`refuse` refuses a machine caller and names the mode', async () => {
			const w = await world()
			await w.mirror(APP, 'refuse')
			const refused = await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())
			expect(refused.status).toBe(403)
			expect(refused.message).toContain('`refuse`')
		})

		test('after an upgrade nothing is mirrored yet: the machine caller is refused until Control writes the mode', async () => {
			const w = await world()
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())).status).toBe(403)
			// A grant gate written before the mirror carries no mode, which reads the same.
			await w.mirror(APP)
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())).status).toBe(403)
			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())).status).toBe(200)
		})

		test('a key that spans environments takes the strictest of them', async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			await w.mirror(STAGE, 'off')
			const control = await w.rpc(w.machine, 'apiKeys.provision', w.controlKey())
			expect(control.status).toBe(403)
			expect(control.message).toContain(APP)
			expect(control.message).not.toContain(STAGE)
			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.controlKey())).status).toBe(200)

			// Another application IAM knows and has no mode for: a key at notes ignores it, one at every application does not.
			expect((await w.f.putSchema(NOTES_SCHEMA, 'shop@prod')).status).toBe(200)
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.controlKey())).status).toBe(200)
			const global = await w.rpc(w.machine, 'apiKeys.provision', w.controlKey({ scopeType: null, scopeValue: null }))
			expect([global.status, global.message.includes('shop@prod')]).toEqual([403, true])
			const crossApp = await w.rpc(w.machine, 'apiKeys.provision', { label: 'everything', type: 'service', permissions: ['*'], expiresAt: now() + DAY })
			expect([crossApp.status, crossApp.message.includes('shop@prod')]).toEqual([403, true])
			await w.mirror('shop@prod', 'off')
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.controlKey({ scopeType: null, scopeValue: null }))).status).toBe(200)
		})

		test('the exceptions keep their rule: the provisioning key issues workload, membership and bootstrap keys', async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			const expiresAt = now() + 7 * DAY
			expect((await w.bootstrap(PROVISIONING_KEY, { label: 'first machine', type: 'service', app: APP, roleKey: 'support' })).status).toBe(201)
			expect((await w.rpc(PROVISIONING_KEY, 'workloads.issueKey', { app: APP, kind: 'job', name: 'nightly', expiresAt, keep: null })).status).toBe(200)
			expect((await w.rpc(PROVISIONING_KEY, 'membershipKeys.issue', { app: APP, expiresAt, keep: null })).status).toBe(200)

			// Any other machine caller meets the mode on the same paths, the bootstrap's included.
			const refusals = [
				await w.rpc(w.machine, 'workloads.issueKey', { app: APP, kind: 'job', name: 'nightly', expiresAt, keep: null }),
				await w.rpc(w.machine, 'membershipKeys.issue', { app: APP, expiresAt, keep: null }),
				await w.bootstrap(w.machine, w.notesKey()),
			]
			expect(refusals.map((answer) => [answer.status, answer.message.includes('`credentials` mode')])).toEqual([[403, true], [403, true], [403, true]])
		})

		test('rotating a key and issuing a share link meet the mode for a machine caller, not for a person', async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			const issued = w.keyOf(await w.asAda('apiKeys.provision', w.notesKey()))
			await w.mirror(APP, 'person')
			const rotated = await w.rpc(w.machine, 'apiKeys.rotate', { principalId: issued.principalId })
			expect([rotated.status, rotated.message.includes('`credentials` mode')]).toEqual([403, true])
			expect((await w.asAda('apiKeys.rotate', { principalId: issued.principalId })).status).toBe(200)

			// A share link of Control's that reads every environment of notes.
			const link = { app: CONSOLE, grants: [{ action: 'deploy.read', scope: { type: 'app', value: 'notes' } }], expiresAt: now() + DAY }
			const linked = await w.rpc(w.machine, 'shareLinks.issue', link)
			expect([linked.status, linked.message.includes('`credentials` mode')]).toEqual([403, true])
			expect((await w.asAda('shareLinks.issue', link)).status).toBe(200)
		})

		test("IAM's `issueKey`: a machine issuer meets the mode for a key for someone else, never for its own", async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			await w.mirror(STAGE, 'off')
			const holder = w.keyOf(await w.asAda('apiKeys.provision', w.controlKey()))
			await w.mirror(APP, 'person')
			const rpc = createIamRpc(w.env, new PendingWork())
			const ask = (credential: string, extra: Partial<IssueKeyInput>): IssueKeyInput => ({
				app: CONSOLE,
				credential,
				requestId: crypto.randomUUID(),
				expiresAt: now() + DAY,
				...extra,
			})
			const notes = { type: 'app', value: 'notes' }
			const service = { service: { label: 'reader', permissions: ['deploy.read'], scope: notes } }
			expect(await rpc.issueKey(ask(holder.apiKey, service))).toEqual({ ok: false, reason: 'not_allowed' })
			expect(await rpc.issueKey(ask(holder.apiKey, { permissions: [{ action: 'deploy.read', scope: notes }] }))).toEqual({
				ok: false,
				reason: 'not_allowed',
			})
			expect(await rpc.issueKey(ask(holder.apiKey, { principalId: holder.principalId }))).toMatchObject({ ok: true })

			// A person signed in at Control issues the same key.
			const person = await w.repositories.principals.getPrincipalById(w.ada.id)
			if (person === null) throw new Error('no person')
			const sessionAt = async (app: string, terminal?: { id: string; label: string }) => {
				const issuedAt = now()
				return (await getSigner(TEST_SIGNING_ENV)).sign(buildAccessClaims({
					iss: ORIGIN,
					app,
					subject: person.id,
					type: 'user',
					label: person.label,
					session: true,
					...(terminal === undefined ? {} : { terminal }),
					permissions: await resolvePermissionsAt(w.f.services, person, app),
					issuedAt,
					expiresAt: issuedAt + 300,
				}))
			}
			expect(await rpc.issueKey(ask(await sessionAt(CONSOLE), service))).toMatchObject({ ok: true })

			// Counted as a person only as the admin path counts one: never at a terminal, never at an application's audience.
			expect(await rpc.issueKey(ask(await sessionAt(CONSOLE, { id: 'terminal-1', label: 'Front desk' }), service))).toEqual({
				ok: false,
				reason: 'not_allowed',
			})
			const personAt = async (app: string, credential: string) => {
				const resolved = await resolveCaller(w.f.services, w.env, { app, credential, requestId: 'r' })
				return resolved.ok ? resolved.caller.person === true : null
			}
			expect(await personAt(CONSOLE, await sessionAt(CONSOLE))).toBe(true)
			expect(await personAt(CONSOLE, await sessionAt(CONSOLE, { id: 'terminal-1', label: 'Front desk' }))).toBe(false)
			expect(await personAt(APP, await sessionAt(APP))).toBe(false)

			await w.mirror(APP, 'off')
			expect(await rpc.issueKey(ask(holder.apiKey, service))).toMatchObject({ ok: true })
		})

		test("`apiKeys.provision` takes an expiry at most 30 days ahead; rotation keeps a key's own or takes one inside it", async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			const noExpiry = await w.asAda('apiKeys.provision', w.notesKey({ expiresAt: undefined }))
			expect([noExpiry.status, noExpiry.message]).toEqual([400, 'a key expires: expiresAt is required, at most 30 days ahead'])
			expect((await w.asAda('apiKeys.provision', w.notesKey({ expiresAt: null }))).status).toBe(400)
			expect((await w.asAda('apiKeys.provision', w.notesKey({ expiresAt: now() + 31 * DAY }))).status).toBe(400)
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey({ expiresAt: now() + 31 * DAY }))).status).toBe(400)
			expect((await w.asAda('apiKeys.provision', w.notesKey({ expiresAt: now() + 30 * DAY - 60 }))).status).toBe(200)

			// A key from before the ceiling, which never expires, is untouched: rotation keeps its expiry.
			const old = w.keyOf(await w.bootstrap(PROVISIONING_KEY, { label: 'old', type: 'service', app: APP, roleKey: 'support' }))
			expect((await w.asAda('apiKeys.rotate', { principalId: old.principalId })).status).toBe(200)
			const live = (await w.repositories.credentials.listCredentialsForPrincipal(old.principalId)).find((row) => row.revoked_at === null)
			expect(live?.expires_at).toBeNull()
			expect((await w.asAda('apiKeys.rotate', { principalId: old.principalId, expiresAt: null })).status).toBe(400)
			expect((await w.asAda('apiKeys.rotate', { principalId: old.principalId, expiresAt: now() + 31 * DAY })).status).toBe(400)
			expect((await w.asAda('apiKeys.rotate', { principalId: old.principalId, expiresAt: now() + 7 * DAY })).status).toBe(200)
		})

		test("a machine caller's grant to a key at a protected environment meets the mode; a person and the provisioning key make it", async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			const issued = w.keyOf(await w.asAda('apiKeys.provision', w.notesKey()))
			await w.mirror(APP, 'person')
			const held = async () => (await w.repositories.grants.listGrants(issued.principalId)).map((row) => row.role_key).sort()
			const [own] = await w.repositories.grants.listGrants(issued.principalId)
			if (own === undefined) throw new Error('the key holds no grant')

			const widen = { principalId: issued.principalId, app: APP, roleKey: 'staff' }
			const created = await w.rpc(w.machine, 'grants.create', widen)
			expect([created.status, created.message.includes('`credentials` mode')]).toEqual([403, true])
			const updated = await w.rpc(w.machine, 'grants.update', { id: grantIdOf(own), roleKey: 'staff' })
			expect([updated.status, updated.message.includes('`credentials` mode')]).toEqual([403, true])
			expect(await held()).toEqual(['support'])

			// Under `refuse` too, and under `off` the machine caller grants as before.
			await w.mirror(APP, 'refuse')
			expect((await w.rpc(w.machine, 'grants.create', widen)).message).toContain('`refuse`')
			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'grants.update', { id: grantIdOf(own), roleKey: 'staff' })).status).toBe(200)
			expect(await held()).toEqual(['staff'])

			await w.mirror(APP, 'person')
			expect((await w.asAda('grants.create', { ...widen, roleKey: 'starter' })).status).toBe(200)
			expect((await w.rpc(PROVISIONING_KEY, 'grants.create', { ...widen, roleKey: 'support' })).status).toBe(200)
			expect(await held()).toEqual(['staff', 'starter', 'support'])

			// A grant to a person is not a key's: the machine caller's grant to Ada keeps its rule.
			expect((await w.rpc(w.machine, 'grants.create', { principalId: w.ada.id, app: APP, roleKey: 'support' })).status).toBe(200)
		})

		test("a Control key issued at an unprotected application cannot be widened by a machine caller's grant to a protected one", async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			await w.mirror(STAGE, 'off')
			expect((await w.f.putSchema(NOTES_SCHEMA, 'sandbox@dev')).status).toBe(200)
			await w.mirror('sandbox@dev', 'off')
			const sandbox = w.keyOf(await w.rpc(w.machine, 'apiKeys.provision', w.controlKey({ scopeValue: 'sandbox' })))
			const [own] = await w.repositories.grants.listGrants(sandbox.principalId)
			if (own === undefined) throw new Error('the key holds no grant')
			const atNotes = { principalId: sandbox.principalId, app: CONSOLE, permissions: ['deploy.read'], scopeType: 'app', scopeValue: 'notes' }

			const created = await w.rpc(w.machine, 'grants.create', atNotes)
			expect([created.status, created.message.includes(APP)]).toEqual([403, true])
			const moved = await w.rpc(w.machine, 'grants.update', { id: grantIdOf(own), permissions: ['deploy.read'], scopeType: 'app', scopeValue: 'notes' })
			expect(moved.status).toBe(403)
			expect((await w.repositories.grants.listGrants(sandbox.principalId)).map((row) => row.scope_value)).toEqual(['sandbox'])

			expect((await w.asAda('grants.create', atNotes)).status).toBe(200)
			expect(
				(await w.rpc(PROVISIONING_KEY, 'grants.update', { id: grantIdOf(own), permissions: ['deploy.read'], scopeType: 'app', scopeValue: 'notes' }))
					.status,
			)
				.toBe(200)
		})

		test("changing a role or a policy at a protected environment is refused to a machine caller, and a person's change is not", async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			const policy = { app: APP, key: 'reviewer', policy: { name: 'Reviewer', permissions: ['notes.read'] } }
			expect((await w.rpc(PROVISIONING_KEY, 'policies.create', { app: APP, policy: { key: 'reviewer', ...policy.policy } })).status).toBe(200)
			const wider = { ...policy, policy: { name: 'Reviewer', permissions: ['notes.read', 'notes.admin'] } }
			const refused = await w.rpc(w.machine, 'policies.update', wider)
			expect([refused.status, refused.message.includes('`credentials` mode')]).toEqual([403, true])
			const schema = await putSchemaAs(w.env, w.machine, APP, NOTES_SCHEMA)
			expect([schema.status, schema.message.includes('`credentials` mode')]).toEqual([403, true])

			expect((await w.asAda('policies.update', wider)).status).toBe(200)
			expect((await putSchemaAs(w.env, PROVISIONING_KEY, APP, NOTES_SCHEMA)).status).toBe(200)
			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'policies.update', policy)).status).toBe(200)
			expect((await putSchemaAs(w.env, w.machine, APP, NOTES_SCHEMA)).status).toBe(200)
			// A plain id is no application environment: its vocabulary keeps the installation's rule.
			expect((await putSchemaAs(w.env, w.machine, 'reports', { scopes: [], actions: [{ action: 'reports.read' }], roles: {} })).status).toBe(200)
		})

		/** The actions `principalId` holds at `app`, as its key resolves them at an exchange. */
		const actionsAt = async (w: Awaited<ReturnType<typeof world>>, principalId: string, app: string): Promise<string[]> => {
			const principal = await w.repositories.principals.getPrincipalById(principalId)
			if (principal === null) throw new Error('no principal')
			return (await resolvePermissionsAt(w.f.services, principal, app)).map((entry) => entry.action).sort()
		}

		test('a policy deleted and created again under its key, wider, is refused to a machine caller: a key naming the key holds it', async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			const reviewer = { key: 'reviewer', name: 'Reviewer', permissions: ['notes.read'] }
			expect((await w.asAda('policies.create', { app: APP, policy: reviewer })).status).toBe(200)
			const issued = w.keyOf(await w.asAda('apiKeys.provision', w.notesKey({ roleKey: 'reviewer' })))
			await w.mirror(APP, 'person')

			// Deleting narrows, so the machine caller may; the grant keeps naming the key, which no row holds now.
			expect((await w.rpc(w.machine, 'policies.delete', { app: APP, key: 'reviewer' })).status).toBe(200)
			expect(await actionsAt(w, issued.principalId, APP)).toEqual([])
			const wider = { ...reviewer, permissions: ['notes.read', 'notes.write', 'notes.admin'] }
			const refused = await w.rpc(w.machine, 'policies.create', { app: APP, policy: wider })
			expect([refused.status, refused.message.includes('`credentials` mode')]).toEqual([403, true])
			expect(await w.repositories.appSchema.getRole(APP, 'reviewer')).toBeNull()
			expect(await actionsAt(w, issued.principalId, APP)).toEqual([])

			// A person, the provisioning key, and a machine caller under `off` create it.
			expect((await w.asAda('policies.create', { app: APP, policy: wider })).status).toBe(200)
			expect((await w.asAda('policies.delete', { app: APP, key: 'reviewer' })).status).toBe(200)
			expect((await w.rpc(PROVISIONING_KEY, 'policies.create', { app: APP, policy: reviewer })).status).toBe(200)
			expect(await actionsAt(w, issued.principalId, APP)).toEqual(['notes.read'])
			expect((await w.rpc(PROVISIONING_KEY, 'policies.delete', { app: APP, key: 'reviewer' })).status).toBe(200)
			await w.mirror(APP, 'off')
			expect((await w.rpc(w.machine, 'policies.create', { app: APP, policy: wider })).status).toBe(200)
		})

		test('a role a deploy removed, created again as a policy by a machine caller, is refused: the keys still naming it would hold it', async () => {
			const w = await world()
			await w.mirror(APP, 'off')
			const issued = w.keyOf(await w.asAda('apiKeys.provision', w.notesKey({ roleKey: 'starter' })))
			await w.mirror(APP, 'person')
			const { starter: _removed, ...roles } = NOTES_SCHEMA.roles
			expect((await putSchemaAs(w.env, PROVISIONING_KEY, APP, { ...NOTES_SCHEMA, roles })).status).toBe(200)
			expect((await w.repositories.grants.listGrants(issued.principalId)).map((row) => row.role_key)).toEqual(['starter'])

			const starter = { key: 'starter', name: 'Starter', permissions: ['notes.read', 'notes.write', 'notes.admin'] }
			const refused = await w.rpc(w.machine, 'policies.create', { app: APP, policy: starter })
			expect([refused.status, refused.message.includes('`credentials` mode')]).toEqual([403, true])
			expect(await actionsAt(w, issued.principalId, APP)).toEqual([])
		})

		test("at Control's audience too: a policy created again wider does not reach the Control keys naming it", async () => {
			const w = await world()
			await w.mirror(APP, 'person')
			await w.mirror(STAGE, 'off')
			const withSecrets = { ...CONSOLE_SCHEMA, actions: [...CONSOLE_SCHEMA.actions, { action: 'secrets.read', description: 'Read secrets' }] }
			expect((await w.f.putSchema(withSecrets, CONSOLE)).status).toBe(200)
			const watch = { key: 'watch', name: 'Watch', permissions: ['deploy.read'] }
			expect((await w.asAda('policies.create', { app: CONSOLE, policy: watch })).status).toBe(200)
			const issued = w.keyOf(await w.asAda('apiKeys.provision', w.controlKey({ permissions: undefined, roleKey: 'watch' })))

			expect((await w.rpc(w.machine, 'policies.delete', { app: CONSOLE, key: 'watch' })).status).toBe(200)
			const wider = { ...watch, permissions: ['deploy.read', 'secrets.read'] }
			const refused = await w.rpc(w.machine, 'policies.create', { app: CONSOLE, policy: wider })
			expect([refused.status, refused.message.includes(APP)]).toEqual([403, true])
			expect(await actionsAt(w, issued.principalId, CONSOLE)).toEqual([])
		})

		test("the mirror is Control's alone, fenced by the protection revision, and answers what IAM holds", async () => {
			const w = await world()
			const set = (bearer: string, input: Record<string, unknown>) => w.rpc(bearer, 'grantApproval.set', { app: APP, required: false, ...input })
			expect((await set(w.machine, { revision: 1, credentials: 'off' })).status).toBe(403)
			expect((await set(PROVISIONING_KEY, { revision: 3, credentials: 'person' })).result).toEqual({
				app: APP,
				required: false,
				revision: 3,
				credentials: 'person',
			})
			// An older revision changes nothing.
			expect((await set(PROVISIONING_KEY, { revision: 2, credentials: 'off' })).result).toMatchObject({ revision: 3, credentials: 'person' })
			// One without a mode, an older Control's, clears it: IAM reads `person`, never a looser mode left behind.
			expect((await set(PROVISIONING_KEY, { revision: 4, credentials: 'off' })).result).toMatchObject({ revision: 4, credentials: 'off' })
			expect((await set(PROVISIONING_KEY, { revision: 5, required: true })).result).toEqual({ app: APP, required: true, revision: 5 })
			expect((await w.rpc(w.machine, 'apiKeys.provision', w.notesKey())).status).toBe(403)
			expect((await set(PROVISIONING_KEY, { revision: 6, credentials: 'sometimes' })).status).toBe(400)
			const records = (await w.repositories.audit.listAuditEvents({ limit: 50 })).filter((row) => row.action === 'iam.grant_approval.set')
			expect(records.map((row) => JSON.parse(row.metadata ?? 'null'))).toEqual([
				{ required: true, revision: 5 },
				{ required: false, revision: 4, credentials: 'off' },
				{ required: false, revision: 3, credentials: 'person' },
			])
		})
	})
}
