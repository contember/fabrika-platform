// Workload credentials (ADR-0022 "Principal kinds"), end to end through IAM's own routes with the provisioning key, the
// way Control reaches them: the schema reconcile declares a job's actions, `workloads.issueKey` issues its key, and the
// key mints a `job` token that carries exactly the declared actions and nothing a grant adds.

import { type AccessTokenClaims, type AppSchema, parseAccessClaims, WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, spyOn, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { resolveAdmin } from '../admin/router'
import { createIamApp } from '../app'
import { resolveCaller, resolveLinkCaller } from '../auth'
import type { Env } from '../env'
import { prop } from '../json'
import { WorkloadGrantError } from '../repositories/grants'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { CONSOLE_APP, createHarness, type Harness, seedGrant, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'
import { migrationFile, migrationsBefore } from './helpers/migrations'

const ISSUER = 'https://propustka.test'
const PROVISIONING_KEY = `px_${'p'.repeat(43)}`
const APP = 'notes@prod'
const DAY = 24 * 60 * 60
const exec = { waitUntil() {} }

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

const schema = (workloads: AppSchema['workloads']): AppSchema => ({
	scopes: [{ type: 'workspace' }],
	actions: [{ action: 'notes.read' }, { action: 'notes.purge' }, { action: 'notes.delete' }],
	roles: { editor: { name: 'Editor', permissions: ['notes.read', 'notes.delete'] } },
	contract: true,
	...(workloads === undefined ? {} : { workloads }),
})

function call(h: Harness, path: string, init: { method: string; bearer?: string; body?: unknown }): Promise<Response> {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`)
	return createIamApp().fetch(
		new Request(`${ISSUER}${path}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }),
		env(h),
		exec,
	)
}

async function reconcile(h: Harness, body: AppSchema): Promise<Response> {
	return call(h, `/admin/apps/${encodeURIComponent(APP)}/schema`, { method: 'PUT', bearer: PROVISIONING_KEY, body })
}

interface Issued {
	key: string
	credentialId: string
	principalId: string
}

interface IssueInput {
	kind: 'job' | 'webhook' | 'public' | 'app'
	name: string
	expiresAt?: number
	app?: string
	keep?: string | null
}

async function issueKey(h: Harness, input: IssueInput): Promise<Response> {
	const expiresAt = input.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * DAY
	return call(h, '/admin/rpc', {
		method: 'POST',
		bearer: PROVISIONING_KEY,
		body: { method: 'workloads.issueKey', input: { app: input.app ?? APP, kind: input.kind, name: input.name, expiresAt, keep: input.keep ?? null } },
	})
}

async function issued(h: Harness, input: IssueInput): Promise<Issued> {
	const response = await issueKey(h, input)
	expect(response.status).toBe(200)
	const result = prop(await response.json(), 'result')
	const key = prop(result, 'key')
	const credentialId = prop(result, 'credentialId')
	const principalId = prop(result, 'principalId')
	if (typeof key !== 'string' || typeof credentialId !== 'string' || typeof principalId !== 'string') throw new Error('expected an issued key')
	return { key, credentialId, principalId }
}

/** The verified claims `mintFromKey` signs for a key at `app`, or the refusal. */
async function minted(h: Harness, key: string, app = APP): Promise<AccessTokenClaims | string> {
	const { result } = await mintFromKey(h.makeServices({ environment: 'stage', issuer: ISSUER }), TEST_SIGNING_ENV, { app, key, requestId: 'r' })
	if (!result.ok) return result.reason
	const { payload } = await jwtVerify(result.token, createLocalJWKSet((await getSigner(TEST_SIGNING_ENV)).jwks()), { issuer: ISSUER, audience: app })
	const claims = parseAccessClaims(payload)
	if (claims === null) throw new Error('unparseable token')
	return claims
}

