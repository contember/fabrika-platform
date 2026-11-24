import { type AppSchema, type DimensionValueSource, MAX_SCOPE_VALUE_SOURCE_BYTES } from '@fabrika/auth-core'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AdminContext } from '../admin/context'
import { adminUseCases } from '../admin/handlers'
import { listScopeValuesUseCase, SCOPE_VALUE_KEY_TTL_SECONDS, type SourceFetch } from '../admin/scope-values'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { hashToken } from '../secret'
import { getSigner, verifyAccessToken } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, TEST_SIGNING_ENV } from './helpers/harness'
import { APP, membershipFixture, NOTES_SCHEMA, ORIGIN } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const APP_ORIGIN = 'https://notes.example.test'
const SOURCE: DimensionValueSource = { endpoint: 'api.workspaceValues', path: '/api/workspaceValues', action: 'notes.read' }

/** `NOTES_SCHEMA` whose `workspace` dimension lists its values from the application (ADR-0085 §4). */
const SOURCED_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	scopes: NOTES_SCHEMA.scopes.map((scope) => scope.type === 'workspace' ? { ...scope, valueSource: SOURCE } : scope),
}

/** A fetch standing in for the application's proxy: it records each request and answers `answer`. */
function proxy(
	answer: (request: Request) => Promise<Response> | Response = () => Response.json({ result: { values: [{ value: 'w1', label: 'One' }] } }),
) {
	const requests: Request[] = []
	const fetch: SourceFetch = async (request) => {
		requests.push(request)
		return await answer(request)
	}
	return { requests, fetch }
}

function bearerOf(request: Request | undefined): string {
	const header = request?.headers.get('authorization') ?? ''
	if (!header.startsWith('Bearer ')) throw new Error('no bearer')
	return header.slice('Bearer '.length)
}

async function fixture(repositories: IamRepositories) {
	const f = await membershipFixture(repositories)
	const put = await f.putSchema(SOURCED_SCHEMA)
	if (put.status !== 200) throw new Error(`schema refused: ${await put.text()}`)
	await repositories.handoff.setReturnOrigins(APP, [APP_ORIGIN])
	const person = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const url = new URL(`${ORIGIN}/admin/rpc`)
	const context: AdminContext = {
		services: f.services,
		admin: { id: person.id, label: person.label, type: 'user', permissions: [], session: true },
		administration: { kind: 'users', apps: [APP] },
		app: 'vozka',
		requestId: crypto.randomUUID(),
		url,
		request: new Request(url),
		ctx: f.ctx,
	}
	/** The person's editor grant in `value`, which carries `notes.read`, `notes.write` and `notes.share` there. */
	const edit = (value: string) =>
		repositories.grants.createGrant({ principalId: person.id, app: APP, roleKey: 'editor', scopeType: 'workspace', scopeValue: value })
	const records = async () => (await adminUseCases.listAudit(context, { action: 'iam.scope_values.read', principalId: person.id })).items
	return { ...f, person, context, edit, records }
}

