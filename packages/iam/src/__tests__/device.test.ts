import {
	parsePollDeviceAuthorizationResult,
	parseStartDeviceAuthorizationResult,
	permits,
	type StartDeviceAuthorizationInput,
	uuidv7,
} from '@fabrika/auth-core'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HttpIamRpc } from '../../../auth/src/rpc-http'
import { createIamApp } from '../app'
import { runIamMaintenance } from '../cron'
import {
	approveDeviceAuthorization,
	cancelDeviceAuthorization,
	denyDeviceAuthorization,
	exchangeDeviceAuthorization,
	inspectDeviceAuthorization,
	listOwnDeviceAuthorizations,
	pollDeviceAuthorization,
	startDeviceAuthorization,
} from '../device'
import type { Env } from '../env'
import { pkceChallenge, randomToken } from '../oidc'
import { resolveServicePermissions } from '../resolve'
import { createIamRpc } from '../rpc'
import { handleRpcHttp } from '../rpc-http'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { mintFromKey, signAccessToken } from '../tokens'
import { createHarness, type Harness, seedInlineGrant, seedService, seedUser } from './helpers/harness'

let h: Harness
let services: Services
let env: Env
let principalId: string
let credential: string
const actions = ['app.manage', 'deploy.trigger', 'deploy.read']
const scope = { type: 'app', value: 'delivery-application' }
const now = () => Math.floor(Date.now() / 1000)
const exec = { waitUntil: (_promise: Promise<unknown>) => {} }

beforeEach(async () => {
	h = createHarness()
	services = h.makeServices()
	env = {
		DB: {
			prepare: () => {
				throw new Error('unused')
			},
			batch: () => Promise.reject(new Error('unused')),
		},
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: '[]',
		ENVIRONMENT: 'local',
		ISSUER: services.config.issuer,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	}
	principalId = seedUser(h.sqlite, { email: 'pair@example.test', sub: 'pair-user' })
	seedInlineGrant(h.sqlite, principalId, actions, scope, 'vozka')
	credential = await token(principalId)
})
afterEach(() => h.sqlite.close())

function token(subject: string, type: 'user' | 'service' = 'user', app = 'vozka') {
	return signAccessToken(services, env, {
		app,
		subject,
		type,
		label: 'Pairing test',
		permissions: [{ action: '*', scope: null, source: 'grant' }],
		issuedAt: now(),
		expiresAt: now() + 300,
	})
}

async function attempt() {
	const approvalVerifier = randomToken(32)
	const redemptionVerifier = randomToken(32)
	const input: StartDeviceAuthorizationInput = {
		app: 'vozka',
		label: 'Local builder',
		permissions: actions,
		keyLifetimeSeconds: 2592000,
		approvalChallenge: await pkceChallenge(approvalVerifier),
		redemptionChallenge: await pkceChallenge(redemptionVerifier),
	}
	const started = await startDeviceAuthorization(services, input, null)
	if (!started.ok) throw new Error('start failed')
	const caller = { app: 'vozka', credential, requestId: 'device-test', attemptId: started.attemptId, approvalVerifier }
	const proof = { attemptId: started.attemptId, redemptionVerifier }
	return { input, started, caller, proof }
}

async function approved() {
	const setup = await attempt()
	const approval = await approveDeviceAuthorization(services, env, { ...setup.caller, scope })
	if (!approval.ok) throw new Error(`approval failed: ${approval.reason}`)
	return { ...setup, consent: approval.consent, exchange: { ...setup.proof, consentId: approval.consent.consentId } }
}

function count(table: string) {
	return h.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1
}