function actionsOf(claims: AccessTokenClaims | string): string[] | string {
	return typeof claims === 'string' ? claims : claims.perms.map((entry) => `${entry.action}@${entry.scope === null ? 'global' : entry.scope.value}`)
}

describe('a workload key', () => {
	test('mints a job token with exactly the actions the schema declares, app-wide', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const claims = await minted(h, job.key)
		if (typeof claims === 'string') throw new Error(claims)
		expect(claims.ptype).toBe('job')
		expect(claims.workload).toBe('nightly')
		expect(claims.sub).toBe(job.principalId)
		expect(actionsOf(claims)).toEqual(['notes.purge@global'])
	})

	test('carries nothing a grant adds, and nothing before the schema declares its workload', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema(undefined))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		seedGrant(h.sqlite, job.principalId, 'editor', null, APP)
		expect(actionsOf(await minted(h, job.key))).toEqual([])
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.read'] }]))).status).toBe(200)
		expect(actionsOf(await minted(h, job.key))).toEqual(['notes.read@global'])
	})

	test('is bound to its application environment', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'webhook', name: 'github', actions: ['notes.read'] }]))).status).toBe(200)
		const webhook = await issued(h, { kind: 'webhook', name: 'github' })
		expect(await minted(h, webhook.key, 'notes@stage')).toBe('invalid_key')
	})

	test('is revoked when the schema stops declaring its workload', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		expect((await reconcile(h, schema([]))).status).toBe(200)
		expect(await minted(h, job.key)).toBe('invalid_key')
	})

	test('calls no management operation', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const services = h.makeServices({ environment: 'stage', issuer: ISSUER })
		expect(await resolveCaller(services, { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }, { app: APP, credential: job.key, requestId: 'r' }))
			.toEqual({ ok: false, reason: 'invalid_token' })
		expect((await call(h, '/admin/rpc', { method: 'POST', bearer: job.key, body: { method: 'me', input: undefined } })).status).toBe(401)
	})
})

describe("a public procedure's key", () => {
	const publicSchema = (workloads: AppSchema['workloads'], roles: AppSchema['roles'] = {}): AppSchema => ({
		...schema(workloads),
		actions: [{ action: 'notes.read' }, { action: 'stats.click' }],
		roles: { editor: { name: 'Editor', permissions: ['notes.read'] }, ...roles },
	})

	test('mints a public token naming the full endpoint id, with exactly the actions the schema declares', async () => {
		const h = createHarness()
		expect((await reconcile(h, publicSchema([{ kind: 'public', name: 'api.stats.cta', actions: ['stats.click'] }]))).status).toBe(200)
		const cta = await issued(h, { kind: 'public', name: 'api.stats.cta' })
		const claims = await minted(h, cta.key)
		if (typeof claims === 'string') throw new Error(claims)
		expect(claims.ptype).toBe('public')
		expect(claims.workload).toBe('api.stats.cta')
		expect(actionsOf(claims)).toEqual(['stats.click@global'])
		const answer = await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', bearer: cta.key, body: { app: APP } })
		expect(prop(await answer.json(), 'ok')).toBe(true)
	})

	test('one group mounted twice is two workloads, each with its own key and its own actions', async () => {
		const h = createHarness()
		const workloads: AppSchema['workloads'] = [
			{ kind: 'public', name: 'api.stats.cta', actions: ['stats.click'] },
			{ kind: 'public', name: 'site.stats.cta', actions: ['notes.read', 'stats.click'] },
		]
		expect((await reconcile(h, publicSchema(workloads, { editor: { name: 'Editor', permissions: [] } }))).status).toBe(200)
		const api = await issued(h, { kind: 'public', name: 'api.stats.cta' })
		const site = await issued(h, { kind: 'public', name: 'site.stats.cta' })
		expect(api.principalId).not.toBe(site.principalId)
		expect(actionsOf(await minted(h, api.key))).toEqual(['stats.click@global'])
		expect(actionsOf(await minted(h, site.key))).toEqual(['notes.read@global', 'stats.click@global'])
	})

	test('is revoked when the schema stops declaring the procedure, and calls no management or link operation', async () => {
		const h = createHarness()
		expect((await reconcile(h, publicSchema([{ kind: 'public', name: 'api.stats.cta', actions: ['stats.click'] }]))).status).toBe(200)
		const cta = await issued(h, { kind: 'public', name: 'api.stats.cta' })
		const services = h.makeServices({ environment: 'stage', issuer: ISSUER })
		const signing = { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }
		expect(await resolveCaller(services, signing, { app: APP, credential: cta.key, requestId: 'r' })).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await resolveLinkCaller(services, signing, { app: APP, credential: cta.key, requestId: 'r' })).toEqual({
			ok: false,
			reason: 'invalid_token',
		})
		expect((await call(h, '/admin/rpc', { method: 'POST', bearer: cta.key, body: { method: 'me', input: undefined } })).status).toBe(401)
		expect((await reconcile(h, publicSchema([]))).status).toBe(200)
		expect(await minted(h, cta.key)).toBe('invalid_key')
	})

	test('is refused for an action a role grants, a name that is no endpoint id, or no action at all', async () => {
		const h = createHarness()
		expect((await reconcile(h, publicSchema([{ kind: 'public', name: 'api.stats.cta', actions: ['notes.read'] }]))).status).toBe(400)
		expect((await reconcile(h, publicSchema([{ kind: 'public', name: 'cta', actions: ['stats.click'] }]))).status).toBe(400)
		expect((await reconcile(h, publicSchema([{ kind: 'public', name: 'api.stats.cta', actions: [] }]))).status).toBe(400)
		expect((await issueKey(h, { kind: 'public', name: 'cta' })).status).toBe(400)
		expect((await issueKey(h, { kind: 'job', name: 'api.stats.cta' })).status).toBe(400)
	})
})

