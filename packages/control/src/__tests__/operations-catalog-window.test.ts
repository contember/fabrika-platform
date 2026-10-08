// The reproduction behind backlog 84: an application registered while a catalog flush is in progress
// deployed without its Operations-managed environment. Each test below walks ONE candidate cause and
// records whether the real catalog code can exhibit it, with a fake Operations HTTP service and the
// real `SqlDeployLocks` lease the production composition uses.

import type { OperationsCatalogReconcileOutcome } from '@fabrika/operations-contract/catalog'
import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { type AppliedOperationsIngestConfig, OperationsCatalogRepository, type OperationsCatalogSyncState } from '../db'
import { CATALOG_LEASE_KEY, LEASE_TTL_MS } from '../lease'
import {
	closeCatalogProjection,
	projectOperationsCatalogChange,
	releaseHeldCatalogLeases,
	reopenCatalogProjection,
	replayOperationsCatalog,
} from '../operations-catalog'
import { createHarness, type Harness } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

const SYNC_KEY = 'catalog-sync-key-with-at-least-32-characters'
const ORIGIN = 'https://errors.example.test'

/** A fake Operations that answers a full, correct reconcile — and can be paused mid-request. */
class CatalogService {
	gate: (() => Promise<void>) | null = null
	calls = 0
	omitSource: string | null = null
	private revision = 0
	private snapshotHash = ''
	readonly accepted: string[][] = []

	async fetch(request: Request): Promise<Response> {
		this.calls++
		const payload: unknown = await request.json()
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('bad test catalog payload')
		const revision = Reflect.get(payload, 'revision')
		const snapshotHash = Reflect.get(payload, 'snapshotHash')
		const sources = Reflect.get(payload, 'sources')
		if (typeof revision !== 'number' || typeof snapshotHash !== 'string' || !Array.isArray(sources)) {
			throw new Error('bad test catalog payload')
		}
		const gate = this.gate
		if (gate !== null) {
			this.gate = null
			await gate()
		}
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
		this.accepted.push(sources.map((source) => sourceAppId(source)))
		return Response.json({
			revision: this.revision,
			outcome,
			ingest: sources.filter((source) => sourceAppId(source) !== this.omitSource).map((source) => ingestFor(source)),
		})
	}
}

function sourceAppId(source: unknown): string {
	if (typeof source !== 'object' || source === null) throw new Error('bad test catalog source')
	const coordinate = Reflect.get(source, 'coordinate')
	if (typeof coordinate !== 'object' || coordinate === null) throw new Error('bad test catalog source')
	const appId = Reflect.get(coordinate, 'appId')
	if (typeof appId !== 'string') throw new Error('bad test catalog source')
	return appId
}

function ingestFor(source: unknown): unknown {
	if (typeof source !== 'object' || source === null) throw new Error('bad test catalog source')
	const coordinate = Reflect.get(source, 'coordinate')
	const credential = Reflect.get(source, 'ingestCredential')
	if (typeof coordinate !== 'object' || coordinate === null || typeof credential !== 'object' || credential === null) {
		throw new Error('bad test catalog source')
	}
	return {
		coordinate: {
			appId: Reflect.get(coordinate, 'appId'),
			environment: Reflect.get(coordinate, 'environment'),
			serviceKey: Reflect.get(coordinate, 'serviceKey') ?? 'default',
		},
		credentialId: Reflect.get(credential, 'id'),
		ingestProjectId: '100000000000000001',
	}
}

/** A catalog repository that lets a test run something in the window a flush leaves open. */
class HookedCatalog extends OperationsCatalogRepository {
	whenIdle: (() => Promise<void>) | null = null
	/** Keep the idle hook armed, to model a registry that never stops changing. */
	repeatWhenIdle = false
	failNextApply = false

	/** Run the hook AFTER the holder's last read and answer with what that read saw, not with the hook's effect. */
	override async getState(): Promise<OperationsCatalogSyncState> {
		const state = await super.getState()
		const hook = this.whenIdle
		if (hook !== null && state.desiredRevision <= state.appliedRevision) {
			if (!this.repeatWhenIdle) this.whenIdle = null
			await hook()
		}
		return state
	}

	override async markApplied(revision: number, snapshotHash: string, configs: readonly AppliedOperationsIngestConfig[]): Promise<void> {
		if (this.failNextApply) {
			this.failNextApply = false
			throw new Error('local catalog write lost')
		}
		await super.markApplied(revision, snapshotHash, configs)
	}
}

