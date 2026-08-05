/**
 * A gate rule is a promise that a route is served, gated, at the app's public hostname. This file
 * checks the promise against the application itself, in both directions:
 *
 *   - every declared rule has a request that matches it AND that the public hostname answers;
 *   - every path whose rule was retired is a 404 there, which is why it may not carry one.
 *
 * The second half is the regression [backlog 54](../../../../docs/backlog/54-give-operations-its-own-proxy-app-identity.md)
 * was filed for: a rule list that would not work if it mattered reads as though it does.
 */

import { applicableGates, buildAccessClaims, compileGates, type IamRpc, type Jwks, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { OPERATIONS_APP_ID, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createOperationsIam, OPERATIONS_AUTH_APP_ID } from '../auth.js'
import { OPERATIONS_PROXY_GATES } from '../gates.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { createOperationsFetchHandler } from '../http.js'
import { createHarness } from './helpers/sqlite.js'

const publicHost = 'errors.example.test'
const issuer = 'https://iam.example.test'
const { publicKey, privateKey } = await generateKeyPair('ES256')
const exportedPublicKey = await exportJWK(publicKey)
const jwks: Jwks = {
	keys: [{ kty: 'EC', crv: exportedPublicKey.crv, x: exportedPublicKey.x, y: exportedPublicKey.y, kid: 'gates-test', alg: 'ES256', use: 'sig' }],
}

const jwksRpc: IamRpc = {
	mintToken: () => Promise.resolve({ ok: false, reason: 'no_session' }),
	mintFromKey: () => Promise.resolve({ ok: false, reason: 'invalid_key' }),
	issueKey: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	issueJwt: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	getJwks: () => Promise.resolve(jwks),
	listPrincipals: () => Promise.resolve({ ok: true, principals: [] }),
	audit: () => Promise.resolve(),
	revokeKey: () => Promise.resolve({ ok: false, reason: 'not_found' }),
}

const iam = createOperationsIam({ IAM: jwksRpc, FABRIKA_IAM_URL: issuer })

const handler = createOperationsFetchHandler({
	repositories: createHarness().repositories,
	publicHost,
	syncKey: 'catalog-sync-key-with-at-least-32-characters',
	ingestQueue: { send: async () => {} },
	payloads: { put: async () => {}, get: async () => null, delete: async () => {} },
	health: new SqliteHealthRepository(createHarness().db),
	iam,
})

/** One request per declared rule, in declaration order — the sample that rule is supposed to admit. */
const SAMPLES: readonly { path: string; method: string }[] = [
	{ path: '/api/1/envelope/', method: 'POST' },
	{ path: OPERATIONS_SOURCE_MAP_UPLOAD_PATH, method: 'POST' },
]

/** What the retired rules used to describe. Each is answered by the app's own public-host guard. */
const NOT_SERVED_ON_THE_PUBLIC_HOST: readonly { path: string; method: string }[] = [
	{ path: '/healthz', method: 'GET' },
	{ path: '/private/catalog/reconcile', method: 'POST' },
	{ path: '/private/releases/reconcile', method: 'POST' },
	{ path: '/api/issues', method: 'GET' },
	{ path: '/api/rpc', method: 'POST' },
]

const compiled = compileGates(OPERATIONS_PROXY_GATES)

async function signed(audience: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: issuer,
		app: audience,
		subject: 'operator-1',
		type: 'user',
		label: 'operator@example.test',
		permissions: [{ action: 'operations.read', scope: null, source: 'grant' }],
		issuedAt: now,
		expiresAt: now + 300,
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'gates-test' }).sign(privateKey)
}

describe('every Operations gate rule describes a route the public hostname serves', () => {
	test('one sample per rule, in declaration order, matching that rule and only that rule', () => {
		expect(SAMPLES).toHaveLength(OPERATIONS_PROXY_GATES.rules.length)
		SAMPLES.forEach((sample, index) => {
			expect(applicableGates(compiled, sample.path).map((gate) => gate.rule)).toEqual([OPERATIONS_PROXY_GATES.rules[index]])
		})
	})

	test('and the application answers each of them there', async () => {
		for (const sample of SAMPLES) {
			const response = await handler(new Request(`https://${publicHost}${sample.path}`, { method: sample.method }))
			expect({ path: sample.path, status: response.status }).not.toEqual({ path: sample.path, status: 404 })
		}
	})

	test('every path with no rule is a 404 at the application, which is why it may not carry one', async () => {
		for (const unreachable of NOT_SERVED_ON_THE_PUBLIC_HOST) {
			expect(applicableGates(compiled, unreachable.path)).toEqual([])
			const response = await handler(new Request(`https://${publicHost}${unreachable.path}`, { method: unreachable.method }))
			expect({ path: unreachable.path, status: response.status }).toEqual({ path: unreachable.path, status: 404 })
		}
	})
})

describe('the audience Operations accepts', () => {
	test('is the app whose proxy fronts the operator surface, and no other', async () => {
		const accepted = await iam.authenticate(
			new Request('https://operations.internal/api/issues', { headers: { [PROXY_TOKEN_HEADER]: await signed(OPERATIONS_AUTH_APP_ID) } }),
		)
		expect(accepted.ok).toBe(true)

		// The Operations HOST's own app id is not it, and will not be until the operator surface moves
		// there (backlog 54). Flipping `OPERATIONS_AUTH_APP_ID` without that move refuses every operator
		// request the console makes, because the console's proxy is what minted the token.
		expect(OPERATIONS_AUTH_APP_ID).not.toBe(OPERATIONS_APP_ID)
		const refused = await iam.authenticate(
			new Request('https://operations.internal/api/issues', { headers: { [PROXY_TOKEN_HEADER]: await signed(OPERATIONS_APP_ID) } }),
		)
		expect(refused).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})
})
