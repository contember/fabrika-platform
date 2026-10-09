// Workload credentials (ADR-0022 "Principal kinds"), end to end through IAM's own routes with the provisioning key, the
// way Control reaches them: the schema reconcile declares a job's actions, `workloads.issueKey` issues its key, and the
// key mints a `job` token that carries exactly the declared actions and nothing a grant adds.

import { type AccessTokenClaims, type AppSchema, parseAccessClaims, WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { createIamApp } from '../app'
import { resolveCaller } from '../auth'
import type { Env } from '../env'
import { prop } from '../json'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, type Harness, seedGrant, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

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

async function issueKey(h: Harness, input: { kind: 'job' | 'webhook'; name: string; expiresAt?: number; app?: string }): Promise<Response> {
	const expiresAt = input.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * DAY
	return call(h, '/admin/rpc', {
		method: 'POST',
		bearer: PROVISIONING_KEY,
		body: { method: 'workloads.issueKey', input: { app: input.app ?? APP, kind: input.kind, name: input.name, expiresAt } },
	})
}

async function issued(h: Harness, input: { kind: 'job' | 'webhook'; name: string; app?: string }): Promise<Issued> {
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

describe('workloads.issueKey', () => {
	test('keeps the newest older key for the rollout and revokes every older one', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const first = await issued(h, { kind: 'job', name: 'nightly' })
		const second = await issued(h, { kind: 'job', name: 'nightly' })
		expect(second.principalId).toBe(first.principalId)
		expect(actionsOf(await minted(h, first.key))).toEqual(['notes.purge@global'])
		const third = await issued(h, { kind: 'job', name: 'nightly' })
		expect(await minted(h, first.key)).toBe('invalid_key')
		expect(actionsOf(await minted(h, second.key))).toEqual(['notes.purge@global'])
		expect(actionsOf(await minted(h, third.key))).toEqual(['notes.purge@global'])
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

	test('refuses another application, any key that is not a workload key, and no key at all', async () => {
		const h = createHarness()
		expect((await reconcile(h, schema([{ kind: 'job', name: 'nightly', actions: ['notes.purge'] }]))).status).toBe(200)
		const job = await issued(h, { kind: 'job', name: 'nightly' })
		const refused = { ok: false, reason: 'invalid_key' }
		expect(await exchange(h, job.key, { app: 'notes@stage' })).toEqual(refused)
		expect(await exchange(h, PROVISIONING_KEY, { app: APP })).toEqual(refused)
		expect(await exchange(h, undefined, { app: APP })).toEqual(refused)
	})

	test('refuses a body that names no application, and every method but POST', async () => {
		const h = createHarness()
		expect((await call(h, WORKLOAD_TOKEN_PATH, { method: 'POST', bearer: PROVISIONING_KEY, body: { app: APP, extra: 1 } })).status).toBe(400)
		expect((await call(h, WORKLOAD_TOKEN_PATH, { method: 'GET' })).status).toBe(405)
	})
})
