import type { AuthContext } from '@fabrika/auth'
import type { DeviceAuthorizationRequest } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { ControlRpcDeps } from '../services'
import { approvalVerifier, humanCredential, pairingIam, pairingRequest } from './helpers/builder-pairing'
import { createHarness, queryRows } from './helpers/harness'
import { allowAllAuth, authWithPermissions } from './helpers/iam'
import { fakeControlProvider } from './helpers/provider'
import { rpcResult } from './helpers/rpc'

async function setup() {
	const h = createHarness()
	const stub = pairingIam()
	await h.repositories.registry.createApp({ id: 'notes', repoUrl: 'https://github.com/example/notes' })
	const deps: ControlRpcDeps = {
		repositories: h.repositories,
		auth: allowAllAuth(),
		provider: fakeControlProvider,
		builderPairingIam: stub.iam,
		queue: { send: async () => {} },
		logs: { get: async () => null },
		cancelRun: async () => {},
	}
	const proof = { attemptId: uuidv7(), approvalVerifier }
	const input = {
		...proof,
		appId: 'notes',
		environment: { env: 'prod', namespaceId: null, domain: null, publicOrigin: null, triggerRef: null },
	}
	const call = (method: string, value: unknown, auth: AuthContext = deps.auth) => rpcResult(pairingRequest(method, value), { ...deps, auth })
	return { h, stub, deps, proof, input, call }
}

test('public attempt id cannot squat a receipt; proof is checked on every retry and never persisted', async () => {
	const f = await setup()
	try {
		expect((await f.call('builderConnections.createReceipt', { ...f.input, approvalVerifier: undefined })).status).toBe(400)
		expect((await f.call('builderConnections.createReceipt', { ...f.input, approvalVerifier: 'B'.repeat(43) })).status).toBe(404)
		expect(await f.h.repositories.builderConnections.get(f.proof.attemptId)).toBeNull()
		const first = await f.call('builderConnections.createReceipt', f.input)
		expect(first.status).toBe(200)
		expect(await first.text()).not.toContain('creator')
		expect((await f.call('builderConnections.createReceipt', { ...f.input, approvalVerifier: 'B'.repeat(43) })).status).toBe(404)
		const stored = JSON.stringify(queryRows(f.h.sqlite, 'SELECT * FROM builder_connection_receipts'))
		expect(stored).not.toContain(approvalVerifier)
		expect(stored).not.toContain(createHash('sha256').update(approvalVerifier).digest('base64url'))
		expect(stored).not.toContain(humanCredential)
		expect((await f.h.repositories.builderConnections.find(f.proof.attemptId))?.creatorId).toBe('mem-admin')
		expect(f.stub.inspected.length).toBe(3)
		for (const inspected of f.stub.inspected) {
			expect(inspected).toMatchObject({ app: 'vozka', credential: humanCredential, attemptId: f.proof.attemptId })
		}
	} finally {
		f.h.sqlite.close()
	}
})

test('approval derives application scope only from a receipt owned by the verified human', async () => {
	const f = await setup()
	try {
		expect((await f.call('builderPairing.approve', f.proof)).status).toBe(404)
		expect((await f.call('builderConnections.createReceipt', f.input)).status).toBe(200)
		const other = { ...allowAllAuth(), principal: { id: 'other-human', type: 'user', label: 'other' } } satisfies AuthContext
		expect((await f.call('builderConnections.createReceipt', f.input, other)).status).toBe(409)
		expect((await f.call('builderPairing.approve', f.proof, other)).status).toBe(403)
		expect((await f.call('builderPairing.approve', { ...f.proof, appId: 'other-app' })).status).toBe(400)
		expect((await f.call('builderPairing.approve', { ...f.proof, scope: { type: 'app', value: 'other-app' } })).status).toBe(400)
		expect(f.stub.approved).toEqual([])
		const approval = await f.call('builderPairing.approve', f.proof)
		expect(approval.status).toBe(200)
		expect(await approval.json()).toMatchObject({ ok: true, consent: { app: 'vozka', scope: { type: 'app', value: 'notes' } } })
		expect(f.stub.approved).toHaveLength(1)
		expect(f.stub.approved[0]).toMatchObject({ ...f.proof, app: 'vozka', credential: humanCredential, scope: { type: 'app', value: 'notes' } })
	} finally {
		f.h.sqlite.close()
	}
})

