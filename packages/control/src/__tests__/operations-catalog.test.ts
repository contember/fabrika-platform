import { OPERATIONS_CATALOG_PROTOCOL_VERSION, type OperationsCatalogReconcileOutcome } from '@fabrika/operations-contract/catalog'
import type { DeployLocks, HttpService } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { projectOperationsCatalogChange, replayOperationsCatalog } from '../operations-catalog'
import { createHarness } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

const SYNC_KEY = 'catalog-sync-key-with-at-least-32-characters'

class AvailableLock implements DeployLocks {
	/** Set to model another holder mid-flush, the only way a caller observes `coalesced`. */
	held = false

	acquire(): Promise<boolean> {
		return Promise.resolve(!this.held)
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
	mismatchCredential = false
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
		const ingest = catalogIngest(payload, this.mismatchCredential)
		return Response.json({
			protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
			revision: this.revision,
			outcome,
			created: 0,
			updated: 0,
			disabled: 0,
			reenabled: 0,
			unchanged: 0,
			ingest,
		})
	}
}

function catalogIngest(payload: object, mismatchCredential: boolean): unknown[] {
	const sources = Reflect.get(payload, 'sources')
	if (!Array.isArray(sources)) throw new Error('bad test catalog sources')
	return sources.map((source) => {
		const coordinate = Reflect.get(source, 'coordinate')
		const credential = Reflect.get(source, 'ingestCredential')
		if (
			typeof coordinate !== 'object'
			|| coordinate === null
			|| typeof credential !== 'object'
			|| credential === null
		) {
			throw new Error('bad test catalog source')
		}
		return {
			coordinate: {
				appId: Reflect.get(coordinate, 'appId'),
				environment: Reflect.get(coordinate, 'environment'),
				serviceKey: Reflect.get(coordinate, 'serviceKey') ?? 'default',
			},
			credentialId: mismatchCredential ? '0198a000-0000-7000-8000-000000000099' : Reflect.get(credential, 'id'),
			ingestProjectId: '100000000000000001',
		}
	})
}

