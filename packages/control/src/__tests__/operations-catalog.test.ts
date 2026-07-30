import { OPERATIONS_CATALOG_PROTOCOL_VERSION, type OperationsCatalogReconcileOutcome } from '@fabrika/operations-contract/catalog'
import type { DeployLocks, HttpService } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { projectOperationsCatalogChange, replayOperationsCatalog } from '../operations-catalog'
import { createHarness } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

const SYNC_KEY = 'catalog-sync-key-with-at-least-32-characters'

class AvailableLock implements DeployLocks {
	acquire(): Promise<boolean> {
		return Promise.resolve(true)
	}

	release(): Promise<void> {
		return Promise.resolve()
	}
}

interface CapturedCatalogRequest {
	authorization: string | null
	revision: number
	snapshotHash: string
	payload: unknown
}

class CatalogService implements HttpService {
	readonly requests: CapturedCatalogRequest[] = []
	acceptThenDrop = false
	private revision = 0
	private snapshotHash = ''

	async fetch(request: Request): Promise<Response> {
		const payload: unknown = await request.json()
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			throw new Error('bad test catalog payload')
		}
		const revision = Reflect.get(payload, 'revision')
		const snapshotHash = Reflect.get(payload, 'snapshotHash')
		if (typeof revision !== 'number' || typeof snapshotHash !== 'string') {
			throw new Error('bad test catalog payload')
		}
		this.requests.push({
			authorization: request.headers.get('authorization'),
			revision,
			snapshotHash,
			payload,
		})

		let outcome: OperationsCatalogReconcileOutcome
		if (revision < this.revision) {
			outcome = 'stale'
		} else if (revision === this.revision && snapshotHash === this.snapshotHash) {
			outcome = 'unchanged'
		} else {
			this.revision = revision
			this.snapshotHash = snapshotHash
			outcome = 'applied'
		}
		if (this.acceptThenDrop) {
			this.acceptThenDrop = false
			throw new Error('response lost')
		}
		return Response.json({
			protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
			revision: this.revision,
			outcome,
			created: 0,
			updated: 0,
			disabled: 0,
			reenabled: 0,
			unchanged: 0,
		})
	}
}

describe('Control Operations catalog projection', () => {
	test('projects only canonical registry fields and replays an accepted response loss idempotently', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod', {
			domain: 'app-a.example.test',
		}))
		const service = new CatalogService()
		service.acceptThenDrop = true
		const deps = {
			catalog: harness.repositories.operationsCatalog,
			locks: new AvailableLock(),
			service,
			syncKey: SYNC_KEY,
		}

		expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'failed', revision: 1 })
		const failed = await harness.repositories.operationsCatalog.getState()
		expect(failed).toMatchObject({
			desiredRevision: 1,
			appliedRevision: 0,
			attemptedRevision: 1,
			lastAttemptAt: 1_000,
			lastError: 'operations catalog request failed',
		})

		now = 2_000
		expect(await replayOperationsCatalog(deps)).toEqual({ outcome: 'unchanged', revision: 1 })
		expect(service.requests.map((request) => request.revision)).toEqual([1, 1])
		expect(service.requests[1]?.snapshotHash).toBe(service.requests[0]?.snapshotHash)
		expect(service.requests[0]?.authorization).toBe(`Bearer ${SYNC_KEY}`)
		expect(service.requests[0]?.payload).toEqual({
			protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
			revision: 1,
			snapshotHash: service.requests[0]?.snapshotHash,
			sources: [{
				coordinate: { appId: 'app-a', environment: 'prod' },
				displayName: 'app-a.example.test',
				publicOrigin: null,
			}],
		})
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({
			desiredRevision: 1,
			appliedRevision: 1,
			attemptedRevision: 1,
			lastSuccessAt: 2_000,
			lastError: null,
		})
	})

	test('advances revisions and represents deletion by omitting the source from the full snapshot', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const service = new CatalogService()
		const deps = {
			catalog: harness.repositories.operationsCatalog,
			locks: new AvailableLock(),
			service,
			syncKey: SYNC_KEY,
		}

		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		await harness.repositories.registry.deleteAppEnv('app-a', 'prod')
		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')

		expect(service.requests.map((request) => request.revision)).toEqual([1, 2])
		const deletedPayload = service.requests[1]?.payload
		expect(
			typeof deletedPayload === 'object' && deletedPayload !== null
				? Reflect.get(deletedPayload, 'sources')
				: undefined,
		).toEqual([])
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({
			desiredRevision: 2,
			appliedRevision: 2,
		})
	})
})