describe('an installation upgraded to the public workload kind', () => {
	test('keeps every job, webhook and connector workload, and each key still mints what it minted', async () => {
		const h = createHarness(migrationsBefore('0020_public_workloads.sql'))
		const workloads: AppSchema['workloads'] = [
			{ kind: 'job', name: 'nightly', actions: ['notes.purge'] },
			{ kind: 'webhook', name: 'github', actions: ['notes.read'] },
			{ kind: 'app', name: 'shop', actions: ['notes.read'] },
		]
		expect((await reconcile(h, schema(workloads))).status).toBe(200)
		const keys = await Promise.all(workloads.map((workload) => issued(h, { kind: workload.kind, name: workload.name })))
		const before = await Promise.all(keys.map(async (key) => actionsOf(await minted(h, key.key))))
		h.sqlite.exec(migrationFile('0020_public_workloads.sql'))
		expect(await Promise.all(keys.map(async (key) => actionsOf(await minted(h, key.key))))).toEqual(before)
		expect(before).toEqual([['notes.purge@global'], ['notes.read@global'], ['notes.read@global']])
		const job = await minted(h, keys[0]?.key ?? '')
		expect(typeof job === 'string' ? job : [job.ptype, job.workload]).toEqual(['job', 'nightly'])
		expect((await reconcile(h, schema([...workloads, { kind: 'public', name: 'api.notes.submit', actions: ['notes.purge'] }]))).status).toBe(200)
		expect(actionsOf(await minted(h, (await issued(h, { kind: 'public', name: 'api.notes.submit' })).key))).toEqual(['notes.purge@global'])
	})
})