describe('Control Operations catalog projection', () => {
	test('projects only canonical registry fields and replays an accepted response loss idempotently', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod', {
			domain: 'app-a.example.test',
			publicOrigin: 'https://public.example.test',
		}))
		const service = new CatalogService()
		service.acceptThenDrop = true
		const deps = {
			catalog: harness.repositories.operationsCatalog,
			locks: new AvailableLock(),
			service,
			syncKey: SYNC_KEY,
			operationsOrigin: 'https://errors.example.test',
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
		const pending = await harness.repositories.operationsCatalog.getIngestConfig('app-a', 'prod')
		expect(pending).toMatchObject({ dsn: null, ingest_project_id: null, activated_revision: null })

		now = 2_000
		expect(await replayOperationsCatalog(deps)).toEqual({ outcome: 'unchanged', revision: 1 })
		expect(service.requests.map((request) => request.revision)).toEqual([1, 1])
		expect(service.requests[1]?.snapshotHash).toBe(service.requests[0]?.snapshotHash)
		expect(service.requests[0]?.authorization).toBe(`Bearer ${SYNC_KEY}`)
		expect(requestPublicOrigin(service.requests[0]?.payload)).toBe('https://public.example.test')
		const firstCredential = requestCredential(service.requests[0]?.payload)
		expect(requestCredential(service.requests[1]?.payload)).toEqual(firstCredential)
		expect(firstCredential.publicKey).toMatch(/^[0-9a-f]{32}$/)
		expect(firstCredential.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({
			desiredRevision: 1,
			appliedRevision: 1,
			attemptedRevision: 1,
			lastSuccessAt: 2_000,
			lastError: null,
		})
		expect(await harness.repositories.operationsCatalog.getIngestConfig('app-a', 'prod')).toMatchObject({
			credential_id: firstCredential.id,
			public_key: firstCredential.publicKey,
			ingest_project_id: '100000000000000001',
			dsn: `https://${firstCredential.publicKey}@errors.example.test/100000000000000001`,
			activated_revision: 1,
		})
		expect(await harness.repositories.registry.listAppVars('app-a')).toEqual([])
	})

	test('rejects a mismatched ingest response and leaves the durable credential pending', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const service = new CatalogService()
		service.mismatchCredential = true
		const result = await projectOperationsCatalogChange({
			catalog: harness.repositories.operationsCatalog,
			locks: new AvailableLock(),
			service,
			syncKey: SYNC_KEY,
			operationsOrigin: 'https://errors.example.test',
		})
		expect(result).toEqual({ outcome: 'failed', revision: 1 })
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({
			appliedRevision: 0,
			lastError: 'operations catalog returned a mismatched ingest configuration',
		})
		expect(await harness.repositories.operationsCatalog.getIngestConfig('app-a', 'prod')).toMatchObject({
			dsn: null,
			ingest_project_id: null,
			activated_revision: null,
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
			operationsOrigin: 'https://errors.example.test',
		}

		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		expect(requestPublicOrigin(service.requests[0]?.payload)).toBeNull()
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
		expect(await harness.repositories.operationsCatalog.getIngestConfig('app-a', 'prod')).toBeNull()
	})

	test('logs one line per sync naming the outcome and the revision, and no secret', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const locks = new AvailableLock()
		const service = new CatalogService()
		const deps = {
			catalog: harness.repositories.operationsCatalog,
			locks,
			service,
			syncKey: SYNC_KEY,
			operationsOrigin: 'https://errors.example.test',
		}
		const lines: string[] = []
		const originalInfo = console.info
		const originalWarn = console.warn
		console.info = (...values) => lines.push(values.map(String).join(' '))
		console.warn = (...values) => lines.push(values.map(String).join(' '))
		try {
			await projectOperationsCatalogChange(deps)
			service.acceptThenDrop = true
			await replayOperationsCatalog(deps)
			await replayOperationsCatalog(deps)
			locks.held = true
			await projectOperationsCatalogChange(deps)
			locks.held = false
			await projectOperationsCatalogChange({ ...deps, operationsOrigin: undefined })
		} finally {
			console.info = originalInfo
			console.warn = originalWarn
		}

		expect(lines).toEqual([
			'operations catalog sync: applied revision 1',
			'operations catalog sync: failed revision 2 (operations catalog request failed)',
			'operations catalog sync: unchanged revision 2',
			'operations catalog sync: coalesced revision 3',
			'operations catalog sync: failed revision 4 (operations public origin is not configured)',
		])
		expect(lines.join('\n')).not.toContain(SYNC_KEY)
		expect(lines.join('\n')).not.toContain('errors.example.test')
	})

	test('an unwired composition is silent and advances no revision', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const lines: string[] = []
		const originalInfo = console.info
		const originalWarn = console.warn
		console.info = (...values) => lines.push(values.map(String).join(' '))
		console.warn = (...values) => lines.push(values.map(String).join(' '))
		try {
			expect(
				await projectOperationsCatalogChange({
					catalog: harness.repositories.operationsCatalog,
					locks: new AvailableLock(),
				}),
			).toEqual({ outcome: 'disabled', revision: null })
		} finally {
			console.info = originalInfo
			console.warn = originalWarn
		}
		expect(lines).toEqual([])
		// Desired stays 0, which is what a deploy reads as "Operations is not wired" rather than "late".
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({ desiredRevision: 0, appliedRevision: 0 })
	})

	test('fails closed before delivery when a persisted public origin is invalid', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod', {
			publicOrigin: 'https://example.test/path',
		}))
		const service = new CatalogService()

		expect(
			await projectOperationsCatalogChange({
				catalog: harness.repositories.operationsCatalog,
				locks: new AvailableLock(),
				service,
				syncKey: SYNC_KEY,
				operationsOrigin: 'https://errors.example.test',
			}),
		).toEqual({ outcome: 'failed', revision: 1 })
		expect(service.requests).toHaveLength(0)
		expect(await harness.repositories.operationsCatalog.getState()).toMatchObject({
			appliedRevision: 0,
			lastError: 'operations catalog source public origin is invalid',
		})
	})
})

function requestCredential(payload: unknown): { id: string; publicKey: string } {
	if (typeof payload !== 'object' || payload === null) throw new Error('missing catalog payload')
	const sources = Reflect.get(payload, 'sources')
	if (!Array.isArray(sources) || sources.length !== 1) throw new Error('missing catalog source')
	const credential = Reflect.get(sources[0], 'ingestCredential')
	if (typeof credential !== 'object' || credential === null) throw new Error('missing ingest credential')
	const id = Reflect.get(credential, 'id')
	const publicKey = Reflect.get(credential, 'publicKey')
	if (typeof id !== 'string' || typeof publicKey !== 'string') throw new Error('invalid ingest credential')
	return { id, publicKey }
}

function requestPublicOrigin(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) throw new Error('missing catalog payload')
	const sources = Reflect.get(payload, 'sources')
	if (!Array.isArray(sources) || sources.length !== 1) throw new Error('missing catalog source')
	const publicOrigin = Reflect.get(sources[0], 'publicOrigin')
	if (publicOrigin !== null && typeof publicOrigin !== 'string') throw new Error('invalid public origin')
	return publicOrigin
}