function suite(label: string, backend: () => IamRepositories) {
	describe(`scope values from the application (${label})`, () => {
		test('a key of the administrator, bound to the app, for one minute, carrying only the source action where it is held', async () => {
			const f = await fixture(backend())
			await f.edit('w1')
			await f.edit('w2')
			const app = proxy()
			const before = Math.floor(Date.now() / 1000)

			const result = await listScopeValuesUseCase(f.context, { app: APP, scopeType: 'workspace' }, app.fetch)
			expect(result).toEqual({ source: 'application', values: [{ value: 'w1', label: 'One' }] })

			// One call, through the application's own registered origin, as a bearer that follows no redirect.
			expect(app.requests.length).toBe(1)
			const [request] = app.requests
			expect(request?.url).toBe(`${APP_ORIGIN}/api/workspaceValues`)
			expect(request?.method).toBe('POST')
			expect(request?.redirect).toBe('manual')
			expect(await request?.text()).toBe('{}')
			const key = bearerOf(request)
			expect(key.startsWith('px_')).toBe(true)

			const credential = await f.repositories.credentials.getActiveCredentialByHash(await hashToken(key))
			expect(credential?.principal_id).toBe(f.person.id)
			expect(credential?.issued_by).toBe(f.person.id)
			expect(credential?.app).toBe(APP)
			const expiresAt = credential?.expires_at ?? 0
			expect(expiresAt).toBeGreaterThanOrEqual(before + SCOPE_VALUE_KEY_TTL_SECONDS)
			expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + SCOPE_VALUE_KEY_TTL_SECONDS)

			// The proxy's exchange of that key: a token for the app alone, with `notes.read` in the person's workspaces only.
			const minted = (await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key, requestId: 'req-proxy' })).result
			if (!minted.ok) throw new Error(`no token: ${minted.reason}`)
			expect(minted.expiresAt).toBeLessThanOrEqual(expiresAt)
			const claims = await verifyAccessToken(await getSigner(TEST_SIGNING_ENV), minted.token, { issuer: ORIGIN, audience: APP })
			expect(claims?.aud).toBe(APP)
			expect(claims?.sub).toBe(f.person.id)
			expect(claims?.session).toBeUndefined()
			expect(claims?.perms.map((entry) => [entry.action, entry.scope?.type, entry.scope?.value]).sort()).toEqual([
				['notes.read', 'workspace', 'w1'],
				['notes.read', 'workspace', 'w2'],
			])
			// Another application, the console included, gets nothing from it.
			for (const other of ['other@prod', 'vozka']) {
				const refused = (await mintFromKey(f.services, TEST_SIGNING_ENV, { app: other, key, requestId: 'req-other' })).result
				expect(refused).toEqual({ ok: false, reason: 'invalid_key' })
			}

			// The issue is recorded, naming the key, never its secret.
			const records = await f.records()
			expect(records.length).toBe(1)
			expect(records[0]?.resourceId).toBe(credential?.id ?? '')
			expect(records[0]?.principalId).toBe(f.person.id)
			expect(JSON.stringify(records[0])).not.toContain(key)
		})

		test('a global holder gets one global entry; a key never outlives the person losing the action', async () => {
			const f = await fixture(backend())
			await f.repositories.grants.createGrant({ principalId: f.person.id, app: APP, roleKey: 'staff' })
			const app = proxy()
			await listScopeValuesUseCase(f.context, { app: APP, scopeType: 'workspace' }, app.fetch)
			const key = bearerOf(app.requests[0])
			const minted = (await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key, requestId: 'req-proxy' })).result
			if (!minted.ok) throw new Error(`no token: ${minted.reason}`)
			const claims = await verifyAccessToken(await getSigner(TEST_SIGNING_ENV), minted.token, { issuer: ORIGIN, audience: APP })
			expect(claims?.perms.map((entry) => [entry.action, entry.scope])).toEqual([['notes.read', null]])

			// The key narrows the person's live permissions: once the grant is gone, the key carries nothing.
			for (const grant of await f.repositories.grants.listGrants(f.person.id)) await f.repositories.grants.deleteGrant(grant.id)
			const after = (await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key, requestId: 'req-later' })).result
			if (after.ok) {
				const later = await verifyAccessToken(await getSigner(TEST_SIGNING_ENV), after.token, { issuer: ORIGIN, audience: APP })
				expect(later?.perms).toEqual([])
			}
		})

		test('who may ask: a session user administering the app; never a key, never another app, never a stranger', async () => {
			const f = await fixture(backend())
			await f.edit('w1')
			const app = proxy()
			const ask = (context: AdminContext) => listScopeValuesUseCase(context, { app: APP, scopeType: 'workspace' }, app.fetch)
			const refusal = async (context: AdminContext) => {
				try {
					await ask(context)
					return 'answered'
				} catch (error) {
					return error instanceof Error && 'httpStatus' in error ? error.httpStatus : 'thrown'
				}
			}
			expect(await refusal({ ...f.context, administration: { kind: 'users', apps: ['other@prod'] } })).toBe(403)
			expect(await refusal({ ...f.context, administration: { kind: 'users', apps: [] } })).toBe(403)
			expect(await refusal({ ...f.context, admin: { ...f.context.admin, session: false } })).toBe(403)
			expect(await refusal({ ...f.context, admin: { ...f.context.admin, type: 'service' } })).toBe(403)
			// The installation's own applications are not asked, even by an installation administrator.
			expect(await refusal({ ...f.context, administration: { kind: 'users', apps: null } })).toBe('answered')
			expect(app.requests.length).toBe(1)
			await expect(
				listScopeValuesUseCase({ ...f.context, administration: { kind: 'users', apps: null } }, { app: 'vozka', scopeType: 'app' }, app.fetch),
			)
				.rejects.toMatchObject({ httpStatus: 403 })
			expect(app.requests.length).toBe(1)
			expect((await f.records()).length).toBe(1)
		})

		test('nothing to ask: no source, no registered origin, the action held nowhere — no key is issued', async () => {
			const f = await fixture(backend())
			const app = proxy()
			const ask = (scopeType: string) => listScopeValuesUseCase(f.context, { app: APP, scopeType }, app.fetch)

			expect(await ask('note')).toEqual({ source: 'unavailable', reason: 'no_source' })
			expect(await ask('workspace')).toEqual({ source: 'unavailable', reason: 'not_held' })
			// `notes.write` alone is not the source's action.
			await f.repositories.grants.createGrant({
				principalId: f.person.id,
				app: APP,
				permissions: ['notes.write'],
				scopeType: 'workspace',
				scopeValue: 'w1',
			})
			expect(await ask('workspace')).toEqual({ source: 'unavailable', reason: 'not_held' })
			await f.edit('w1')
			await f.repositories.handoff.setReturnOrigins(APP, [])
			expect(await ask('workspace')).toEqual({ source: 'unavailable', reason: 'no_origin' })
			// Several origins (a dev environment's workspace sandboxes) name no one application to ask.
			await f.repositories.handoff.setReturnOrigins(APP, [APP_ORIGIN, 'https://ws-1.notes.example.test'])
			expect(await ask('workspace')).toEqual({ source: 'unavailable', reason: 'no_origin' })
			// A plain-http origin gets no key outside a local IAM.
			await f.repositories.handoff.setReturnOrigins(APP, ['http://notes.example.test'])
			expect(await ask('workspace')).toEqual({ source: 'unavailable', reason: 'no_origin' })
			await expect(ask('nowhere')).rejects.toMatchObject({ httpStatus: 404 })

			expect(app.requests.length).toBe(0)
			expect(await f.records()).toEqual([])
		})

		test("the application's answer: a refusal, a failure, a wrong or oversized body and a timeout are each unavailable", async () => {
			const f = await fixture(backend())
			await f.edit('w1')
			const ask = (answer: (request: Request) => Promise<Response> | Response) =>
				listScopeValuesUseCase(f.context, { app: APP, scopeType: 'workspace' }, proxy(answer).fetch)

			expect(await ask(() => new Response('no', { status: 403 }))).toEqual({ source: 'unavailable', reason: 'refused' })
			expect(await ask(() => new Response('no', { status: 401 }))).toEqual({ source: 'unavailable', reason: 'refused' })
			expect(await ask(() => new Response('down', { status: 502 }))).toEqual({ source: 'unavailable', reason: 'unreachable' })
			// A redirect is not followed and not an answer.
			expect(await ask(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }))).toEqual({
				source: 'unavailable',
				reason: 'unreachable',
			})
			expect(await ask(() => Promise.reject(new TypeError('connection refused')))).toEqual({ source: 'unavailable', reason: 'unreachable' })
			expect(await ask(() => new Response('not json'))).toEqual({ source: 'unavailable', reason: 'malformed' })
			expect(await ask(() => Response.json({ result: { values: [{ value: '' }] } }))).toEqual({ source: 'unavailable', reason: 'malformed' })
			expect(await ask(() => Response.json({ values: [{ value: 'w1' }] }))).toEqual({ source: 'unavailable', reason: 'malformed' })
			expect(await ask(() => new Response(JSON.stringify({ result: { values: [{ value: 'x'.repeat(MAX_SCOPE_VALUE_SOURCE_BYTES) }] } }))))
				.toEqual({ source: 'unavailable', reason: 'malformed' })
			expect(await ask(() => Response.json({ result: { values: [] } }))).toEqual({ source: 'application', values: [] })

			// An application that never answers is cut at the deadline.
			const hanging = (request: Request) =>
				new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
			expect(await ask(hanging)).toEqual({ source: 'unavailable', reason: 'timeout' })
		}, 10_000)
	})
}

suite('SQLite', () => createHarness().repositories)

describe.skipIf(!hasPostgres)('Postgres', () => {
	let pg: PostgresFixture | null = null
	beforeAll(async () => {
		pg = await createPostgres('iam_scope_values')
	})
	afterAll(async () => {
		await pg?.close()
	})
	suite('Postgres', () => {
		if (pg === null) throw new Error('postgres fixture missing')
		return createPostgresIamRepositories(pg.db)
	})
})

if (!hasPostgres) console.warn(`scope-values.test.ts ${skipReason}`)
