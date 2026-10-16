import { parseAccessClaims, permits } from '@fabrika/auth-core'
import type { ProvisionApiKeyResponse, RotateApiKeyResponse } from '@fabrika/iam-contract'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { handleAdmin } from '../admin/router'
import { createIamApp } from '../app'
import type { Env, RequestContext } from '../env'
import { prop } from '../json'
import type { Services } from '../services'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedGrant, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

// End-to-end tests for the admin api-keys flow minting a propustka-NATIVE key: provision creates a
// native service principal + grant and returns a `px_` key that `mintFromKey` resolves to the service
// principal's permissions; rotate invalidates the old one; revoke kills it. No Cloudflare Access.
//
// PROVISION and REVOKE run over REST, which is where they live: the first machine caller is
// bootstrapped before a console exists. ROTATE is `/admin/rpc` — a console operation with no
// bootstrap role, so it has no REST mirror to keep in step.

const ISSUER = 'https://propustka.test'
const ORIGIN = ISSUER
const SIGN_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', FABRIKA_IAM_PROVISIONING_KEY: '', ENVIRONMENT: 'local' }
// env slice handleAdmin needs: a `stage` signer that verifies the console bearer `asAdmin` signs.
const ADMIN_ENV = { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }

class FakeRequestContext implements RequestContext {
	waitUntil(_promise: Promise<unknown>): void {}
}

function services(h: Harness): Services {
	return h.makeServices({ environment: 'stage', issuer: ISSUER })
}

async function asAdmin(h: Harness): Promise<string> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	return h.adminToken(id, { issuer: ISSUER })
}

function req(path: string, method: string, bearer: string, body?: unknown): Request {
	const headers = new Headers({ Authorization: `Bearer ${bearer}` })
	if (method !== 'GET') {
		headers.set('Content-Type', 'application/json')
	}
	return new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

function run(h: Harness, request: Request): Promise<Response> {
	return handleAdmin(request, services(h), ADMIN_ENV, new FakeRequestContext())
}

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
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

/** `apiKeys.rotate` over `/admin/rpc`, the only transport that serves it. */
function rotate(h: Harness, bearer: string, principalId: string, expiresAt?: number): Promise<Response> {
	return createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ method: 'apiKeys.rotate', input: { principalId, ...(expiresAt !== undefined ? { expiresAt } : {}) } }),
		}),
		env(h),
		exec,
	)
}

/** The rotation result of a call expected to succeed. */
async function rotated(h: Harness, bearer: string, principalId: string, expiresAt?: number): Promise<RotateApiKeyResponse> {
	const response = await rotate(h, bearer, principalId, expiresAt)
	expect(response.status).toBe(200)
	const result = prop(await response.json(), 'result')
	const apiKey = prop(result, 'apiKey')
	if (typeof apiKey !== 'string') throw new Error('expected a rotated apiKey')
	return { principalId, apiKey }
}

/** Resolve a `px_` key into an access token via mintFromKey, returning the verified claims (or null). */
async function resolveKey(h: Harness, key: string) {
	const { result } = await mintFromKey(services(h), SIGN_ENV, { app: 'opice', key, requestId: 'r' })
	if (!result.ok) {
		return { failed: result.reason }
	}
	const { payload } = await jwtVerify(result.token, createLocalJWKSet((await getSigner(SIGN_ENV)).jwks()), { issuer: ISSUER, audience: 'opice' })
	return { claims: parseAccessClaims(payload) }
}

async function provision(h: Harness, token: string): Promise<ProvisionApiKeyResponse> {
	seedAppAction(h.sqlite, 'opice', 'report.write') // registers 'opice' + the inline grants validate against its catalog
	const res = await run(
		h,
		req('/admin/api-keys', 'POST', token, { label: 'opice CI', type: 'service', permissions: ['report.write'], app: 'opice' }),
	)
	expect(res.status).toBe(201)
	return res.json()
}

describe('POST /admin/api-keys — native key', () => {
	test('returns a px_ key that resolves to the service principal permissions', async () => {
		const h = createHarness()
		const token = await asAdmin(h)

		const body = await provision(h, token)
		expect(body.apiKey.startsWith('px_')).toBe(true)

		const resolved = await resolveKey(h, body.apiKey)
		expect(resolved.claims?.ptype).toBe('service')
		expect(resolved.claims?.sub).toBe(body.principalId)
		expect(permits(resolved.claims?.perms ?? [], 'report.write')).toBe(true)
		expect(permits(resolved.claims?.perms ?? [], 'report.delete')).toBe(false)
	})
})