describe("a consuming application's connector key", () => {
	test('mints an app token at the owner naming the consumer, with the actions of the exports it consumes', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'app', name: 'shop-front', actions: ['notes.read'] }]))).status).toBe(200)
		const connector = await issued(h, { kind: 'app', name: 'shop-front' })
		const claims = await minted(h, connector.key)
		if (typeof claims === 'string') throw new Error(claims)
		expect(claims.ptype).toBe('app')
		expect(claims.workload).toBe('shop-front')
		expect(actionsOf(claims)).toEqual(['notes.read@global'])
		expect(await minted(h, connector.key, 'notes@stage')).toBe('invalid_key')
	})

	test('is not a job key: the workload token route refuses it', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'app', name: 'shop', actions: ['notes.read'] }]))).status).toBe(200)
		const connector = await issued(h, { kind: 'app', name: 'shop' })
		const response = await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', bearer: connector.key, body: { app: APP } })
		const body: unknown = await response.json()
		expect(body).toEqual({ ok: false, reason: 'invalid_key' })
	})

	test('workloads.revokeKeys revokes every key of the pair, the one a rotation kept included', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'app', name: 'shop', actions: ['notes.read'] }]))).status).toBe(200)
		const kept = await issued(h, { kind: 'app', name: 'shop' })
		const rotated = await issued(h, { kind: 'app', name: 'shop', keep: kept.credentialId })
		const revoke = (name: string) =>
			call(h, '/admin/rpc', {
				method: 'POST',
				bearer: PROVISIONING_KEY,
				body: { method: 'workloads.revokeKeys', input: { app: APP, kind: 'app', name } },
			})
		const response = await revoke('shop')
		expect(response.status).toBe(200)
		expect(prop(await response.json(), 'result')).toEqual({ revoked: 2 })
		expect(await minted(h, kept.key)).toBe('invalid_key')
		expect(await minted(h, rotated.key)).toBe('invalid_key')
		expect(prop(await (await revoke('crm')).json(), 'result')).toEqual({ revoked: 0 })
	})

	test('is named by an application id, and loses its actions once no export names the consumer', async () => {
		const h = createHarness()
		expect((await issueKey(h, { kind: 'app', name: 'Shop_Front' })).status).toBe(400)
		expect((await reconcile(h, schema([{ kind: 'app', name: 'shop', actions: ['notes.read'] }]))).status).toBe(200)
		const connector = await issued(h, { kind: 'app', name: 'shop' })
		expect((await reconcile(h, schema([]))).status).toBe(200)
		expect(await minted(h, connector.key)).toBe('invalid_key')
	})
})

describe('workloads.issueKey', () => {
	test('keeps the active key a failed record left in place, and revokes the orphan the failed attempt issued', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const active = await issued(h, { kind: 'job', name: 'nightly' })
		// Control asks for B and fails to record it: A stays its active key.
		const orphan = await issued(h, { kind: 'job', name: 'nightly', keep: active.credentialId })
		expect(orphan.principalId).toBe(active.principalId)
		const retried = await issued(h, { kind: 'job', name: 'nightly', keep: active.credentialId })
		expect(actionsOf(await minted(h, active.key))).toEqual(['notes.purge@global'])
		expect(await minted(h, orphan.key)).toBe('invalid_key')
		expect(actionsOf(await minted(h, retried.key))).toEqual(['notes.purge@global'])
		// Once the retried key is recorded, the next rotation keeps it and revokes the key it replaced.
		const next = await issued(h, { kind: 'job', name: 'nightly', keep: retried.credentialId })
		expect(await minted(h, active.key)).toBe('invalid_key')
		expect(actionsOf(await minted(h, retried.key))).toEqual(['notes.purge@global'])
		expect(actionsOf(await minted(h, next.key))).toEqual(['notes.purge@global'])
	})

	test('refuses an expiry beyond 30 days, a name that is not a contract name, and a caller that is not an administrator', async () => {
		const h = createHarness()
		expect((await issueKey(h, { kind: 'job', name: 'nightly', expiresAt: Math.floor(Date.now() / 1000) + 31 * DAY })).status).toBe(400)
		expect((await issueKey(h, { kind: 'job', name: 'night ly' })).status).toBe(400)
		const response = await call(h, '/admin/rpc', {
			method: 'POST',
			body: { method: 'workloads.issueKey', input: { app: APP, kind: 'job', name: 'nightly', expiresAt: Math.floor(Date.now() / 1000) + DAY } },
		})
		expect(response.status).toBe(401)
	})

	test('is not listed as an API key', async () => {
		const h = createHarness()
		await issued(h, { kind: 'job', name: 'nightly' })
		const response = await call(h, '/admin/rpc', { method: 'POST', bearer: PROVISIONING_KEY, body: { method: 'apiKeys.list', input: {} } })
		const items = prop(prop(await response.json(), 'result'), 'items')
		expect(Array.isArray(items) ? items.map((item: unknown) => prop(item, 'label')) : items).toEqual(['provisioning'])
	})
})

