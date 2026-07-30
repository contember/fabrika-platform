import {
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
} from '@fabrika/operations-contract/catalog'
import { OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract/releases'
import { describe, expect, test } from 'bun:test'
import { createOperationsIam } from '../auth.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { createOperationsFetchHandler } from '../http.js'
import { createHarness } from './helpers/sqlite.js'

const publicHost = 'errors.example.test'
const syncKey = 'catalog-sync-key-with-at-least-32-characters'

const handler = () => {
	const harness = createHarness()
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
		iam: createOperationsIam({ DEV: 'true' }),
	})
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
		for (const path of ['/healthz', '/private/catalog/reconcile', '/api/issues']) {
			const response = await fetch(new Request(`https://${publicHost}${path}`, { method: path.includes('catalog') ? 'POST' : 'GET' }))
			expect(response.status).toBe(404)
		}
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

		const response = await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')
		expect(response.status).toBe(200)
	})

	test('the private operator API enforces scoped IAM permissions while the public hostname stays closed', async () => {
		const fetch = handler()
		expect((await reconcileSource(fetch, '0198a000-0000-7000-8000-000000000001')).status).toBe(200)
		const sourcesResponse = await fetch(new Request('https://operations.internal/api/sources?__as=viewer@vozka.test'))
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
		const createCheck = (persona: string) =>
			fetch(
				new Request(`https://operations.internal/api/sources/${sourceId}/health-checks?__as=${persona}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
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
		expect((await createCheck('viewer@vozka.test')).status).toBe(404)
		expect((await createCheck('operator@vozka.test')).status).toBe(201)
		expect((await fetch(new Request(`https://${publicHost}/api/sources`))).status).toBe(404)
	})
})