interface CatalogFixture {
	harness: Harness
	catalog: HookedCatalog
	service: CatalogService
	locks: SqlDeployLocks
	advance: (ms: number) => void
	deps: {
		catalog: HookedCatalog
		locks: SqlDeployLocks
		service: CatalogService
		syncKey: string
		operationsOrigin: string
	}
}

function fixture(): CatalogFixture {
	const harness = createHarness()
	const sql: SqlDatabase = harness.d1
	let clock = 1_700_000_000_000
	const locks = new SqlDeployLocks(sql, { now: () => clock })
	const catalog = new HookedCatalog(sql)
	const service = new CatalogService()
	return {
		harness,
		catalog,
		service,
		locks,
		advance: (ms) => {
			clock += ms
		},
		deps: { catalog, locks, service, syncKey: SYNC_KEY, operationsOrigin: ORIGIN },
	}
}

async function register(harness: Harness, appId: string): Promise<void> {
	await harness.repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
	await harness.repositories.registry.upsertAppEnv(providerEnvironment(appId, 'prod'))
}

async function activeDsn(harness: Harness, appId: string): Promise<string | null> {
	const config = await harness.repositories.operationsCatalog.getActiveIngestConfig(appId, 'prod')
	return config?.dsn ?? null
}

describe('Operations catalog projection window (backlog 84)', () => {
	test('candidate 1: a lock left behind by a dead holder drops every change until one lease TTL', async () => {
		const { harness, deps, locks, advance } = fixture()
		await register(harness, 'app-a')
		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')

		// A container that died mid-flush leaves the row behind; nothing releases it.
		expect(await locks.acquire(CATALOG_LEASE_KEY, 'dead-holder', LEASE_TTL_MS)).toBe(true)

		await register(harness, 'app-b')
		expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'coalesced', revision: 2 })
		expect(await activeDsn(harness, 'app-b')).toBeNull()
		// The maintenance replay is refused by the same lease until it expires.
		advance(LEASE_TTL_MS - 1)
		expect((await replayOperationsCatalog(deps)).outcome).toBe('coalesced')
		expect(await activeDsn(harness, 'app-b')).toBeNull()

		advance(2)
		expect((await replayOperationsCatalog(deps)).outcome).toBe('applied')
		expect(await activeDsn(harness, 'app-b')).not.toBeNull()
	})

	test('shutdown: a closing process lets a healthy flush finish and release, and takes no new lease', async () => {
		const { harness, deps, locks, service } = fixture()
		await register(harness, 'app-a')
		let resume = (): void => {}
		service.gate = () =>
			new Promise<void>((resolve) => {
				resume = resolve
			})
		try {
			const flush = projectOperationsCatalogChange(deps)
			while (service.calls === 0) await Bun.sleep(1)
			closeCatalogProjection()
			resume()
			expect(await flush).toEqual({ outcome: 'applied', revision: 1 })
			expect(await activeDsn(harness, 'app-a')).not.toBeNull()

			await register(harness, 'app-b')
			expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'coalesced', revision: 2 })
			expect(service.calls).toBe(1)
			// The healthy flush released its own lease, and the closing process took no new one.
			expect(await locks.acquire(CATALOG_LEASE_KEY, 'next-process', LEASE_TTL_MS)).toBe(true)
		} finally {
			resume()
			reopenCatalogProjection()
		}
	})

	test('shutdown: a flush still running is interrupted and its lease released without waiting out the TTL', async () => {
		const { harness, deps, locks, service } = fixture()
		await register(harness, 'app-a')
		let resume = (): void => {}
		service.gate = () =>
			new Promise<void>((resolve) => {
				resume = resolve
			})
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...values) => warnings.push(values.map(String).join(' '))
		let interrupted: Awaited<ReturnType<typeof projectOperationsCatalogChange>>
		try {
			const flush = projectOperationsCatalogChange(deps)
			while (service.calls === 0) await Bun.sleep(1)
			closeCatalogProjection()
			// The flush is inside its request and holds the lease: nobody else may take it.
			expect(await locks.acquire(CATALOG_LEASE_KEY, 'other-process', LEASE_TTL_MS)).toBe(false)

			await releaseHeldCatalogLeases()
			expect(await locks.acquire(CATALOG_LEASE_KEY, 'other-process', LEASE_TTL_MS)).toBe(true)
			await locks.release(CATALOG_LEASE_KEY, 'other-process')
			// The transport ignores the abort; the answer that arrives later is not written.
			resume()
			interrupted = await flush
		} finally {
			console.warn = originalWarn
			resume()
			reopenCatalogProjection()
		}
		expect(interrupted).toEqual({ outcome: 'failed', revision: 1 })
		expect(warnings).toEqual(['operations catalog sync interrupted by shutdown', 'operations catalog sync: failed revision 1'])
		expect(await activeDsn(harness, 'app-a')).toBeNull()

		// No clock advance: the replacing process takes the lease at once. Operations accepted the
		// abandoned request after all, so the replay's own pass is what records the configuration.
		expect(await replayOperationsCatalog(deps)).toEqual({ outcome: 'unchanged', revision: 1 })
		expect(await activeDsn(harness, 'app-a')).not.toBeNull()
	})

	test('candidate 1: a change coalesced against a LIVE flush is delivered by the holder itself', async () => {
		const { harness, deps, service } = fixture()
		await register(harness, 'app-a')
		const concurrent: string[] = []
		service.gate = async () => {
			await register(harness, 'app-b')
			concurrent.push((await projectOperationsCatalogChange(deps)).outcome)
		}

		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		expect(concurrent).toEqual(['coalesced'])
		// The holder's loop re-reads `desired` after every pass, so app-b rides the second pass.
		expect(service.accepted).toEqual([['app-a'], ['app-a', 'app-b']])
		expect(await activeDsn(harness, 'app-b')).not.toBeNull()
	})

	test('candidate 1: a change coalesced during the holder RELEASE is still delivered', async () => {
		const { harness, deps, catalog, service } = fixture()
		await register(harness, 'app-a')
		const concurrent: string[] = []
		// The one window the holder's loop cannot see: `desired` advances after its last read, while it
		// still holds the lease. Before the handoff pass this left app-b to the 5-minute replay.
		catalog.whenIdle = async () => {
			await register(harness, 'app-b')
			concurrent.push((await projectOperationsCatalogChange(deps)).outcome)
		}

		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		expect(concurrent).toEqual(['coalesced'])
		expect(service.accepted).toEqual([['app-a'], ['app-a', 'app-b']])
		expect(await activeDsn(harness, 'app-b')).not.toBeNull()
	})

	test('the handoff passes are bounded and leave a still-dirty catalog to the maintenance replay', async () => {
		const { harness, deps, catalog, service } = fixture()
		await register(harness, 'app-1')
		let next = 2
		catalog.repeatWhenIdle = true
		catalog.whenIdle = async () => {
			await register(harness, `app-${next++}`)
			await projectOperationsCatalogChange(deps)
		}

		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		// One flush plus at most two handoff passes: a registry that never settles cannot hold the lease.
		expect(service.accepted).toHaveLength(3)
		const state = await harness.repositories.operationsCatalog.getState()
		expect(state.desiredRevision).toBeGreaterThan(state.appliedRevision)
	})

	test('candidate 2: a reconcile that applies remotely and fails locally is loud and heals on the next sync', async () => {
		const { harness, deps, catalog, service } = fixture()
		await register(harness, 'app-a')
		catalog.failNextApply = true
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...values) => warnings.push(values.map(String).join(' '))
		try {
			expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'failed', revision: 1 })
		} finally {
			console.warn = originalWarn
		}
		expect(service.accepted).toEqual([['app-a']])
		expect(await activeDsn(harness, 'app-a')).toBeNull()
		expect(warnings).toEqual(['operations catalog sync: failed revision 1'])
		expect((await harness.repositories.operationsCatalog.getState()).lastError).toBe('operations catalog sync failed')

		expect((await replayOperationsCatalog(deps)).outcome).toBe('unchanged')
		expect(await activeDsn(harness, 'app-a')).not.toBeNull()
	})

	test('candidate 3: a response that omits the new source fails loudly instead of skipping it', async () => {
		const { harness, deps, service } = fixture()
		await register(harness, 'app-a')
		expect((await projectOperationsCatalogChange(deps)).outcome).toBe('applied')
		await register(harness, 'app-b')
		service.omitSource = 'app-b'
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...values) => warnings.push(values.map(String).join(' '))
		try {
			expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'failed', revision: 2 })
		} finally {
			console.warn = originalWarn
		}
		expect(warnings).toEqual([
			'operations catalog sync: failed revision 2 (operations catalog returned an incomplete ingest configuration)',
		])
		expect(await activeDsn(harness, 'app-b')).toBeNull()
		expect((await harness.repositories.operationsCatalog.getState()).lastError).toBe(
			'operations catalog returned an incomplete ingest configuration',
		)
	})
})
