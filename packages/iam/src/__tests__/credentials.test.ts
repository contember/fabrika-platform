import { MAX_KEY_LIFETIME_SECONDS, parseAccessClaims, type PermissionEntry, permits, type Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { issueKey, revokeKey } from '../issue'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedInlineGrant, seedService, seedUser } from './helpers/harness'

const ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ISSUER = 'https://propustka.test'

function perm(action: string, scope: Scope | null = null): PermissionEntry {
	return { action, scope, source: 'grant' }
}

function inOneHour(): number {
	return Math.floor(Date.now() / 1000) + 3600
}

/** Declare `actions` in `app`'s catalog, as a deploy's schema reconcile would. */
function catalog(h: Harness, app: string, ...actions: string[]): void {
	for (const action of actions) {
		seedAppAction(h.sqlite, app, action)
	}
}

/** Verify a minted token EXACTLY as the SDK will: a local JWKS over the issuer's published keys. */
async function verify(token: string, app: string) {
	const signer = await getSigner(ENV)
	const { payload } = await jwtVerify(token, createLocalJWKSet(signer.jwks()), { issuer: ISSUER, audience: app })
	return parseAccessClaims(payload)
}

describe('issueKey → mintFromKey (standalone, frozen inline grants)', () => {
	test('mints an anonymous access token carrying the frozen scoped grant', async () => {
		const h = createHarness()
		catalog(h, 'opice', 'report.write')
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss', email: 'iss@contember.com' })
		seedInlineGrant(h.sqlite, issuerId, ['report.write'], null, 'opice')
		const issuer = { id: issuerId, permissions: [perm('report.write')] } // holds it globally → may delegate scoped

		const issued = await issueKey(
			services,
			{
				app: 'opice',
				credential: null,
				requestId: 'r1',
				permissions: [{ action: 'report.write', scope: { type: 'project', value: 'demo' } }],
				label: 'opice CI',
				expiresAt: inOneHour(),
			},
			issuer,
			'opice',
		)
		expect(issued.result.ok).toBe(true)
		if (!issued.result.ok) throw new Error('expected ok')
		expect(issued.result.token.startsWith('px_')).toBe(true)

		const { result, credentialId } = await mintFromKey(services, ENV, { app: 'opice', key: issued.result.token, requestId: 'r2' })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(credentialId).toBe(issued.result.id)

		const claims = await verify(result.token, 'opice')
		expect(claims?.ptype).toBeUndefined() // anonymous — no principal
		expect(claims?.sub).toBe(issued.result.id)
		expect(permits(claims?.perms ?? [], 'report.write', { type: 'project', value: 'demo' })).toBe(true)
		expect(permits(claims?.perms ?? [], 'report.write', { type: 'project', value: 'other' })).toBe(false)
	})

	test('a credential granting nothing is refused at issue', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss2', email: 'iss2@contember.com' })
		const issued = await issueKey(services, { app: 'a', credential: null, requestId: 'r', expiresAt: inOneHour() }, {
			id: issuerId,
			permissions: [perm('*')],
		}, 'a')
		expect(issued.result).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('delegation: an issuer cannot mint a key beyond its own permissions', async () => {
		const h = createHarness()
		catalog(h, 'a', 'report.read', 'report.delete')
		const services = h.makeServices({ issuer: ISSUER })
		const issued = await issueKey(
			services,
			{
				app: 'a',
				credential: null,
				requestId: 'r',
				permissions: [{ action: 'report.delete' }],
				expiresAt: inOneHour(),
			},
			{ id: seedUser(h.sqlite, { sub: 'iss3', email: 'iss3@contember.com' }), permissions: [perm('report.read')] },
			'a',
		)
		expect(issued.result).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

describe('issueKey → mintFromKey (principal-bound)', () => {
	test('a self-bound key carries the principal LIVE resolved permissions', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const svcId = seedService(h.sqlite, { commonName: 'svc-cn', label: 'svc' })
		seedInlineGrant(h.sqlite, svcId, ['project.read'], null, 'app-x')

		const issued = await issueKey(
			services,
			{
				app: 'app-x',
				credential: null,
				requestId: 'r',
				principalId: svcId,
				expiresAt: inOneHour(),
			},
			{ id: svcId, permissions: [perm('project.read')] },
			'app-x',
		)
		expect(issued.result.ok).toBe(true)
		if (!issued.result.ok) throw new Error('expected ok')

		const { result } = await mintFromKey(services, ENV, { app: 'app-x', key: issued.result.token, requestId: 'r2' })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		const claims = await verify(result.token, 'app-x')
		expect(claims?.ptype).toBe('service')
		expect(claims?.sub).toBe(svcId)
		expect(permits(claims?.perms ?? [], 'project.read')).toBe(true)
	})

	test('inline grants DOWNSCOPE a bound key (effective = principal ∩ inline)', async () => {
		const h = createHarness()
		catalog(h, 'app-x', 'project.read', 'project.write')
		const services = h.makeServices({ issuer: ISSUER })
		const svcId = seedService(h.sqlite, { commonName: 'svc-2' })
		seedInlineGrant(h.sqlite, svcId, ['project.read', 'project.write'], null, 'app-x')

		const issued = await issueKey(
			services,
			{
				app: 'app-x',
				credential: null,
				requestId: 'r',
				principalId: svcId,
				expiresAt: inOneHour(),
				permissions: [{ action: 'project.read' }], // downscope to read-only
			},
			{ id: svcId, permissions: [perm('project.read'), perm('project.write')] },
			'app-x',
		)
		expect(issued.result.ok).toBe(true)
		if (!issued.result.ok) throw new Error('expected ok')

		const { result } = await mintFromKey(services, ENV, { app: 'app-x', key: issued.result.token, requestId: 'r2' })
		if (!result.ok) throw new Error('expected ok')
		const claims = await verify(result.token, 'app-x')
		expect(permits(claims?.perms ?? [], 'project.read')).toBe(true)
		expect(permits(claims?.perms ?? [], 'project.write')).toBe(false) // dropped by the downscope
	})

	test('binding to ANOTHER principal is refused (v1: self only)', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const issued = await issueKey(
			services,
			{
				app: 'a',
				credential: null,
				requestId: 'r',
				principalId: 'someone-else',
				expiresAt: inOneHour(),
			},
			{ id: seedUser(h.sqlite, { sub: 'me', email: 'me@contember.com' }), permissions: [perm('*')] },
			'a',
		)
		expect(issued.result).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

describe('issueKey service mode (folded service token)', () => {
	test('creates a fresh service principal + grant, binds the key, mintFromKey resolves its perms', async () => {
		const h = createHarness()
		catalog(h, 'opice', 'report.write')
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss-svc', email: 'iss@contember.com' })

		const issued = await issueKey(
			services,
			{
				app: 'opice',
				credential: null,
				requestId: 'r1',
				service: { label: 'opice CI', permissions: ['report.write'], scope: { type: 'project', value: 'demo' } },
				expiresAt: inOneHour(),
			},
			{ id: issuerId, permissions: [perm('report.write')] }, // holds it globally → may delegate scoped
			'opice',
		)
		expect(issued.result.ok).toBe(true)
		if (!issued.result.ok) throw new Error('expected ok')
		expect(issued.result.token.startsWith('px_')).toBe(true)
		expect(issued.result.principalId).toBeTruthy()

		const { result } = await mintFromKey(services, ENV, { app: 'opice', key: issued.result.token, requestId: 'r2' })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		const claims = await verify(result.token, 'opice')
		expect(claims?.ptype).toBe('service')
		expect(claims?.sub).toBe(issued.result.principalId)
		expect(permits(claims?.perms ?? [], 'report.write', { type: 'project', value: 'demo' })).toBe(true)
		expect(permits(claims?.perms ?? [], 'report.write', { type: 'project', value: 'other' })).toBe(false)
	})

	test('delegation: a service grant beyond the issuer is refused', async () => {
		const h = createHarness()
		catalog(h, 'a', 'report.read', 'report.delete')
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss-svc2', email: 'iss2@contember.com' })
		const issued = await issueKey(
			services,
			{ app: 'a', credential: null, requestId: 'r', service: { label: 'x', permissions: ['report.delete'] }, expiresAt: inOneHour() },
			{ id: issuerId, permissions: [perm('report.read')] },
			'a',
		)
		expect(issued.result).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a service grant with no permissions is refused', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss-svc3', email: 'iss3@contember.com' })
		const issued = await issueKey(
			services,
			{ app: 'a', credential: null, requestId: 'r', service: { label: 'x', permissions: [] }, expiresAt: inOneHour() },
			{ id: issuerId, permissions: [perm('*')] },
			'a',
		)
		expect(issued.result).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

describe('mintFromKey failures', () => {
	test('an unknown key → invalid_key', async () => {
		const h = createHarness()
		const { result } = await mintFromKey(h.makeServices({ issuer: ISSUER }), ENV, { app: 'a', key: 'px_nope', requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })
	})

	test('a key bound to a disabled principal → disabled', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const svcId = seedService(h.sqlite, { commonName: 'svc-d', disabled: true })
		const key = 'px_live-key'
		await services.repositories.credentials.createCredential({ tokenHash: await hashToken(key), principalId: svcId, issuedBy: svcId, grants: [] })
		const { result } = await mintFromKey(services, ENV, { app: 'a', key, requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'disabled' })
	})

	test('a revoked key no longer resolves', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const key = 'px_to-revoke'
		const issuerId = seedUser(h.sqlite, { sub: 'iss-rev', email: 'rev@contember.com' })
		const id = await services.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			issuedBy: issuerId,
			grants: [{ action: 'x' }],
		})
		expect(await services.repositories.credentials.revokeCredential(id)).toBe(true)
		const { result } = await mintFromKey(services, ENV, { app: 'a', key, requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })
	})
})

// ── P0.2: every key expires within the bound and grants only catalog actions ────────────────────

type IssueMode = 'service' | 'standalone' | 'self-bound'

/** One request per mode, all for app `a`, by an issuer who holds everything. */
async function issueIn(mode: IssueMode, options: { expiresAt: number; action?: string }) {
	const h = createHarness()
	catalog(h, 'a', 'report.read')
	const services = h.makeServices({ issuer: ISSUER })
	const issuerId = seedUser(h.sqlite, { sub: `iss-${mode}`, email: `${mode}@contember.com` })
	const action = options.action ?? 'report.read'
	const base = { app: 'a', credential: null, requestId: 'r', expiresAt: options.expiresAt }
	const input = mode === 'service'
		? { ...base, service: { label: 'svc', permissions: [action] } }
		: mode === 'standalone'
		? { ...base, permissions: [{ action }] }
		: { ...base, principalId: issuerId, permissions: [{ action }] }
	const outcome = await issueKey(services, input, { id: issuerId, permissions: [perm('*')] }, 'a')
	return { h, outcome }
}

const MODES: IssueMode[] = ['service', 'standalone', 'self-bound']

describe('issueKey: an expiry is required, in the future and within MAX_KEY_LIFETIME_SECONDS', () => {
	test.each(MODES)('%s: an expiry in the past is refused and writes nothing', async (mode) => {
		const { h, outcome } = await issueIn(mode, { expiresAt: Math.floor(Date.now() / 1000) - 1 })
		expect(outcome.result).toEqual({ ok: false, reason: 'not_allowed' })
		expect(outcome.problem).toBe('expiresAt must be a future unix time in seconds')
		expect(h.sqlite.query('SELECT id FROM credentials').all()).toHaveLength(0)
	})

	test.each(MODES)('%s: an expiry beyond the bound is refused and writes nothing', async (mode) => {
		const { h, outcome } = await issueIn(mode, { expiresAt: Math.floor(Date.now() / 1000) + MAX_KEY_LIFETIME_SECONDS + 60 })
		expect(outcome.result).toEqual({ ok: false, reason: 'not_allowed' })
		expect(outcome.problem).toContain('at most 2592000 seconds')
		expect(h.sqlite.query('SELECT id FROM credentials').all()).toHaveLength(0)
		expect(h.sqlite.query("SELECT id FROM principals WHERE label = 'svc'").all()).toHaveLength(0)
	})

	test.each(MODES)('%s: an expiry inside the bound is stored on the credential', async (mode) => {
		const expiresAt = Math.floor(Date.now() / 1000) + MAX_KEY_LIFETIME_SECONDS - 60
		const { h, outcome } = await issueIn(mode, { expiresAt })
		expect(outcome.result.ok).toBe(true)
		expect(h.sqlite.query<{ expires_at: number }, []>('SELECT expires_at FROM credentials').all()).toEqual([{ expires_at: expiresAt }])
	})

	test('a fractional expiry is refused', async () => {
		const { outcome } = await issueIn('standalone', { expiresAt: inOneHour() + 0.5 })
		expect(outcome.result).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

describe("issueKey: only exact actions of the app's catalog", () => {
	test.each(MODES)('%s: an unknown action is refused even for an issuer holding `*`', async (mode) => {
		const { h, outcome } = await issueIn(mode, { expiresAt: inOneHour(), action: 'report.delete' })
		expect(outcome.result).toEqual({ ok: false, reason: 'not_allowed' })
		expect(outcome.problem).toBe('unknown action: report.delete')
		expect(h.sqlite.query('SELECT id FROM credentials').all()).toHaveLength(0)
	})

	test.each(MODES)('%s: a wildcard is refused, even one over a declared namespace', async (mode) => {
		for (const action of ['*', 'report.*', 'billing.*']) {
			const { h, outcome } = await issueIn(mode, { expiresAt: inOneHour(), action })
			expect(outcome.result).toEqual({ ok: false, reason: 'not_allowed' })
			expect(outcome.problem).toBe(`a key lists exact actions, not the wildcard: ${action}`)
			expect(h.sqlite.query('SELECT id FROM credentials').all()).toHaveLength(0)
		}
	})

	test("another app's catalog does not count", async () => {
		const h = createHarness()
		catalog(h, 'other', 'report.delete')
		const issuerId = seedUser(h.sqlite, { sub: 'iss-x', email: 'x@contember.com' })
		const outcome = await issueKey(
			h.makeServices({ issuer: ISSUER }),
			{ app: 'a', credential: null, requestId: 'r', expiresAt: inOneHour(), permissions: [{ action: 'report.delete' }] },
			{ id: issuerId, permissions: [perm('*')] },
			'a',
		)
		expect(outcome.problem).toBe('unknown action: report.delete')
	})
})

describe('revokeKey: only a credential of the caller app', () => {
	async function issuedFor(h: Harness, app: string, issuerId: string): Promise<string> {
		catalog(h, app, 'report.read')
		const outcome = await issueKey(
			h.makeServices({ issuer: ISSUER }),
			{ app, credential: null, requestId: 'r', expiresAt: inOneHour(), permissions: [{ action: 'report.read' }] },
			{ id: issuerId, permissions: [perm('*')] },
			app,
		)
		if (!outcome.result.ok) throw new Error('expected the key to be issued')
		return outcome.result.id
	}

	test('the issuer cannot revoke its own key from another app: not_found, and the key stays live', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss-rv', email: 'rv@contember.com' })
		const id = await issuedFor(h, 'reports', issuerId)

		const revoker = { id: issuerId, permissions: [perm('*')] }
		expect(await revokeKey(services, { app: 'other', credential: null, requestId: 'r', id }, revoker, 'other')).toEqual({
			ok: false,
			reason: 'not_found',
		})
		expect((await services.repositories.credentials.getCredentialById(id))?.revoked_at).toBeNull()

		expect(await revokeKey(services, { app: 'reports', credential: null, requestId: 'r', id }, revoker, 'reports')).toEqual({
			ok: true,
			revoked: true,
		})
	})

	test('a cross-app credential (no app) is not revocable through an app', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER })
		const issuerId = seedUser(h.sqlite, { sub: 'iss-null', email: 'null@contember.com' })
		const id = await services.repositories.credentials.createCredential({
			tokenHash: await hashToken('px_cross-app'),
			principalId: issuerId,
			issuedBy: issuerId,
			grants: [],
		})
		expect(await revokeKey(services, { app: 'reports', credential: null, requestId: 'r', id }, { id: issuerId, permissions: [] }, 'reports'))
			.toEqual({ ok: false, reason: 'not_found' })
	})
})
