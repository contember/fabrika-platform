import { describe, expect, test } from 'bun:test'
import { LOCAL_DEV_ADMIN_ID, PROVISIONING_ADMIN_ID, resolveCaller } from '../auth'
import type { Env } from '../env'
import { hashToken } from '../secret'
import { createHarness, seedUser } from './helpers/harness'

// SEC-1: the local-dev bypass guard in `resolveCaller`. The bypass resolves an unauthenticated
// global-admin caller so the example app / admin scripts work against `lopata`/`wrangler dev`. It
// must be IMPOSSIBLE outside local dev — so it fires ONLY when ENVIRONMENT=local AND no durable
// signing keys are configured AND no credential is presented. Plus the `px_` key resolution path.

const REQUEST = 'r1'

/** env slice resolveCaller needs. Default: no durable signing keys (the dev signal), no provisioning key. */
function env(signingKeys = '', provisioningKey = ''): Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'> {
	return { FABRIKA_IAM_SIGNING_KEYS: signingKeys, FABRIKA_IAM_PROVISIONING_KEY: provisioningKey, ENVIRONMENT: 'local' }
}

describe('resolveCaller — local dev bypass (SEC-1 guard)', () => {
	test('fires in local with no signing keys and no credential → global-admin caller', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'local' })
		const res = await resolveCaller(services, env(), { app: 'reports', credential: null, requestId: REQUEST })
		expect(res.ok).toBe(true)
		if (!res.ok) throw new Error('unreachable')
		expect(res.caller.id).toBe(LOCAL_DEV_ADMIN_ID)
		expect(res.caller.permissions).toEqual([{ action: '*', scope: null, source: 'bootstrap' }])
		// Unlike the old CF-Access bypass, the verified app IS the requested app.
		expect(res.verifiedApp).toBe('reports')
	})

	test('does NOT fire in stage (no credential → missing_token)', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const res = await resolveCaller(services, env(), { app: 'reports', credential: null, requestId: REQUEST })
		expect(res).toEqual({ ok: false, reason: 'missing_token' })
	})

	test('does NOT fire in local when durable signing keys ARE configured', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'local' })
		const res = await resolveCaller(services, env('[{"kty":"EC"}]'), { app: 'reports', credential: null, requestId: REQUEST })
		expect(res).toEqual({ ok: false, reason: 'missing_token' })
	})
})

describe('resolveCaller — px_ key resolution', () => {
	test('an unknown px_ key → invalid_token', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const res = await resolveCaller(services, env(), { app: 'reports', credential: 'px_nope', requestId: REQUEST })
		expect(res).toEqual({ ok: false, reason: 'invalid_token' })
	})

	test('a valid anonymous px_ key resolves to an anonymous caller carrying its frozen grants', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const issuerId = seedUser(h.sqlite, { sub: 'iss', email: 'iss@contember.com' })
		const key = 'px_share-link'
		const credId = await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			issuedBy: issuerId,
			app: 'reports',
			grants: [{ action: 'report.read' }],
		})

		const res = await resolveCaller(services, env(), { app: 'reports', credential: key, requestId: REQUEST })
		expect(res.ok).toBe(true)
		if (!res.ok) throw new Error('unreachable')
		// Anonymous (no principal binding) → no `type`; subject is the credential id.
		expect(res.caller.type).toBeUndefined()
		expect(res.caller.id).toBe(credId)
		expect(res.caller.permissions).toEqual([{ action: 'report.read', scope: null, source: 'grant' }])
		// The VERIFIED app comes off the credential, not from the caller's assertion.
		expect(res.verifiedApp).toBe('reports')
	})

	test('an anonymous key is refused at any app but its own, and one with no app at all is dead', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const issuerId = seedUser(h.sqlite, { sub: 'iss2', email: 'iss2@contember.com' })

		const bound = 'px_bound-to-reports'
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(bound),
			issuedBy: issuerId,
			app: 'reports',
			grants: [{ action: '*' }],
		})
		// The attack SEC-2 describes: authority delegated at one app, presented at another.
		expect(await resolveCaller(services, env(), { app: 'billing', credential: bound, requestId: REQUEST }))
			.toEqual({ ok: false, reason: 'invalid_token' })

		// A pre-cutover link (no app) resolves nowhere at all — it has to be reissued.
		const legacy = 'px_legacy-no-app'
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(legacy),
			issuedBy: issuerId,
			grants: [{ action: 'report.read' }],
		})
		expect(await resolveCaller(services, env(), { app: 'reports', credential: legacy, requestId: REQUEST }))
			.toEqual({ ok: false, reason: 'invalid_token' })
	})
})

// The SEEDED PROVISIONING KEY: a single operator-generated `px_` held only in env (FABRIKA_IAM_PROVISIONING_KEY),
// never in the DB. Recognized at resolution time BEFORE the DB lookup — the machine analog of
// IAM_BOOTSTRAP_ADMINS, so a fresh control plane can reconcile/issue before any admin credential exists.
describe('resolveCaller — seeded provisioning key', () => {
	const PROVISIONING_KEY = 'px_provisioning-secret'

	test('a bearer matching FABRIKA_IAM_PROVISIONING_KEY → synthetic global-admin, no DB row', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const res = await resolveCaller(services, env('', PROVISIONING_KEY), { app: 'vozka', credential: PROVISIONING_KEY, requestId: REQUEST })
		expect(res.ok).toBe(true)
		if (!res.ok) throw new Error('unreachable')
		expect(res.caller.id).toBe(PROVISIONING_ADMIN_ID)
		expect(res.caller.type).toBe('service')
		expect(res.caller.label).toBe('provisioning')
		expect(res.caller.permissions).toEqual([{ action: '*', scope: null, source: 'bootstrap' }])
		expect(res.verifiedApp).toBe('vozka')
	})

	test('a different px_ key does NOT match → falls through to the DB path (invalid_token)', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const res = await resolveCaller(services, env('', PROVISIONING_KEY), {
			app: 'vozka',
			credential: 'px_not-the-provisioning-key',
			requestId: REQUEST,
		})
		expect(res).toEqual({ ok: false, reason: 'invalid_token' })
	})

	test('empty FABRIKA_IAM_PROVISIONING_KEY disables the seed (the same token resolves via the DB → invalid)', async () => {
		const h = createHarness()
		const services = h.makeServices({ environment: 'stage' })
		const res = await resolveCaller(services, env('', ''), { app: 'vozka', credential: PROVISIONING_KEY, requestId: REQUEST })
		expect(res).toEqual({ ok: false, reason: 'invalid_token' })
	})
})
