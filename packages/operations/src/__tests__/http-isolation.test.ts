import {
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
} from '@fabrika/operations-contract/catalog'
import { OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract/releases'
import { describe, expect, test } from 'bun:test'
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
	})
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

		const sources: OperationsCatalogSourceV2[] = [{
			coordinate: { appId: 'app', environment: 'prod' },
			displayName: 'App production',
			ingestCredential: {
				id: '0198a000-0000-7000-8000-000000000001',
				publicKey: '0123456789abcdef0123456789abcdef',
			},
		}]
		const response = await fetch(
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
		expect(response.status).toBe(200)
	})
})
