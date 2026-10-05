import { describe, expect, test } from 'bun:test'
import { parseProvisionApiKeyRequest, provisionApiKeyUseCase } from '../admin/api-keys'
import { putAppSchema } from '../admin/app-schema'
import type { AdminContext } from '../admin/context'
import { createGrantUseCase } from '../admin/grants'
import { createPolicyUseCase, updatePolicyUseCase } from '../admin/policies'
import { createShareLinkUseCase } from '../admin/share-links'
import { decodeFlight } from '../auth/oidc-flight'
import { getSigner } from '../signing'
import { parseStoredPermissions } from '../stored-permissions'
import { createHarness, type Harness, seedAppAction, seedUser } from './helpers/harness'

function context(h: Harness, body?: unknown): AdminContext {
	const url = new URL('https://iam.test/admin/apps/example/schema')
	return {
		services: h.makeServices(),
		request: new Request(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
		url,
		admin: { id: 'provisioning-admin', type: 'service', label: null, permissions: [{ action: '*', scope: null, source: 'grant' }] },
		app: 'propustka',
		requestId: 'validation-compatibility',
		ctx: { waitUntil() {} },
	}
}

describe('direct admin use-case contracts', () => {
	test('policy names and descriptions may be empty for a typed direct caller', async () => {
		const h = createHarness()
		try {
			seedAppAction(h.sqlite, 'example', 'read')
			const policy = await createPolicyUseCase(context(h), {
				app: 'example',
				policy: { key: 'reader', name: '', description: '', permissions: ['read'] },
			})
			expect(policy).toMatchObject({ key: 'reader', name: '', description: '', permissions: ['read'] })
			await expect(updatePolicyUseCase(context(h), { app: 'example', key: 'missing', policy: { name: '', permissions: [] } }))
				.rejects.toMatchObject({ httpStatus: 404, message: 'custom policy not found' })
			await expect(createPolicyUseCase(context(h), { app: 'missing', policy: { key: 'reader', name: '', permissions: [] } }))
				.rejects.toMatchObject({ httpStatus: 404, message: 'unknown app' })
		} finally {
			h.sqlite.close()
		}
	})

	test('grant normalization and domain errors do not depend on RPC validation', async () => {
		const h = createHarness()
		try {
			seedAppAction(h.sqlite, 'example', 'read')
			const principalId = seedUser(h.sqlite, { email: 'user@example.test', sub: 'user' })
			const grant = await createGrantUseCase(context(h), { principalId, app: 'example', permissions: ['read'], expiresAt: Number.POSITIVE_INFINITY })
			expect(grant).toMatchObject({ app: 'example', permissions: ['read'], expiresAt: null, scopeType: null, scopeValue: null })
			await expect(createGrantUseCase(context(h), { principalId, app: 'missing', permissions: [], scopeType: 'team' }))
				.rejects.toMatchObject({ httpStatus: 400, message: 'unknown app' })
			await expect(createGrantUseCase(context(h), { principalId, app: 'example', permissions: ['read'], scopeType: 'team' }))
				.rejects.toMatchObject({ httpStatus: 400, message: 'scopeType and scopeValue must be both set or both omitted' })
			await expect(provisionApiKeyUseCase(context(h), { label: ' ', type: 'service', app: 'missing', permissions: [] }))
				.rejects.toMatchObject({ httpStatus: 400, message: 'label and type=service required' })
			await expect(createShareLinkUseCase(context(h), { app: 'missing', grants: [{ action: '' }] }))
				.rejects.toMatchObject({ httpStatus: 400, message: 'grants required (each: { action, scope? })' })
		} finally {
			h.sqlite.close()
		}
	})
})

describe('REST provisioning tolerance', () => {
	test('malformed optional values are omitted; null scopes and empty strings retain their meaning', () => {
		expect(parseProvisionApiKeyRequest({
			label: '',
			type: 'service',
			roleKey: 1,
			permissions: ['read', 2],
			scopeType: null,
			scopeValue: '',
			app: false,
			expiresAt: Infinity,
			extra: true,
		})).toEqual({ label: '', type: 'service', scopeType: null, scopeValue: '' })
		expect(() => parseProvisionApiKeyRequest({ label: 'agent', type: 'user' })).toThrow('label and type=service required')
	})

	test('vocabulary reconciliation strips extensions and malformed optional descriptions', async () => {
		const h = createHarness()
		try {
			const response = await putAppSchema(
				context(h, {
					scopes: [{ type: '', label: 7 }],
					actions: [{ action: 'read', description: null, extra: true }],
					roles: { reader: { name: '', permissions: ['read'], description: false } },
					extra: true,
				}),
				'example',
			)
			expect(response.status).toBe(200)
			const decoded: unknown = await response.json()
			expect(decoded).toEqual({
				app: 'example',
				scopes: [{ type: '' }],
				actions: [{ action: 'read' }],
				roles: { reader: { name: '', permissions: ['read'] } },
			})
		} finally {
			h.sqlite.close()
		}
	})

	test('vocabulary errors keep envelope and per-role domain precedence', async () => {
		const h = createHarness()
		try {
			const badEnvelope = await putAppSchema(context(h, { scopes: [null], actions: [], roles: [] }), 'example')
			const envelopeError: unknown = await badEnvelope.json()
			expect(envelopeError).toEqual({ error: 'roles must be an object (role_key -> def)' })
			const badRole = await putAppSchema(
				context(h, {
					scopes: [],
					actions: [{ action: 'read' }],
					roles: { first: { name: 'first', permissions: ['write'] }, second: null },
				}),
				'example',
			)
			const roleError: unknown = await badRole.json()
			expect(roleError).toEqual({ error: "role 'first' references unknown action: write" })
		} finally {
			h.sqlite.close()
		}
	})
})

test('stored permissions keep valid strings in order and fail closed on invalid JSON', () => {
	expect(parseStoredPermissions('["read",null,42,"","read",{"action":"*"}]')).toEqual(['read', '', 'read'])
	expect(parseStoredPermissions('{"permissions":["*"]}')).toEqual([])
	expect(parseStoredPermissions('not json')).toEqual([])
})

test('signed OIDC flights retain optional-field tolerance and require a complete named handoff', async () => {
	const env = { ENVIRONMENT: 'local', FABRIKA_IAM_SIGNING_KEYS: '' }
	const signer = await getSigner(env)
	const base = { state: '', verifier: '', redirect: '' }
	const sign = (payload: Record<string, unknown>) => signer.signInternal(payload, 'fabrika:iam:oidc-flight', 600)
	expect(await decodeFlight(env, await sign({ ...base, app: 1, handoffState: false, extra: true }))).toEqual(base)
	expect(await decodeFlight(env, await sign({ ...base, app: 'example', handoffState: '' }))).toBeNull()
	expect(await decodeFlight(env, await sign({ ...base, app: 'example', handoffState: '', handoffChallenge: '' })))
		.toEqual({ ...base, app: 'example', handoffState: '', handoffChallenge: '' })
	expect(await decodeFlight(env, await sign({ ...base, state: 42 }))).toBeNull()
	const wrongAudience = await signer.signInternal(base, 'another-audience', 600)
	expect(await decodeFlight(env, wrongAudience)).toBeNull()
})