test('inspect and creation refuse a non-builder audience, actions, lifetime, expiry or attempt coordinate', async () => {
	const f = await setup()
	try {
		const request: DeviceAuthorizationRequest = {
			attemptId: f.proof.attemptId,
			app: 'vozka',
			label: 'Local builder',
			permissions: ['app.manage', 'deploy.trigger', 'deploy.read'],
			keyLifetimeSeconds: 2592000,
			expiresAt: Math.floor(Date.now() / 1000) + 600,
		}
		for (
			const invalid of [
				{ ...request, app: 'notes' },
				{ ...request, permissions: ['*'] },
				{ ...request, permissions: ['app.manage', 'app.manage', 'deploy.read'] },
				{ ...request, permissions: [...request.permissions, 'namespace.manage'] },
				{ ...request, keyLifetimeSeconds: 2592001 },
				{ ...request, expiresAt: 1 },
				{ ...request, attemptId: uuidv7() },
			]
		) {
			const builderPairingIam = pairingIam({ inspectDeviceAuthorization: async () => ({ ok: true, request: invalid }) }).iam
			for (const [method, input] of [['builderPairing.inspect', f.proof], ['builderConnections.createReceipt', f.input]]) {
				if (typeof method !== 'string') throw new Error('invalid test method')
				expect((await rpcResult(pairingRequest(method, input), { ...f.deps, builderPairingIam })).status).toBe(409)
			}
		}
		expect(await f.h.repositories.builderConnections.get(f.proof.attemptId)).toBeNull()
	} finally {
		f.h.sqlite.close()
	}
})

test('human list/revoke remain available after loss of app grants and forward only the human credential', async () => {
	const f = await setup()
	try {
		const noGrants = authWithPermissions([])
		const credentialId = uuidv7()
		expect((await f.call('builderPairing.listOwn', {}, noGrants)).status).toBe(200)
		expect((await f.call('builderPairing.revoke', { credentialId }, noGrants)).status).toBe(200)
		expect(f.stub.listed[0]).toMatchObject({ app: 'vozka', credential: humanCredential })
		expect(f.stub.revoked[0]).toMatchObject({ app: 'vozka', credential: humanCredential, id: credentialId })
		const request = pairingRequest('builderPairing.revoke', { credentialId })
		request.headers.delete('X-Fabrika-Token')
		request.headers.set('Authorization', 'Bearer provisioning-key')
		expect((await rpcResult(request, f.deps)).status).toBe(401)
		expect(f.stub.revoked).toHaveLength(1)
		const denied = pairingIam({ revokeKey: async () => ({ ok: false, reason: 'not_allowed' }) })
		const refused = await rpcResult(pairingRequest('builderPairing.revoke', { credentialId }), { ...f.deps, builderPairingIam: denied.iam })
		const refusal: unknown = await refused.json()
		expect(refusal).toEqual({ ok: false, reason: 'not_allowed' })
	} finally {
		f.h.sqlite.close()
	}
})

test('all pairing management is human-only; denial verifies the proof and IAM authority loss is preserved', async () => {
	const f = await setup()
	try {
		const service = { ...allowAllAuth(), principal: { id: 'service', type: 'service', label: 'service' } } satisfies AuthContext
		for (const method of ['inspect', 'approve', 'deny']) {
			expect((await f.call(`builderPairing.${method}`, f.proof, service)).status).toBe(403)
		}
		expect((await f.call('builderPairing.listOwn', {}, service)).status).toBe(403)
		expect((await f.call('builderPairing.revoke', { credentialId: uuidv7() }, service)).status).toBe(403)
		expect((await f.call('builderPairing.deny', { ...f.proof, approvalVerifier: 'B'.repeat(43) })).status).toBe(404)
		expect(f.stub.denied).toEqual([])
		expect((await f.call('builderPairing.deny', f.proof)).status).toBe(200)
		expect(f.stub.denied[0]).toMatchObject(f.proof)
		expect((await f.call('builderConnections.createReceipt', f.input)).status).toBe(200)
		const lost = pairingIam({ approveDeviceAuthorization: async () => ({ ok: false, reason: 'authority_lost' }) })
		const approval = await rpcResult(pairingRequest('builderPairing.approve', f.proof), { ...f.deps, builderPairingIam: lost.iam })
		const result: unknown = await approval.json()
		expect(result).toEqual({ ok: false, reason: 'authority_lost' })
	} finally {
		f.h.sqlite.close()
	}
})
