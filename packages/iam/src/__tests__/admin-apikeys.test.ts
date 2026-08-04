import { parseAccessClaims, permits } from '@fabrika/auth-core'
import type { ProvisionApiKeyResponse, RotateApiKeyResponse } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { handleAdmin } from '../admin/router'
import type { RequestContext } from '../env'
import type { Services } from '../services'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedGrant, seedUser } from './helpers/harness'

// End-to-end tests for the admin /api-keys flow minting a propustka-NATIVE key: provision creates a
// native service principal + grant and returns a `px_` key that `mintFromKey` resolves to the service
// principal's permissions; rotate invalidates the old one; revoke kills it. No Cloudflare Access.

const ISSUER = 'https://propustka.test'
// The service's configured issuer IS the origin the console is served on; the CSRF guard compares
// against it, so a test that posts from a different origin than it configures is testing nothing real.
const ORIGIN = ISSUER
const SIGN_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', FABRIKA_IAM_PROVISIONING_KEY: '', ENVIRONMENT: 'local' }
// env slice handleAdmin needs; 'stage' keeps the local-dev bypass off so the session path runs.
const ADMIN_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', FABRIKA_IAM_PROVISIONING_KEY: '', ENVIRONMENT: 'stage' }

class FakeRequestContext implements RequestContext {
	waitUntil(_promise: Promise<unknown>): void {}
}

function services(h: Harness): Services {
	return h.makeServices({ environment: 'stage', issuer: ISSUER, adminOrigins: [ISSUER] })
}

async function asAdmin(h: Harness): Promise<string> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	return h.signSession(id)
}

function req(path: string, method: string, session: string, body?: unknown): Request {
	const headers = new Headers({ Cookie: `px_session=${session}` })
	if (method !== 'GET') {
		headers.set('Origin', ORIGIN)
		headers.set('Content-Type', 'application/json')
	}
	return new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

function run(h: Harness, request: Request): Promise<Response> {
	return handleAdmin(request, services(h), ADMIN_ENV, new FakeRequestContext())
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

		const rotateRes = await run(h, req(`/admin/api-keys/${first.principalId}/rotate`, 'POST', token))
		expect(rotateRes.status).toBe(200)
		const rotated: RotateApiKeyResponse = await rotateRes.json()
		expect(rotated.apiKey.startsWith('px_')).toBe(true)
		expect(rotated.apiKey).not.toBe(first.apiKey)

		// Old key is dead; new key works.
		expect((await resolveKey(h, first.apiKey)).failed).toBe('invalid_key')
		expect((await resolveKey(h, rotated.apiKey)).claims?.ptype).toBe('service')
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

		await run(h, req(`/admin/api-keys/${provisioned.principalId}/rotate`, 'POST', token))
		const carried = (await h.repositories.credentials.listCredentialsForPrincipal(provisioned.principalId)).find((row) => row.revoked_at === null)
		expect(carried?.expires_at).toBe(expiresAt)
		// The app binding rides along too — a rotated key is the same credential with a new secret.
		expect(carried?.app).toBe('opice')

		const later = expiresAt + 3600
		await run(h, req(`/admin/api-keys/${provisioned.principalId}/rotate`, 'POST', token, { expiresAt: later }))
		const restated = (await h.repositories.credentials.listCredentialsForPrincipal(provisioned.principalId)).find((row) => row.revoked_at === null)
		expect(restated?.expires_at).toBe(later)

		// A past expiry is refused exactly as provisioning refuses one.
		const past = await run(h, req(`/admin/api-keys/${provisioned.principalId}/rotate`, 'POST', token, { expiresAt: 1 }))
		expect(past.status).toBe(400)
	})

	test('rotate refuses a DISABLED principal', async () => {
		// Handing out a working secret for an account somebody just revoked. The same guard
		// `passwordUser` already applies to the password paths.
		const h = createHarness()
		const token = await asAdmin(h)
		const provisioned = await provision(h, token)
		await h.repositories.principals.disablePrincipal(provisioned.principalId)

		const response = await run(h, req(`/admin/api-keys/${provisioned.principalId}/rotate`, 'POST', token))
		expect(response.status).toBe(409)
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