describe('rotate / revoke invalidate the native key', () => {
	test('rotate issues a new key and kills the old', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const first = await provision(h, token)

		const next = await rotated(h, token, first.principalId)
		expect(next.apiKey.startsWith('px_')).toBe(true)
		expect(next.apiKey).not.toBe(first.apiKey)

		// Old key is dead; new key works.
		expect((await resolveKey(h, first.apiKey)).failed).toBe('invalid_key')
		expect((await resolveKey(h, next.apiKey)).claims?.ptype).toBe('service')
	})

	test('rotate CARRIES THE EXPIRY forward, and takes a new one when asked', async () => {
		// Rotation replaces a secret; it does not extend a lifetime. Dropping the expiry silently turned a
		// key that was meant to die in 30 days into a permanent one (CORR-5).
		const h = createHarness()
		const token = await asAdmin(h)
		seedAppAction(h.sqlite, 'opice', 'report.write')
		const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
		const provisioned: ProvisionApiKeyResponse = await (await run(
			h,
			req('/admin/api-keys', 'POST', token, { label: 'expiring', type: 'service', permissions: ['report.write'], app: 'opice', expiresAt }),
		)).json()

		await rotated(h, token, provisioned.principalId)
		const carried = (await h.repositories.credentials.listCredentialsForPrincipal(provisioned.principalId)).find((row) => row.revoked_at === null)
		expect(carried?.expires_at).toBe(expiresAt)
		// The app binding rides along too — a rotated key is the same credential with a new secret.
		expect(carried?.app).toBe('opice')

		const later = expiresAt + 3600
		await rotated(h, token, provisioned.principalId, later)
		const restated = (await h.repositories.credentials.listCredentialsForPrincipal(provisioned.principalId)).find((row) => row.revoked_at === null)
		expect(restated?.expires_at).toBe(later)

		// A past expiry is refused exactly as provisioning refuses one.
		expect((await rotate(h, token, provisioned.principalId, 1)).status).toBe(400)
	})

	test('rotate refuses a DISABLED principal', async () => {
		// Handing out a working secret for an account somebody just revoked. The same guard
		// `passwordUser` already applies to the password paths.
		const h = createHarness()
		const token = await asAdmin(h)
		const provisioned = await provision(h, token)
		await h.repositories.principals.disablePrincipal(provisioned.principalId)

		expect((await rotate(h, token, provisioned.principalId)).status).toBe(409)
	})

	test('revoke kills the native key', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const body = await provision(h, token)

		const del = await run(h, req(`/admin/api-keys/${body.principalId}`, 'DELETE', token))
		expect(del.status).toBe(200)
		expect((await resolveKey(h, body.apiKey)).failed).toBe('invalid_key')
	})
})

/** One `/admin/rpc` call: its status and its `result`, or its `error` when it failed. */
async function adminRpc(h: Harness, bearer: string, method: string, input: unknown): Promise<{ status: number; result: unknown }> {
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ method, input }),
		}),
		env(h),
		exec,
	)
	const body: unknown = await response.json()
	return { status: response.status, result: prop(body, 'result') ?? prop(body, 'error') }
}

describe("an issued key's grants are edited in place", () => {
	test('a grant added or removed changes what the SAME key resolves to at its next exchange, and each change is recorded', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const key = await provision(h, token)
		seedAppAction(h.sqlite, 'opice', 'secret.manage')
		const [original] = await h.repositories.grants.listGrants(key.principalId)
		if (original === undefined) throw new Error('provisioning wrote no grant')

		const added = await adminRpc(h, token, 'grants.create', { principalId: key.principalId, app: 'opice', permissions: ['secret.manage'] })
		expect(added.status).toBe(200)
		const addedId = prop(added.result, 'id')
		const widened = (await resolveKey(h, key.apiKey)).claims?.perms ?? []
		expect(permits(widened, 'secret.manage')).toBe(true)
		expect(permits(widened, 'report.write')).toBe(true)

		const detail = await adminRpc(h, token, 'apiKeys.get', { principalId: key.principalId })
		expect(detail.status).toBe(200)
		expect(prop(detail.result, 'credential')).toEqual({ app: 'opice', expiresAt: null })
		const grants = prop(detail.result, 'grants')
		expect(Array.isArray(grants) ? grants.map((grant: unknown) => prop(grant, 'id')).sort() : null).toEqual([original.id, addedId].sort())

		expect((await adminRpc(h, token, 'grants.delete', { id: original.id })).status).toBe(200)
		const narrowed = (await resolveKey(h, key.apiKey)).claims?.perms ?? []
		expect(permits(narrowed, 'report.write')).toBe(false)
		expect(permits(narrowed, 'secret.manage')).toBe(true)

		const changes = await h.repositories.audit.listAuditEvents({ resourceType: 'grant', limit: 10 })
		const recorded = changes.map((event) => [event.action, event.resource_id, prop(JSON.parse(event.metadata ?? 'null'), 'principalId')])
		expect(recorded).toContainEqual(['iam.grant.create', addedId, key.principalId])
		expect(recorded).toContainEqual(['iam.grant.revoke', original.id, key.principalId])
	})

	test('apiKeys.get answers 404 for a user and for an unknown id', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-person', email: 'person@example.com' })
		for (const principalId of [user, 'nobody']) {
			expect([principalId, (await adminRpc(h, token, 'apiKeys.get', { principalId })).status]).toEqual([principalId, 404])
		}
	})

	test('a revoked key has no live credential and no grant', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const key = await provision(h, token)
		expect((await run(h, req(`/admin/api-keys/${key.principalId}`, 'DELETE', token))).status).toBe(200)
		const detail = await adminRpc(h, token, 'apiKeys.get', { principalId: key.principalId })
		expect([prop(detail.result, 'status'), prop(detail.result, 'credential'), prop(detail.result, 'grants')]).toEqual(['disabled', null, []])
	})
})
