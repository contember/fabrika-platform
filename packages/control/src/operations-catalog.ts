import {
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	type OperationsCatalogReconcileRequestV1,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV1,
} from '@fabrika/operations-contract/catalog'
import type { DeployLocks, HttpService } from '@fabrika/platform'
import type { OperationsCatalogRepository, OperationsCatalogSyncState } from './db'
import { uuidv7 } from './uuid'

const CATALOG_ENDPOINT = 'https://operations.internal/private/catalog/reconcile'
const CATALOG_LOCK_KEY = 'operations-catalog-projection'
const CATALOG_LOCK_TTL_MS = 5 * 60 * 1000
const CATALOG_REQUEST_TIMEOUT_MS = 15_000
const MIN_SYNC_KEY_LENGTH = 32
const MAX_COALESCED_PASSES = 20

export type OperationsCatalogSyncOutcome = 'disabled' | 'applied' | 'unchanged' | 'coalesced' | 'failed'

export interface OperationsCatalogSyncSummary {
	outcome: OperationsCatalogSyncOutcome
	revision: number | null
}

export interface OperationsCatalogSyncDeps {
	catalog: OperationsCatalogRepository
	locks: DeployLocks
	service?: HttpService
	syncKey?: string
}

/** A registry mutation always advances the desired revision before attempting delivery. */
export function projectOperationsCatalogChange(deps: OperationsCatalogSyncDeps): Promise<OperationsCatalogSyncSummary> {
	return runCatalogSync(deps, 'change')
}

/** Maintenance replays an existing failed revision, or creates one full-snapshot consistency pass. */
export function replayOperationsCatalog(deps: OperationsCatalogSyncDeps): Promise<OperationsCatalogSyncSummary> {
	return runCatalogSync(deps, 'maintenance')
}

async function runCatalogSync(
	deps: OperationsCatalogSyncDeps,
	mode: 'change' | 'maintenance',
): Promise<OperationsCatalogSyncSummary> {
	if (deps.service === undefined && deps.syncKey === undefined) {
		return { outcome: 'disabled', revision: null }
	}

	let requestedRevision: number | null = null
	try {
		requestedRevision = mode === 'change' ? await deps.catalog.markDirty() : await deps.catalog.ensurePending()
		if (deps.service === undefined || deps.syncKey === undefined || deps.syncKey.length < MIN_SYNC_KEY_LENGTH) {
			await deps.catalog.markFailed('operations catalog transport is not configured')
			return { outcome: 'failed', revision: requestedRevision }
		}

		const holder = uuidv7()
		if (!(await deps.locks.acquire(CATALOG_LOCK_KEY, holder, CATALOG_LOCK_TTL_MS))) {
			return { outcome: 'coalesced', revision: requestedRevision }
		}
		try {
			return await flushCatalog(deps.catalog, deps.service, deps.syncKey)
		} finally {
			try {
				await deps.locks.release(CATALOG_LOCK_KEY, holder)
			} catch {
				console.warn('operations catalog lock release failed')
			}
		}
	} catch (cause) {
		const message = cause instanceof CatalogSyncError ? cause.message : 'operations catalog sync failed'
		await recordCatalogFailure(deps.catalog, message)
		console.warn('operations catalog sync failed')
		return { outcome: 'failed', revision: requestedRevision }
	}
}

async function flushCatalog(
	catalog: OperationsCatalogRepository,
	service: HttpService,
	syncKey: string,
): Promise<OperationsCatalogSyncSummary> {
	let lastOutcome: OperationsCatalogSyncOutcome = 'unchanged'
	let lastRevision: number | null = null
	for (let pass = 0; pass < MAX_COALESCED_PASSES; pass++) {
		const state = await catalog.getState()
		if (state.desiredRevision <= state.appliedRevision) {
			return { outcome: lastOutcome, revision: lastRevision ?? state.appliedRevision }
		}

		const snapshot = await catalog.snapshot()
		const sources = snapshot.sources.map(projectSource)
		const snapshotHash = await operationsCatalogSnapshotHash(sources)
		const request: OperationsCatalogReconcileRequestV1 = {
			protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
			revision: snapshot.revision,
			snapshotHash,
			sources,
		}
		await catalog.markAttempt(snapshot.revision, snapshotHash)
		const response = await sendCatalog(service, syncKey, request)
		lastRevision = response.revision
		if (response.outcome === 'stale') {
			if (response.revision <= snapshot.revision) {
				throw new CatalogSyncError('operations catalog returned an invalid stale revision')
			}
			await catalog.advancePast(response.revision)
			lastOutcome = 'coalesced'
			continue
		}
		if (response.revision !== snapshot.revision) {
			throw new CatalogSyncError('operations catalog returned a mismatched revision')
		}
		await catalog.markApplied(snapshot.revision, snapshotHash)
		lastOutcome = response.outcome
	}
	return { outcome: 'coalesced', revision: lastRevision }
}

function projectSource(row: { app_id: string; env: string; domain: string | null }): OperationsCatalogSourceV1 {
	return {
		coordinate: {
			appId: row.app_id,
			environment: row.env,
		},
		displayName: row.domain ?? `${row.app_id} / ${row.env}`,
		// Control has no canonical public-origin field. A deploy domain is not necessarily an origin.
		publicOrigin: null,
	}
}

async function sendCatalog(
	service: HttpService,
	syncKey: string,
	payload: OperationsCatalogReconcileRequestV1,
): Promise<{ revision: number; outcome: 'applied' | 'unchanged' | 'stale' }> {
	let response: Response
	try {
		response = await service.fetch(
			new Request(CATALOG_ENDPOINT, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${syncKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS),
			}),
		)
	} catch {
		throw new CatalogSyncError('operations catalog request failed')
	}
	if (!response.ok) {
		throw new CatalogSyncError(`operations catalog returned status ${response.status}`)
	}
	let value: unknown
	try {
		value = await response.json()
	} catch {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	const protocolVersion = Reflect.get(value, 'protocolVersion')
	const revision = Reflect.get(value, 'revision')
	const outcome = Reflect.get(value, 'outcome')
	if (
		protocolVersion !== OPERATIONS_CATALOG_PROTOCOL_VERSION
		|| typeof revision !== 'number'
		|| !Number.isSafeInteger(revision)
		|| revision < 1
		|| (outcome !== 'applied' && outcome !== 'unchanged' && outcome !== 'stale')
	) {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	return { revision, outcome }
}

async function recordCatalogFailure(catalog: OperationsCatalogRepository, message: string): Promise<void> {
	try {
		await catalog.markFailed(message)
	} catch {
		console.warn('operations catalog failure status could not be stored')
	}
}

export function operationsCatalogDrift(state: OperationsCatalogSyncState): number {
	return Math.max(0, state.desiredRevision - state.appliedRevision)
}

class CatalogSyncError extends Error {}