describe('a workload principal holds no grant', () => {
	test('a workload token of an admin audience with a global admin grant does not administer IAM', async () => {
		const h = createHarness()
		const job = await issued(h, { kind: 'job', name: 'nightly', app: CONSOLE_APP })
		// Written past every guard, as a hand-edited database would hold it.
		h.sqlite.run('INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, app, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?)', [
			'grant-on-a-job',
			job.principalId,
			'admin',
			Math.floor(Date.now() / 1000),
		])
		const services = h.makeServices({ environment: 'stage', issuer: ISSUER })
		const { result } = await mintFromKey(services, TEST_SIGNING_ENV, { app: CONSOLE_APP, key: job.key, requestId: 'r' })
		if (!result.ok) throw new Error(result.reason)
		const { payload } = await jwtVerify(result.token, createLocalJWKSet((await getSigner(TEST_SIGNING_ENV)).jwks()), { issuer: ISSUER })
		expect(parseAccessClaims(payload)?.perms).toEqual([])
		expect((await call(h, '/admin/rpc', { method: 'POST', bearer: result.token, body: { method: 'me', input: undefined } })).status).toBe(403)
		const admin = await resolveAdmin(services, { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }, { bearer: result.token, requestId: 'r' })
		expect(admin).toEqual({ ok: false, status: 403, reason: 'not_allowed' })
	})

	test('no grant can be written for a workload principal', async () => {
		const h = createHarness()
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const response = await call(h, '/admin/rpc', {
			method: 'POST',
			bearer: PROVISIONING_KEY,
			body: { method: 'grants.create', input: { principalId: job.principalId, permissions: ['notes.read'], app: APP } },
		})
		expect(response.status).toBe(409)
		await expect(h.repositories.grants.createGrant({ principalId: job.principalId, app: APP, roleKey: 'admin' })).rejects.toBeInstanceOf(
			WorkloadGrantError,
		)
		expect(h.sqlite.query('SELECT id FROM grants WHERE principal_id = ?').all(job.principalId)).toEqual([])
		const rotate = await call(h, '/admin/rpc', {
			method: 'POST',
			bearer: PROVISIONING_KEY,
			body: { method: 'apiKeys.rotate', input: { principalId: job.principalId } },
		})
		expect(rotate.status).toBe(404)
	})
})

describe('the schema declares workloads', () => {
	test('only for a contract application, with exact actions of its own catalog, each once', async () => {
		const h = createHarness()
		expect((await reconcile(h, { ...schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]), contract: false })).status).toBe(400)
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.*'] }]))).status).toBe(400)
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.archive'] }]))).status).toBe(400)
		expect(
			(await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: [] }, { kind: 'job', name: 'nightly', actions: [] }]))).status,
		).toBe(400)
	})
})