describe('device authorization', () => {
	test('stored requests use the canonical permission parser and reject corrupted permissions', async () => {
		const setup = await attempt()
		h.sqlite.run('UPDATE device_authorizations SET permissions = ? WHERE id = ?', ['["app.manage",1]', setup.started.attemptId])
		await expect(inspectDeviceAuthorization(services, env, setup.caller)).rejects.toThrow('Invalid stored device request')
	})

	test('delegates only the live app scope, stores hashes, issues once and recovers receipts after expiry', async () => {
		const setup = await approved()
		const first = await exchangeDeviceAuthorization(services, setup.exchange, 'exchange')
		expect(first.ok).toBe(true)
		if (!first.ok) throw new Error('exchange failed')
		expect(first.receipt.consent).toEqual(setup.consent)
		const stored = await h.repositories.credentials.getCredentialById(first.receipt.credentialId)
		expect(stored?.token_hash).toBe(await hashToken(first.token))
		expect(stored?.issued_by).toBe(principalId)
		expect(stored?.app).toBe('vozka')
		expect(stored?.expires_at).toBe(setup.consent.keyExpiresAt)
		const grants = await h.repositories.grants.getActiveGrantsForApp(first.receipt.principalId, 'vozka')
		expect(grants).toHaveLength(1)
		expect(grants[0]?.scope_value).toBe(scope.value)
		const minted = await mintFromKey(services, env, { app: 'other', key: first.token, requestId: 'wrong-audience' })
		expect(minted.result).toEqual({ ok: false, reason: 'invalid_key' })
		const service = await h.repositories.principals.getPrincipalById(first.receipt.principalId)
		if (!service) throw new Error('missing service principal')
		const effective = await resolveServicePermissions(h.repositories, service, 'vozka')
		// The persisted scope must not become global or cover another application.
		expect(grants[0]?.scope_type).toBe('app')
		expect(permits(effective, 'app.manage')).toBe(false)
		expect(permits(effective, 'app.manage', { type: 'app', value: 'other' })).toBe(false)
		h.sqlite.run('UPDATE device_authorizations SET expires_at = 1')
		expect(await exchangeDeviceAuthorization(services, setup.exchange, 'replay')).toEqual({
			ok: false,
			reason: 'already_issued',
			receipt: first.receipt,
		})
		expect(await pollDeviceAuthorization(services, setup.proof)).toEqual({ ok: true, status: 'issued', receipt: first.receipt })
		expect(await cancelDeviceAuthorization(services, setup.proof)).toEqual({ ok: false, reason: 'already_issued' })
		expect(count('credentials')).toBe(1)
		expect(count('audit_events')).toBe(1)
		const persisted = JSON.stringify(h.sqlite.query('SELECT * FROM device_authorizations').all())
		for (const secret of [first.token, credential, setup.proof.redemptionVerifier, setup.caller.approvalVerifier]) {
			expect(persisted).not.toContain(secret)
		}
	})

	test('concurrent exchanges produce exactly one credential and one audit event', async () => {
		const setup = await approved()
		const results = await Promise.all(Array.from({ length: 12 }, () => exchangeDeviceAuthorization(services, setup.exchange, 'race')))
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(results.filter((result) => !result.ok && result.reason === 'already_issued')).toHaveLength(11)
		expect(count('credentials')).toBe(1)
		expect(count('audit_events')).toBe(1)
		expect(count('grants')).toBe(2)
	})

	test('mid-batch failure rolls back claim, identity, grants and credential, then retries', async () => {
		const setup = await approved()
		const principalsBefore = count('principals')
		h.sqlite.run("CREATE TRIGGER fail_device_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
		await expect(exchangeDeviceAuthorization(services, setup.exchange, 'rollback')).rejects.toThrow('injected failure')
		expect(count('principals')).toBe(principalsBefore)
		expect(count('credentials')).toBe(0)
		expect(count('grants')).toBe(1)
		expect((await h.repositories.device.get(setup.started.attemptId))?.claim_id).toBeNull()
		h.sqlite.run('DROP TRIGGER fail_device_audit')
		expect((await exchangeDeviceAuthorization(services, setup.exchange, 'retry')).ok).toBe(true)
	})

	test('wrong proofs are indistinguishable from unknown attempts and never mutate', async () => {
		const setup = await approved()
		const before = await h.repositories.device.get(setup.started.attemptId)
		const wrong = { ...setup.proof, redemptionVerifier: randomToken(32) }
		expect(await pollDeviceAuthorization(services, wrong)).toEqual(await pollDeviceAuthorization(services, { ...wrong, attemptId: uuidv7() }))
		expect(await cancelDeviceAuthorization(services, wrong)).toEqual({ ok: false, reason: 'invalid_attempt' })
		expect(await exchangeDeviceAuthorization(services, { ...wrong, consentId: setup.consent.consentId }, 'wrong')).toEqual({
			ok: false,
			reason: 'invalid_attempt',
		})
		expect(await inspectDeviceAuthorization(services, env, { ...setup.caller, approvalVerifier: randomToken(32) })).toEqual({
			ok: false,
			reason: 'invalid_attempt',
		})
		expect(await h.repositories.device.get(setup.started.attemptId)).toEqual(before)
	})

	test('poll window is atomic; polling never creates a credential', async () => {
		const setup = await approved()
		const results = await Promise.all(Array.from({ length: 10 }, () => pollDeviceAuthorization(services, setup.proof)))
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(results.filter((result) => !result.ok && result.reason === 'slow_down')).toHaveLength(9)
		expect(count('credentials')).toBe(0)
	})

	test('pending, denial, cancellation, expiry and consent mismatch refuse exchange', async () => {
		const pending = await attempt()
		expect(await exchangeDeviceAuthorization(services, { ...pending.proof, consentId: uuidv7() }, 'pending')).toEqual({ ok: false, reason: 'pending' })
		expect(await denyDeviceAuthorization(services, env, pending.caller)).toEqual({ ok: true })
		expect(await exchangeDeviceAuthorization(services, { ...pending.proof, consentId: uuidv7() }, 'denied')).toEqual({ ok: false, reason: 'denied' })
		const cancelled = await approved()
		await cancelDeviceAuthorization(services, cancelled.proof)
		expect(await exchangeDeviceAuthorization(services, cancelled.exchange, 'cancelled')).toEqual({ ok: false, reason: 'cancelled' })
		const expired = await approved()
		expect(await exchangeDeviceAuthorization(services, { ...expired.exchange, consentId: uuidv7() }, 'mismatch')).toEqual({
			ok: false,
			reason: 'consent_mismatch',
		})
		h.sqlite.run('UPDATE device_authorizations SET expires_at = 1 WHERE id = ?', [expired.started.attemptId])
		expect(await exchangeDeviceAuthorization(services, expired.exchange, 'expired')).toEqual({ ok: false, reason: 'expired' })
		const keyExpired = await approved()
		h.sqlite.run('UPDATE device_authorizations SET key_expires_at = 1 WHERE id = ?', [keyExpired.started.attemptId])
		expect(await pollDeviceAuthorization(services, keyExpired.proof)).toEqual({ ok: true, status: 'expired' })
		expect(await exchangeDeviceAuthorization(services, keyExpired.exchange, 'key-expired')).toEqual({ ok: false, reason: 'expired' })
		expect(count('credentials')).toBe(0)
	})

	test('approval is immutable and only the same human/scope retry is idempotent', async () => {
		const setup = await approved()
		expect(await approveDeviceAuthorization(services, env, { ...setup.caller, scope })).toEqual({ ok: true, consent: setup.consent })
		seedInlineGrant(h.sqlite, principalId, ['*'], null, 'vozka')
		expect(await approveDeviceAuthorization(services, env, { ...setup.caller, scope: { type: 'app', value: 'other' } })).toEqual({
			ok: false,
			reason: 'conflict',
		})
		const other = seedUser(h.sqlite, { email: 'other@example.test', sub: 'other' })
		seedInlineGrant(h.sqlite, other, ['*'], null, 'vozka')
		expect(await approveDeviceAuthorization(services, env, { ...setup.caller, credential: await token(other), scope })).toEqual({
			ok: false,
			reason: 'conflict',
		})
		expect(await denyDeviceAuthorization(services, env, setup.caller)).toEqual({ ok: false, reason: 'conflict' })
	})

	test('requires active human and live audience grants, never JWT permission snapshots', async () => {
		const setup = await attempt()
		const machine = seedService(h.sqlite, { commonName: 'machine' })
		for (const invalid of ['px_provisioning', await token(machine, 'service'), await token(principalId, 'user', 'other')]) {
			expect(await approveDeviceAuthorization(services, env, { ...setup.caller, credential: invalid, scope })).toEqual({
				ok: false,
				reason: 'not_allowed',
			})
		}
		h.sqlite.run('DELETE FROM grants')
		expect(await approveDeviceAuthorization(services, env, { ...setup.caller, scope })).toEqual({ ok: false, reason: 'not_allowed' })
		seedInlineGrant(h.sqlite, principalId, actions, scope, 'other')
		expect(await approveDeviceAuthorization(services, env, { ...setup.caller, scope })).toEqual({ ok: false, reason: 'not_allowed' })
		h.sqlite.run('UPDATE principals SET disabled_at = 1 WHERE id = ?', [principalId])
		expect(await inspectDeviceAuthorization(services, env, setup.caller)).toEqual({ ok: false, reason: 'not_allowed' })
		h.sqlite.run('UPDATE principals SET disabled_at = NULL, activated_at = NULL WHERE id = ?', [principalId])
		expect(await inspectDeviceAuthorization(services, env, setup.caller)).toEqual({ ok: false, reason: 'not_allowed' })
	})

	for (const mutation of ['DELETE FROM grants', 'UPDATE principals SET disabled_at = 1']) {
		test(`exchange refreshes authority: ${mutation}`, async () => {
			const setup = await approved()
			h.sqlite.run(mutation)
			expect(await exchangeDeviceAuthorization(services, setup.exchange, 'lost')).toEqual({ ok: false, reason: 'authority_lost' })
			expect(count('credentials')).toBe(0)
		})
	}

	test('issuer lists and revokes after grant removal, with pagination and revocation status', async () => {
		const setup = await approved()
		const issued = await exchangeDeviceAuthorization(services, setup.exchange, 'issue')
		if (!issued.ok) throw new Error('exchange failed')
		h.sqlite.run('DELETE FROM grants WHERE principal_id = ?', [principalId])
		const rpc = createIamRpc(env, exec)
		expect(await rpc.revokeKey({ app: 'vozka', credential, requestId: 'revoke', id: issued.receipt.credentialId })).toEqual({ ok: true, revoked: true })
		const list = await listOwnDeviceAuthorizations(services, env, setup.caller)
		if (!list.ok) throw new Error('list failed')
		expect(list.items).toHaveLength(1)
		expect(list.items[0]?.revokedAt).toBeGreaterThan(0)
		expect(await listOwnDeviceAuthorizations(services, env, { ...setup.caller, before: setup.started.attemptId })).toEqual({
			ok: true,
			items: [],
			nextCursor: null,
		})
	})

	test('caps key lifetime, restricts audiences and bounds concurrent starts without a client coordinate', async () => {
		const setup = await attempt()
		expect(await startDeviceAuthorization(services, { ...setup.input, app: 'unregistered' }, null)).toEqual({ ok: false, reason: 'not_allowed' })
		const capped = await startDeviceAuthorization(services, { ...setup.input, keyLifetimeSeconds: 9999999 }, null)
		if (!capped.ok) throw new Error('start failed')
		expect((await h.repositories.device.get(capped.attemptId))?.key_lifetime_seconds).toBe(2592000)
		expect(capped.expiresAt - now()).toBe(600)
		const burst = await Promise.all(Array.from({ length: 30 }, () => startDeviceAuthorization(services, setup.input, null)))
		expect(burst.filter((result) => result.ok)).toHaveLength(18)
		expect((await startDeviceAuthorization(services, setup.input, 'trusted-client')).ok).toBe(true)
	})

	test('public routes precede auth routing, require bounded JSON and ignore cookies', async () => {
		const setup = await attempt()
		const app = createIamApp()
		const response = await app.fetch(
			new Request('http://localhost/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: '__Host-px_session=ignored' },
				body: JSON.stringify(setup.proof),
			}),
			env,
			exec,
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(parsePollDeviceAuthorizationResult(await response.json())).toEqual({ ok: true, status: 'pending', expiresAt: setup.started.expiresAt })
		const oversized = await app.fetch(
			new Request('http://localhost/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ data: 'x'.repeat(16384) }),
			}),
			env,
			exec,
		)
		expect(oversized.status).toBe(400)
		const get = await app.fetch(new Request('http://localhost/auth/device/start'), env, exec)
		expect(get.status).toBe(405)
		expect(get.headers.get('cache-control')).toBe('no-store')
		const starts = await Promise.all(Array.from({ length: 21 }, (_, index) =>
			app.fetch(
				new Request('http://localhost/auth/device/start', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-forwarded-for': `spoof-${index}` },
					body: JSON.stringify(setup.input),
				}),
				env,
				exec,
			)))
		const bodies = await Promise.all(starts.map(async (item) => parseStartDeviceAuthorizationResult(await item.json())))
		expect(bodies.filter((body) => body?.ok === false && body.reason === 'rate_limited')).toHaveLength(2)
	})

	test('Bun HTTP and SDK management transport have identical observable results', async () => {
		const setup = await attempt()
		const rpc = createIamRpc(env, exec)
		const client = new HttpIamRpc({
			origin: 'http://iam.test',
			key: 'transport-secret',
			fetch: (url, init) => handleRpcHttp(new Request(url, init), rpc, 'transport-secret'),
		})
		expect(await client.inspectDeviceAuthorization(setup.caller)).toEqual(await rpc.inspectDeviceAuthorization(setup.caller))
		const approval = await client.approveDeviceAuthorization({ ...setup.caller, scope })
		expect(approval.ok).toBe(true)
		expect(await client.approveDeviceAuthorization({ ...setup.caller, scope })).toEqual(approval)
		expect(await client.denyDeviceAuthorization(setup.caller)).toEqual({ ok: false, reason: 'conflict' })
		expect(await client.listOwnDeviceAuthorizations(setup.caller)).toEqual({ ok: true, items: [], nextCursor: null })
	})

	test('maintenance retains issued receipts until key expiry plus a day', async () => {
		const pending = await attempt()
		const setup = await approved()
		await exchangeDeviceAuthorization(services, setup.exchange, 'issue')
		h.sqlite.run('UPDATE device_authorizations SET expires_at = 1')
		const tasks: Promise<unknown>[] = []
		runIamMaintenance(env, {
			waitUntil: (task) => {
				tasks.push(task)
			},
		})
		await Promise.all(tasks)
		expect(await h.repositories.device.get(pending.started.attemptId)).toBeNull()
		expect(await h.repositories.device.get(setup.started.attemptId)).not.toBeNull()
		await h.repositories.device.prune(setup.consent.keyExpiresAt + 86399)
		expect(await h.repositories.device.get(setup.started.attemptId)).not.toBeNull()
		await h.repositories.device.prune(setup.consent.keyExpiresAt + 86400)
		expect(await h.repositories.device.get(setup.started.attemptId)).toBeNull()
		expect(count('audit_events')).toBe(1)
	})
})
