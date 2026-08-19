import { buildAccessClaims, type IamRpc, type Jwks, type PermissionEntry, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import {
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
} from '@fabrika/operations-contract/catalog'
import {
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	OPERATIONS_RELEASE_RECONCILE_PATH,
	OPERATIONS_SOURCE_MAP_UPLOAD_PATH,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
} from '@fabrika/operations-contract/releases'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createOperationsIam } from '../auth.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { createOperationsFetchHandler } from '../http.js'
import { createHarness } from './helpers/sqlite.js'

const publicHost = 'errors.example.test'
const syncKey = 'catalog-sync-key-with-at-least-32-characters'
const issuer = 'https://iam.example.test'
const { publicKey, privateKey } = await generateKeyPair('ES256')
const exportedPublicKey = await exportJWK(publicKey)
const jwks: Jwks = {
	keys: [{
		kty: 'EC',
		crv: exportedPublicKey.crv,
		x: exportedPublicKey.x,
		y: exportedPublicKey.y,
		kid: 'operations-test',
		alg: 'ES256',
		use: 'sig',
	}],
}

const operationsIam = () => createOperationsIam({ IAM: sessionRpc('unused'), FABRIKA_IAM_ISSUER: issuer })

const handler = (harness = createHarness(), iam = operationsIam()) => {
	return createOperationsFetchHandler({
		repositories: harness.repositories,
		publicHost,
		syncKey,
		ingestQueue: { send: async () => {} },
		payloads: {
			put: async () => {},
			get: async () => null,
			delete: async () => {},
		},
		health: new SqliteHealthRepository(harness.db),
		iam,
	})
}

function rpcRequest(host: string, method: string, input: unknown, token?: string): Request {
	return new Request(`https://${host}/api/rpc`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			...(token === undefined ? {} : { [PROXY_TOKEN_HEADER]: token }),
		},
		body: JSON.stringify({ method, input }),
	})
}

/**
 * An IAM-shaped access token for an operator holding `actions` globally — the shape the proxy injects.
 * Operator roles are exercised by GRANTS, the way they resolve in production; there is no dev persona.
 */
async function operatorToken(actions: readonly string[], label = 'operator@example.test'): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const permissions: PermissionEntry[] = actions.map((action) => ({ action, scope: null, source: 'grant' }))
	const claims = buildAccessClaims({
		iss: issuer,
		app: 'vozka',
		subject: 'operator-1',
		type: 'user',
		label,
		permissions,
		issuedAt: now,
		expiresAt: now + 300,
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'operations-test' }).sign(privateKey)
}

/** Read-only and full-operator callers, the two the authorization assertions below distinguish. */
const VIEWER_TOKEN = await operatorToken(['operations.read'], 'viewer@example.test')
const OPERATOR_TOKEN = await operatorToken(['operations.read', 'operations.triage', 'operations.manage'])

function sessionRpc(token: string): IamRpc {
	return {
		mintToken: () => Promise.resolve({ ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 }),
		mintFromKey: () => Promise.resolve({ ok: false, reason: 'invalid_key' }),
		issueKey: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		issueJwt: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		getJwks: () => Promise.resolve(jwks),
		listPrincipals: () => Promise.resolve({ ok: true, principals: [] }),
		audit: () => Promise.resolve(),
		revokeKey: () => Promise.resolve({ ok: false, reason: 'not_found' }),
	}
}

async function reconcileSource(fetch: (request: Request) => Promise<Response>, sourceId: string): Promise<Response> {
	const sources: OperationsCatalogSourceV2[] = [{
		coordinate: { appId: 'app', environment: 'prod' },
		displayName: 'App production',
		ingestCredential: {
			id: sourceId,
			publicKey: '0123456789abcdef0123456789abcdef',
		},
	}]
	return fetch(
		new Request('https://operations.internal/private/catalog/reconcile', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${syncKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
				revision: 1,
				snapshotHash: await operationsCatalogSnapshotHash(sources),
				sources,
			}),
		}),
	)
}