describe(`POST ${WORKLOAD_TOKEN_PATH}`, () => {
	async function exchange(h: Harness, bearer: string | undefined, body: unknown): Promise<unknown> {
		const response = await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', ...(bearer === undefined ? {} : { bearer }), body })
		expect(response.status).toBe(200)
		return response.json()
	}

	test('answers a workload key of the named application with its token', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const answer = await exchange(h, job.key, { app: APP })
		expect(prop(answer, 'ok')).toBe(true)
		expect(typeof prop(answer, 'token')).toBe('string')
	})

	test('answers every key that is not a live workload key of the application with the same invalid_key', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const disabledJob = await issued(h, { kind: 'job', name: 'weekly' })
		h.sqlite.run('UPDATE principals SET disabled_at = 1 WHERE id = ?', [disabledJob.principalId])
		const revokedJob = await issued(h, { kind: 'webhook', name: 'github' })
		h.sqlite.run('UPDATE credentials SET revoked_at = 1 WHERE id = ?', [revokedJob.credentialId])
		// An ordinary service key, live and disabled: its principal status is never read here.
		const service = await call(h, '/admin/api-keys', {
			method: 'POST',
			bearer: PROVISIONING_KEY,
			body: { label: 'ci', type: 'service', permissions: ['notes.read'], app: APP },
		})
		const serviceKey = prop(await service.json(), 'apiKey')
		if (typeof serviceKey !== 'string') throw new Error('no service key')
		const disabledService = await call(h, '/admin/api-keys', {
			method: 'POST',
			bearer: PROVISIONING_KEY,
			body: { label: 'old', type: 'service', permissions: ['notes.read'], app: APP },
		})
		const disabled = await disabledService.json()
		const disabledKey = prop(disabled, 'apiKey')
		const disabledId = prop(disabled, 'principalId')
		if (typeof disabledKey !== 'string' || typeof disabledId !== 'string') throw new Error('no service key')
		h.sqlite.run('UPDATE principals SET disabled_at = 1 WHERE id = ?', [disabledId])
		const refused = { ok: false, reason: 'invalid_key' }
		const absent = `px_${'A'.repeat(27)}`
		for (const key of [absent, serviceKey, disabledKey, disabledJob.key, revokedJob.key, PROVISIONING_KEY, 'px_short']) {
			expect(await exchange(h, key, { app: APP })).toEqual(refused)
		}
		expect(await exchange(h, job.key, { app: 'notes@stage' })).toEqual(refused)
		expect(await exchange(h, undefined, { app: APP })).toEqual(refused)
		// A refusal writes no auth-log row; only the exchange that succeeds is recorded.
		expect(await exchange(h, job.key, { app: APP })).toMatchObject({ ok: true })
		expect(h.sqlite.query("SELECT reason FROM auth_log WHERE reason LIKE '%workload%' OR decision = 'deny'").all()).toEqual([
			{ reason: 'mint_workload_key' },
		])
	})

	test('a storage failure is a 503, never a refused key', async () => {
		const h = createHarness()
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		h.sqlite.run('DROP TABLE workload_principals')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', bearer: job.key, body: { app: APP } })
			expect(response.status).toBe(503)
			const body: unknown = await response.json()
			expect(body).toEqual({ error: 'unavailable' })
		} finally {
			log.mockRestore()
		}
	})

	test('a client over the bucket the password and device routes share is refused before the key is looked up', async () => {
		const h = createHarness()
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const app = createIamApp({ clientAddressHeader: 'X-Fabrika-Client-Ip' })
		const send = () =>
			app.fetch(
				new Request(`${ISSUER}${WORKLOAD_TOKEN_PATH}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${job.key}`, 'content-type': 'application/json', 'X-Fabrika-Client-Ip': '203.0.113.9' },
					body: JSON.stringify({ app: APP }),
				}),
				env(h),
				exec,
			)
		expect((await send()).status).toBe(200)
		h.sqlite.run('UPDATE password_login_throttles SET blocked_until = ?', [Math.floor(Date.now() / 1000) + 600])
		expect((await send()).status).toBe(429)
	})

	test('refuses a body that names no application, and every method but POST', async () => {
		const h = createHarness()
		expect((await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', bearer: PROVISIONING_KEY, body: { app: APP, extra: 1 } })).status).toBe(400)
		expect((await call(h, WORKLOAD_TOKEN_PATH, { method: 'GET' })).status).toBe(405)
	})
})
