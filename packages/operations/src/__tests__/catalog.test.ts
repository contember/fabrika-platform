import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	type OperationsCatalogReconcileRequestV1,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV1,
} from '@fabrika/operations-contract/catalog'
import { describe, expect, test } from 'bun:test'
import { handleOperationsCatalogRequest, parseCatalogRequest, reconcileOperationsCatalog } from '../catalog.js'
import { createHarness } from './helpers/sqlite.js'

const source = (displayName = 'App A production'): OperationsCatalogSourceV1 => ({
	coordinate: { appId: 'app-a', environment: 'production' },
	displayName,
})

async function snapshot(revision: number, sources: OperationsCatalogSourceV1[]): Promise<OperationsCatalogReconcileRequestV1> {
	return {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision,
		snapshotHash: await operationsCatalogSnapshotHash(sources),
		sources,
	}
}

describe('Operations catalog reconciliation', () => {
	test('defaults the service key and preserves source identity across rename, tombstone, and re-enable', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		const created = await reconcileOperationsCatalog(harness.repositories, await snapshot(1, [source()]))
		expect(created).toMatchObject({ outcome: 'applied', created: 1 })
		const first = await harness.repositories.catalog.listControlSources()
		expect(first).toHaveLength(1)
		expect(first[0]?.service_key).toBe(DEFAULT_OPERATIONS_SERVICE_KEY)
		expect(first[0]?.public_origin).toBeNull()
		const sourceId = first[0]?.id

		now = 2_000
		const renamed = await reconcileOperationsCatalog(harness.repositories, await snapshot(2, [source('Renamed display')]))
		expect(renamed).toMatchObject({ outcome: 'applied', updated: 1 })
		expect((await harness.repositories.catalog.listControlSources())[0]).toMatchObject({
			id: sourceId,
			display_name: 'Renamed display',
			enabled: 1,
			disabled_at: null,
		})

		now = 3_000
		const disabled = await reconcileOperationsCatalog(harness.repositories, await snapshot(3, []))
		expect(disabled).toMatchObject({ outcome: 'applied', disabled: 1 })
		expect((await harness.repositories.catalog.listControlSources())[0]).toMatchObject({
			id: sourceId,
			enabled: 0,
			disabled_at: 3_000,
		})

		now = 4_000
		const reenabled = await reconcileOperationsCatalog(harness.repositories, await snapshot(4, [source('Back')]))
		expect(reenabled).toMatchObject({ outcome: 'applied', reenabled: 1 })
		expect((await harness.repositories.catalog.listControlSources())[0]).toMatchObject({
			id: sourceId,
			display_name: 'Back',
			enabled: 1,
			disabled_at: null,
		})
	})

	test('reports public origin changes as updates', async () => {
		const harness = createHarness()
		const initial = source()
		expect((await reconcileOperationsCatalog(harness.repositories, await snapshot(1, [initial]))).created).toBe(1)
		const withOrigin: OperationsCatalogSourceV1 = { ...initial, publicOrigin: 'https://app.example.test' }
		expect(await reconcileOperationsCatalog(harness.repositories, await snapshot(2, [withOrigin]))).toMatchObject({
			outcome: 'applied',
			updated: 1,
			unchanged: 0,
		})
		expect((await harness.repositories.catalog.listControlSources())[0]?.public_origin).toBe('https://app.example.test')
	})

	test('replays equal content, rejects revision hash reuse, and ignores stale snapshots', async () => {
		const harness = createHarness()
		const first = await snapshot(2, [source()])
		expect((await reconcileOperationsCatalog(harness.repositories, first)).outcome).toBe('applied')
		expect((await reconcileOperationsCatalog(harness.repositories, first)).outcome).toBe('unchanged')
		expect((await reconcileOperationsCatalog(harness.repositories, await snapshot(1, []))).outcome).toBe('stale')
		await expect(reconcileOperationsCatalog(harness.repositories, await snapshot(2, []))).rejects.toThrow(
			'catalog revision was reused with different content',
		)
	})

	test('private handler authenticates and never accepts duplicate coordinates', async () => {
		const harness = createHarness()
		const key = 'k'.repeat(32)
		const valid = await snapshot(1, [source()])
		const unauthorized = await handleOperationsCatalogRequest(
			new Request('https://operations.internal/private/catalog/reconcile', {
				method: 'POST',
				body: JSON.stringify(valid),
			}),
			{ repositories: harness.repositories, syncKey: key },
		)
		expect(unauthorized.status).toBe(401)

		const accepted = await handleOperationsCatalogRequest(
			new Request('https://operations.internal/private/catalog/reconcile', {
				method: 'POST',
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify(valid),
			}),
			{ repositories: harness.repositories, syncKey: key },
		)
		expect(accepted.status).toBe(200)

		const duplicate = await snapshot(2, [source(), source()])
		expect(() => parseCatalogRequest(duplicate)).toThrow('duplicate source coordinate')
	})
})