describe('Operations public/private HTTP isolation', () => {
	test('the public ingest hostname does not expose health, catalog, or operator paths', async () => {
		const fetch = handler()
		for (const path of ['/healthz', '/private/catalog/reconcile', OPERATIONS_RELEASE_RECONCILE_PATH, '/api/issues', '/api/rpc']) {
			const response = await fetch(new Request(`https://${publicHost}${path}`, { method: path.includes('catalog') ? 'POST' : 'GET' }))
			expect(response.status).toBe(404)
		}
	})

	test('malformed percent-encoding stays on the not-found boundary', async () => {
		const fetch = handler()
		expect((await fetch(new Request(`https://${publicHost}/%`))).status).toBe(404)
		expect(
			(await fetch(new Request('https://operations.internal/api/%', { headers: { [PROXY_TOKEN_HEADER]: OPERATOR_TOKEN } }))).status,
		).toBe(404)
	})

	test('the public hostname mounts only the exact source-map upload path', async () => {
		const fetch = handler()
		const upload = await fetch(new Request(`https://${publicHost}${OPERATIONS_SOURCE_MAP_UPLOAD_PATH}`, { method: 'POST' }))
		expect(upload.status).toBe(401)
		const missingSlash = await fetch(
			new Request(`https://${publicHost}${OPERATIONS_SOURCE_MAP_UPLOAD_PATH.slice(0, -1)}`, { method: 'POST' }),
		)
		expect(missingSlash.status).toBe(404)
	})

	test('the private service hostname reaches health and authenticated catalog reconciliation', async () => {
		const fetch = handler()
		expect((await fetch(new Request('https://operations.internal/healthz'))).status).toBe(200)
		expect((await fetch(new Request('https://operations.internal/healthz', { method: 'HEAD' }))).status).toBe(200)

		const response = await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')
		expect(response.status).toBe(200)
	})

	test('the private release route accepts the exact Control projection shape and persists it', async () => {
		const harness = createHarness(() => 1_700_000_000_000)
		const fetch = handler(harness)
		expect((await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')).status).toBe(200)
		const commitSha = 'a'.repeat(40)
		const releaseName = operationsReleaseName({ appId: 'app', environment: 'prod', commitSha })
		const request: OperationsReleaseReconcileRequestV1 = {
			protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
			revision: 1,
			runId: '0198a000-0000-7000-8000-000000000002',
			coordinate: { appId: 'app', environment: 'prod' },
			phase: 'started',
			providerRunId: null,
			outcome: null,
			artifactState: 'pending',
			release: { kind: 'available', name: releaseName, commitSha },
			uploadCredential: {
				verifier: 'b'.repeat(64),
				expiresAt: 1_700_007_200_000,
			},
			observedAt: 1_700_000_000_001,
		}
		const response = await fetch(
			new Request(`https://operations.internal${OPERATIONS_RELEASE_RECONCILE_PATH}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${syncKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(request),
			}),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
			revision: 1,
			outcome: 'applied',
		})
		expect(
			await harness.db.prepare(`SELECT
					release.release_name, release.commit_sha, run.phase, run.projection_revision
				FROM releases release
				JOIN deploy_run_links run ON run.release_id = release.id
				WHERE run.run_id = ?`)
				.bind(request.runId)
				.first<{
					release_name: string
					commit_sha: string
					phase: string
					projection_revision: number
				}>(),
		).toEqual({
			release_name: releaseName,
			commit_sha: commitSha,
			phase: 'started',
			projection_revision: 1,
		})
	})

	test('the private operator API enforces scoped IAM permissions while the public hostname stays closed', async () => {
		const fetch = handler()
		expect((await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')).status).toBe(200)
		const sourcesResponse = await fetch(
			new Request('https://operations.internal/api/sources', { headers: { [PROXY_TOKEN_HEADER]: VIEWER_TOKEN } }),
		)
		expect(sourcesResponse.status).toBe(200)
		const sourcesBody: unknown = await sourcesResponse.json()
		if (sourcesBody === null || typeof sourcesBody !== 'object' || !('items' in sourcesBody) || !Array.isArray(sourcesBody.items)) {
			throw new Error('expected an operator source list')
		}
		const source = sourcesBody.items[0]
		if (source === null || typeof source !== 'object' || !('id' in source) || typeof source.id !== 'string') {
			throw new Error('expected one operator source')
		}
		const sourceId = source.id
		const createCheck = (token: string) =>
			fetch(
				new Request(`https://operations.internal/api/sources/${sourceId}/health-checks`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', [PROXY_TOKEN_HEADER]: token },
					body: JSON.stringify({
						path: '/healthz',
						enabled: true,
						intervalMs: 60_000,
						timeoutMs: 5_000,
						expectedStatus: 200,
						failureThreshold: 3,
						recoveryThreshold: 2,
						staleAfterMs: 180_000,
					}),
				}),
			)
		expect((await createCheck(VIEWER_TOKEN)).status).toBe(404)
		expect((await createCheck(OPERATOR_TOKEN)).status).toBe(201)
		expect((await fetch(new Request(`https://${publicHost}/api/sources`))).status).toBe(404)
	})

	test('the private RPC route exposes the typed operator use-cases and preserves hidden not-found authorization', async () => {
		const fetch = handler()
		expect((await fetch(rpcRequest(publicHost, 'sources', null, VIEWER_TOKEN))).status).toBe(404)
		expect((await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')).status).toBe(200)

		const sources = await fetch(rpcRequest('operations.internal', 'sources', null, VIEWER_TOKEN))
		expect(sources.status).toBe(200)
		const sourcesBody: unknown = await sources.json()
		if (sourcesBody === null || typeof sourcesBody !== 'object' || !('result' in sourcesBody)) {
			throw new Error('expected an RPC result')
		}
		expect(sourcesBody.result).toMatchObject({ items: [{ appId: 'app', environment: 'prod' }] })

		const forbidden = await fetch(
			rpcRequest('operations.internal', 'createHealthCheck', {
				sourceId: '0198a000-0000-7000-8000-000000000001',
				input: {
					path: '/healthz',
					enabled: true,
					intervalMs: 60_000,
					timeoutMs: 5_000,
					expectedStatus: 200,
					failureThreshold: 3,
					recoveryThreshold: 2,
					staleAfterMs: 180_000,
				},
			}, VIEWER_TOKEN),
		)
		expect(forbidden.status).toBe(404)
		const forbiddenBody: unknown = await forbidden.json()
		expect(forbiddenBody).toEqual({ error: { type: 'not_found', message: 'not found' } })
	})

	test('RPC validation uses the common error envelope and does not reach a use-case', async () => {
		const invalidCalls: Array<[string, unknown, string]> = [
			['source', { sourceId: '' }, 'sourceId must be a non-empty string'],
			['mutateIssue', { issueId: 'issue-a', mutation: { kind: 'assign', principalId: '' } }, 'principalId must be a non-empty string'],
			[
				'mutateIssue',
				{ issueId: 'issue-a', mutation: { kind: 'resolve_in_release', releaseId: '' } },
				'releaseId must be a non-empty string',
			],
		]
		for (const [method, input, message] of invalidCalls) {
			const response = await handler()(rpcRequest('operations.internal', method, input, VIEWER_TOKEN))
			expect(response.status).toBe(400)
			const body: unknown = await response.json()
			expect(body).toMatchObject({ error: { type: 'validation', message } })
		}
	})

	test('an RPC request with no proxy-injected token is a flat 401 auth envelope (the proxy owns the bounce)', async () => {
		const response = await handler()(rpcRequest('operations.internal', 'sources', null))
		expect(response.status).toBe(401)
		const body: unknown = await response.json()
		if (body === null || typeof body !== 'object' || !('error' in body) || body.error === null || typeof body.error !== 'object') {
			throw new Error('expected an authentication error')
		}
		expect(body.error).toMatchObject({ type: 'auth', message: 'authentication required' })
		expect('loginUrl' in body.error).toBe(false)
	})

	test('the operator is resolved from the proxy-injected token, verified locally', async () => {
		const fetch = handler()
		const response = await fetch(
			new Request('http://operations:3000/api/sources', { headers: { [PROXY_TOKEN_HEADER]: VIEWER_TOKEN } }),
		)

		expect(response.status).toBe(200)
	})

	test('a forged token in that header is refused — the app does not trust the proxy blindly', async () => {
		const fetch = handler()
		const response = await fetch(
			new Request('http://operations:3000/api/sources', { headers: { [PROXY_TOKEN_HEADER]: 'not.a.jwt' } }),
		)

		expect(response.status).toBe(401)
	})
})
