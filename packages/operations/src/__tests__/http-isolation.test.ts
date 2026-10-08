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
import { describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { z } from 'zod'
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

const validationErrorSchema = z.object({
	error: z.object({
		type: z.literal('validation'),
		message: z.string(),
		issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })),
	}),
})

/** The dotted path of every rejected field, in the order the schema reports them. */
async function validationPaths(response: Response): Promise<string[]> {
	expect(response.status).toBe(400)
	const { error } = validationErrorSchema.parse(await response.json())
	return error.issues.map((issue) => issue.path.join('.'))
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
		inspectDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		approveDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		denyDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		listOwnDeviceAuthorizations: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
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
	test('removed administrative REST routes return 404 on both hosts with or without a token', async () => {
		const fetch = handler()
		const paths = [
			'/api/sources',
			'/api/sources/source-a',
			'/api/sources/source-a/assignees',
			'/api/issues',
			'/api/issues/bulk',
			'/api/issues/issue-a',
			'/api/issues/issue-a/occurrences',
			'/api/issues/issue-a/events/latest',
			'/api/issues/issue-a/events/event-a',
			'/api/releases',
			'/api/releases/release-a',
			'/api/health',
			'/api/sources/source-a/health',
			'/api/sources/source-a/health-checks',
			'/api/sources/source-a/health-checks/check-a',
			'/api/sources/source-a/alerts',
			'/api/sources/source-a/alerts/spike',
			'/api/sources/source-a/alerts/rules/new_issue',
			'/api/sources/source-a/alerts/channels',
			'/api/sources/source-a/alerts/channels/channel-a',
		]
		for (const host of [publicHost, 'operations.internal']) {
			for (const token of [undefined, OPERATOR_TOKEN]) {
				for (const path of paths) {
					for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
						const response = await fetch(
							new Request(`https://${host}${path}`, {
								method,
								headers: token === undefined ? {} : { [PROXY_TOKEN_HEADER]: token },
							}),
						)
						expect({ path, method, host, status: response.status }).toEqual({ path, method, host, status: 404 })
					}
				}
			}
		}
	})

	test('RPC never logs or returns dynamic error details from an operator failure', async () => {
		const harness = createHarness()
		await harness.repositories.sources.upsert({ id: 'source-a', appId: 'app', environment: 'prod', displayName: 'App', enabled: true })
		const iam = createOperationsIam({
			IAM: {
				...sessionRpc('unused'),
				listPrincipals: () => Promise.reject(new Error('https://secret.example.test/?credential=do-not-log')),
			},
			FABRIKA_IAM_ISSUER: issuer,
		})
		const log = spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const response = await handler(harness, iam)(rpcRequest('operations.internal', 'assignees', { sourceId: 'source-a' }, OPERATOR_TOKEN))
			expect(response.status).toBe(500)
			const body: unknown = await response.json()
			expect(body).toEqual({ error: { type: 'internal', message: 'internal error' } })
			expect(log).toHaveBeenCalledWith('operations operator RPC failed')
			expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log')
		} finally {
			log.mockRestore()
		}
	})

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
			rpcRequest('operations.internal', 'sources', null, VIEWER_TOKEN),
		)
		expect(sourcesResponse.status).toBe(200)
		const envelope: unknown = await sourcesResponse.json()
		if (envelope === null || typeof envelope !== 'object' || !('result' in envelope)) throw new Error('expected RPC result')
		const sourcesBody = envelope.result
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
				rpcRequest('operations.internal', 'createHealthCheck', {
					sourceId,
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
				}, token),
			)
		expect((await createCheck(VIEWER_TOKEN)).status).toBe(404)
		expect((await createCheck(OPERATOR_TOKEN)).status).toBe(200)
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
		const invalidCalls: Array<[string, unknown, string[]]> = [
			['source', { sourceId: '' }, ['sourceId']],
			['mutateIssue', { issueId: 'issue-a', mutation: { kind: 'assign', principalId: '' } }, ['mutation.principalId']],
			['mutateIssue', { issueId: 'issue-a', mutation: { kind: 'resolve_in_release', releaseId: '' } }, ['mutation.releaseId']],
		]
		for (const [method, input, paths] of invalidCalls) {
			expect(await validationPaths(await handler()(rpcRequest('operations.internal', method, input, VIEWER_TOKEN)))).toEqual(paths)
		}
	})

	test('static RPC schemas report every malformed field', async () => {
		const cases: Array<[string, unknown, string[]]> = [
			['source', [], ['']],
			['issues', { sourceId: null, query: 1, status: 'invalid' }, ['sourceId', 'query', 'status']],
			['issues', { cursor: false, status: 'invalid', level: 'invalid' }, ['cursor', 'status', 'level']],
			['issues', { window: 'invalid', assignee: 'invalid', sort: 'invalid', limit: 0 }, ['window', 'assignee', 'sort', 'limit']],
			['issueOccurrences', { issueId: '', cursor: false, limit: 0 }, ['issueId', 'cursor', 'limit']],
			['issueOccurrences', { issueId: '', limit: 0 }, ['issueId', 'limit']],
			['releases', { sourceId: null, cursor: false, limit: 0 }, ['sourceId', 'cursor', 'limit']],
			['mutateIssue', { issueId: '', mutation: null }, ['issueId', 'mutation']],
			['mutateIssue', { issueId: 'issue-a', mutation: null }, ['mutation']],
			['createHealthCheck', { sourceId: '', input: null }, ['sourceId', 'input']],
			['updateSpikeAlert', { sourceId: '', input: null }, ['sourceId', 'input']],
			['updateSpikeAlert', { sourceId: '', input: {} }, ['sourceId', 'input.threshold', 'input.enabled']],
			['updateAlertRule', { sourceId: '', kind: 'invalid', input: null }, ['sourceId', 'kind', 'input']],
			['updateAlertRule', { sourceId: 'source-a', kind: 'invalid', input: {} }, ['kind', 'input.enabled']],
			['createAlertChannel', { sourceId: '', input: {} }, ['sourceId', 'input.scope', 'input.type', 'input.target', 'input.enabled']],
			['createAlertChannel', { sourceId: 'source-a', input: { type: 'webhook', scope: 'invalid', target: 4 } }, [
				'input.scope',
				'input.target',
				'input.enabled',
			]],
			['updateAlertChannel', { sourceId: 'source-a', channelId: '', input: {} }, ['channelId', 'input.scope', 'input.type', 'input.enabled']],
			['updateAlertChannel', { sourceId: 'source-a', channelId: 'channel-a', input: { type: 'webhook', scope: 'invalid', target: null } }, [
				'input.scope',
				'input.target',
				'input.enabled',
			]],
			['updateAlertChannel', { sourceId: 'source-a', channelId: 'channel-a', input: { type: 'webhook', scope: 'invalid' } }, [
				'input.scope',
				'input.enabled',
			]],
		]
		const fetch = handler()
		for (const [method, input, paths] of cases) {
			expect(await validationPaths(await fetch(rpcRequest('operations.internal', method, input, VIEWER_TOKEN)))).toEqual(paths)
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

	test('RPC rejects invalid operator payloads with validation envelopes and no writes', async () => {
		const harness = createHarness()
		await harness.repositories.sources.upsert({ id: 'source-a', appId: 'app', environment: 'prod', displayName: 'App', enabled: true })
		const recorded = await harness.repositories.ingest.record({
			sourceId: 'source-a',
			fingerprint: 'failure',
			eventId: 'event-a',
			title: 'Failure',
			culprit: null,
			level: 'error',
			release: null,
			receivedAt: 1_000,
			blobKey: 'event-a',
		})
		const issueId = recorded.issue.id
		if (issueId === null) throw new Error('expected an issue id')
		const fetch = handler(harness)
		const cases: Array<{ method: string; input: unknown; paths: string[] }> = []
		const mutations: Array<[unknown, string]> = [
			[{ kind: 'status', status: 'closed' }, 'status'],
			[{ kind: 'comment', text: '' }, 'text'],
			[{ kind: 'assign' }, 'principalId'],
			[{ kind: 'snooze_until', until: 0 }, 'until'],
			[{ kind: 'snooze_count', additional: 1.5 }, 'additional'],
			[{ kind: 'resolve_in_release' }, 'releaseId'],
			[{ kind: 'merge', targetIssueId: null }, 'targetIssueId'],
			[{ kind: 'unknown' }, 'kind'],
		]
		for (const [body, field] of mutations) {
			cases.push({ method: 'mutateIssue', input: { issueId, mutation: body }, paths: [`mutation.${field}`] })
		}
		const health = {
			path: '/health',
			enabled: true,
			intervalMs: 60_000,
			timeoutMs: 5_000,
			expectedStatus: 200,
			failureThreshold: 3,
			recoveryThreshold: 2,
			staleAfterMs: 180_000,
		}
		const healthFailures: Array<[string, unknown]> = [
			['path', ''],
			['enabled', 1],
			['intervalMs', '60000'],
			['timeoutMs', -1],
			['expectedStatus', 0],
			['failureThreshold', 1.5],
			['recoveryThreshold', null],
			['staleAfterMs', Number.MAX_SAFE_INTEGER + 1],
		]
		for (const [field, value] of healthFailures) {
			const body = { ...health, [field]: value }
			cases.push({
				method: 'createHealthCheck',
				input: { sourceId: 'source-a', input: body },
				paths: [`input.${field}`],
			})
		}
		const settings: Array<[string, unknown, string[]]> = [
			['updateSpikeAlert', { threshold: 0, enabled: 'wrong' }, ['input.threshold', 'input.enabled']],
			['updateSpikeAlert', { threshold: 5, enabled: null }, ['input.enabled']],
			['updateAlertRule', { enabled: 1 }, ['input.enabled']],
			['createAlertChannel', { scope: 'new_issue', type: 'email' }, ['input.type', 'input.target', 'input.enabled']],
			['createAlertChannel', { scope: 'new_issue', type: 'webhook', enabled: true }, ['input.target']],
		]
		for (const [method, body, paths] of settings) {
			cases.push({
				method,
				input: { sourceId: 'source-a', kind: 'new_issue', input: body },
				paths,
			})
		}
		for (
			const [body, paths] of [
				[{ issueIds: 'wrong', status: 'wrong' }, ['issueIds', 'status']],
				[{ issueIds: [issueId, ''], status: 'wrong' }, ['issueIds.1', 'status']],
				[{ issueIds: [issueId], status: 'wrong' }, ['status']],
			] satisfies Array<[unknown, string[]]>
		) {
			cases.push({ method: 'bulkIssueStatus', input: body, paths })
		}
		for (const entry of cases) {
			expect(await validationPaths(await fetch(rpcRequest('operations.internal', entry.method, entry.input, OPERATOR_TOKEN)))).toEqual(entry.paths)
		}
		expect((await harness.repositories.issues.get('source-a', 'failure'))?.status).toBe('open')
		expect(await new SqliteHealthRepository(harness.db).listChecks('source-a')).toEqual([])
		expect(await harness.repositories.alerts.getConfig('source-a')).toBeNull()
		expect(await harness.repositories.alerts.listRules('source-a')).toEqual([])
		expect(await harness.repositories.alerts.listChannels('source-a')).toEqual([])
	})

	test('channel validation reports the rejected channel fields', async () => {
		const harness = createHarness()
		await harness.repositories.sources.upsert({ id: 'source-a', appId: 'app', environment: 'prod', displayName: 'App', enabled: true })
		const fetch = handler(harness)
		const cases: Array<[unknown, string[]]> = [
			[{}, ['input.scope', 'input.type', 'input.target', 'input.enabled']],
			[{ scope: 'wrong', type: 'webhook', target: 'https://hooks.example.test', enabled: true }, ['input.scope']],
			[{ scope: 'new_issue', type: 'webhook', target: 'http://localhost', enabled: 1 }, ['input.enabled']],
		]
		for (const [body, paths] of cases) {
			const rpc = await fetch(rpcRequest('operations.internal', 'createAlertChannel', { sourceId: 'source-a', input: body }, OPERATOR_TOKEN))
			expect(await validationPaths(rpc)).toEqual(paths)
		}
		expect(await harness.repositories.alerts.listChannels('source-a')).toEqual([])
	})

	test('RPC validates before object authorization', async () => {
		const harness = createHarness()
		await harness.repositories.sources.upsert({ id: 'source-a', appId: 'app', environment: 'prod', displayName: 'App', enabled: true })
		const recorded = await harness.repositories.ingest.record({
			sourceId: 'source-a',
			fingerprint: 'failure',
			eventId: 'event-a',
			title: 'Failure',
			culprit: null,
			level: 'error',
			release: null,
			receivedAt: 1_000,
			blobKey: 'event-a',
		})
		let audits = 0
		const iam = createOperationsIam({
			IAM: {
				...sessionRpc('unused'),
				audit: async () => {
					audits++
				},
			},
			FABRIKA_IAM_ISSUER: issuer,
		})
		const fetch = handler(harness, iam)
		for (const sourceId of ['source-a', 'missing']) {
			const healthCheckFields = ['path', 'enabled', 'intervalMs', 'timeoutMs', 'expectedStatus', 'failureThreshold', 'recoveryThreshold', 'staleAfterMs']
				.map((field) => `input.${field}`)
			const cases: Array<[string, unknown, string[]]> = [
				['mutateIssue', { issueId: sourceId === 'missing' ? 'missing' : recorded.issue.id, mutation: {} }, ['mutation.kind']],
				['createHealthCheck', { sourceId, input: {} }, healthCheckFields],
				['updateHealthCheck', { sourceId, checkId: 'check-a', input: {} }, healthCheckFields],
				['updateSpikeAlert', { sourceId, input: {} }, ['input.threshold', 'input.enabled']],
				['updateAlertRule', { sourceId, kind: 'new_issue', input: {} }, ['input.enabled']],
				['createAlertChannel', { sourceId, input: {} }, ['input.scope', 'input.type', 'input.target', 'input.enabled']],
				['updateAlertChannel', { sourceId, channelId: 'channel-a', input: {} }, ['input.scope', 'input.type', 'input.enabled']],
			]
			for (const [method, input, paths] of cases) {
				expect(await validationPaths(await fetch(rpcRequest('operations.internal', method, input, VIEWER_TOKEN)))).toEqual(paths)
			}
		}
		const malformed = await fetch(
			new Request('https://operations.internal/api/rpc', {
				method: 'POST',
				headers: { 'content-type': 'application/json', [PROXY_TOKEN_HEADER]: VIEWER_TOKEN },
				body: '{',
			}),
		)
		expect(malformed.status).toBe(400)
		const body: unknown = await malformed.json()
		expect(body).toEqual({ error: { type: 'validation', message: 'Invalid JSON body' } })
		expect((await harness.repositories.issues.get('source-a', 'failure'))?.status).toBe('open')
		expect(await new SqliteHealthRepository(harness.db).listChecks('source-a')).toEqual([])
		expect(await harness.repositories.alerts.getConfig('source-a')).toBeNull()
		expect(await harness.repositories.alerts.listRules('source-a')).toEqual([])
		expect(await harness.repositories.alerts.listChannels('source-a')).toEqual([])
		expect(audits).toBe(0)
	})

	test('RPC strips untrusted health identity fields and preserves nullable mutations and omitted channel targets', async () => {
		const harness = createHarness()
		await harness.repositories.sources.upsert({ id: 'source-a', appId: 'app', environment: 'prod', displayName: 'App', enabled: true })
		const recorded = await harness.repositories.ingest.record({
			sourceId: 'source-a',
			fingerprint: 'failure',
			eventId: 'event-a',
			title: 'Failure',
			culprit: null,
			level: 'error',
			release: null,
			receivedAt: 1_000,
			blobKey: 'event-a',
		})
		const issueId = recorded.issue.id
		if (issueId === null) throw new Error('expected an issue id')
		const target = 'https://hooks.example.test/original'
		await harness.repositories.alerts.upsertChannel({
			id: 'channel-a',
			sourceId: 'source-a',
			scope: 'new_issue',
			type: 'webhook',
			target,
			enabled: true,
		})
		const fetch = handler(harness)
		const body = {
			path: '/health',
			enabled: true,
			intervalMs: 60_000,
			timeoutMs: 5_000,
			expectedStatus: 200,
			failureThreshold: 3,
			recoveryThreshold: 2,
			staleAfterMs: 180_000,
			id: 'spoofed',
			sourceId: 'foreign',
			publicOrigin: 'https://attacker.invalid',
		}
		const created = await fetch(
			rpcRequest('operations.internal', 'createHealthCheck', { sourceId: 'source-a', input: body }, OPERATOR_TOKEN),
		)
		expect(created.status).toBe(200)
		const checks = await new SqliteHealthRepository(harness.db).listChecks('source-a')
		expect(checks).toHaveLength(1)
		expect(checks[0]?.id).not.toBe('spoofed')
		expect(checks[0]).toMatchObject({
			source_id: 'source-a',
			path: '/health',
			enabled: 1,
			interval_ms: 60_000,
			timeout_ms: 5_000,
			expected_status: 200,
			failure_threshold: 3,
			recovery_threshold: 2,
			stale_after_ms: 180_000,
		})
		for (const mutation of [{ kind: 'assign', principalId: null }, { kind: 'resolve_in_release', releaseId: null }]) {
			const response = await fetch(
				rpcRequest('operations.internal', 'mutateIssue', { issueId, mutation }, OPERATOR_TOKEN),
			)
			expect(response.status).toBe(200)
		}
		const channel = { scope: 'regression', type: 'webhook', enabled: false, sourceId: 'foreign' }
		const updated = await fetch(
			rpcRequest('operations.internal', 'updateAlertChannel', { sourceId: 'source-a', channelId: 'channel-a', input: channel }, OPERATOR_TOKEN),
		)
		expect(updated.status).toBe(200)
		expect(await harness.repositories.alerts.listChannels('source-a')).toEqual([
			{ id: 'channel-a', source_id: 'source-a', scope: 'regression', type: 'webhook', target, enabled: 0 },
		])
		const invalidChannel = { ...channel, target: null }
		const refused = await fetch(
			rpcRequest(
				'operations.internal',
				'updateAlertChannel',
				{ sourceId: 'source-a', channelId: 'channel-a', input: invalidChannel },
				OPERATOR_TOKEN,
			),
		)
		expect(refused.status).toBe(400)
		expect((await harness.repositories.alerts.listChannels('source-a'))[0]?.target).toBe(target)
	})

	test('the operator is resolved from the proxy-injected token, verified locally', async () => {
		const fetch = handler()
		const response = await fetch(
			rpcRequest('operations:3000', 'sources', null, VIEWER_TOKEN),
		)

		expect(response.status).toBe(200)
	})

	test('a forged token in that header is refused — the app does not trust the proxy blindly', async () => {
		const fetch = handler()
		const response = await fetch(
			rpcRequest('operations:3000', 'sources', null, 'not.a.jwt'),
		)

		expect(response.status).toBe(401)
	})
})
