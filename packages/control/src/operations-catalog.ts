import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	type OperationsCatalogReconcileRequestV2,
	type OperationsCatalogReconcileResponseV2,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
} from '@fabrika/operations-contract/catalog'
import { buildOperationsDsn } from '@fabrika/operations-contract/ingest'
import type { DeployLocks, HttpService } from '@fabrika/platform'
import type { OperationsCatalogRepository, OperationsCatalogSyncState } from './db'
import { canonicalPublicOrigin, PublicOriginValidationError } from './public-origin'
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
	operationsOrigin?: string
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
		if (deps.operationsOrigin === undefined || deps.operationsOrigin.trim() === '') {
			await deps.catalog.markFailed('operations public origin is not configured')
			return { outcome: 'failed', revision: requestedRevision }
		}

		const holder = uuidv7()
		if (!(await deps.locks.acquire(CATALOG_LOCK_KEY, holder, CATALOG_LOCK_TTL_MS))) {
			return { outcome: 'coalesced', revision: requestedRevision }
		}
		try {
			return await flushCatalog(deps.catalog, deps.service, deps.syncKey, deps.operationsOrigin)
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
	operationsOrigin: string,
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
		const request: OperationsCatalogReconcileRequestV2 = {
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
		const configs = response.ingest.map((item) => {
			const source = sources.find((candidate) =>
				candidate.coordinate.appId === item.coordinate.appId
				&& candidate.coordinate.environment === item.coordinate.environment
				&& (candidate.coordinate.serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY) === item.coordinate.serviceKey
			)
			if (source === undefined) throw new CatalogSyncError('operations catalog returned an unknown ingest source')
			return {
				appId: item.coordinate.appId,
				environment: item.coordinate.environment,
				serviceKey: item.coordinate.serviceKey,
				credentialId: item.credentialId,
				ingestProjectId: item.ingestProjectId,
				dsn: buildOperationsDsn(operationsOrigin, source.ingestCredential.publicKey, item.ingestProjectId),
			}
		})
		await catalog.markApplied(snapshot.revision, snapshotHash, configs)
		lastOutcome = response.outcome
	}
	return { outcome: 'coalesced', revision: lastRevision }
}

function projectSource(row: {
	app_id: string
	env: string
	domain: string | null
	public_origin: string | null
	service_key: string
	credential_id: string
	public_key: string
}): OperationsCatalogSourceV2 {
	return {
		coordinate: {
			appId: row.app_id,
			environment: row.env,
			...(row.service_key === DEFAULT_OPERATIONS_SERVICE_KEY ? {} : { serviceKey: row.service_key }),
		},
		displayName: row.domain ?? `${row.app_id} / ${row.env}`,
		publicOrigin: catalogPublicOrigin(row.public_origin),
		ingestCredential: {
			id: row.credential_id,
			publicKey: row.public_key,
		},
	}
}

function catalogPublicOrigin(value: string | null): string | null {
	if (value === null) return null
	try {
		return canonicalPublicOrigin(value)
	} catch (cause) {
		if (cause instanceof PublicOriginValidationError) {
			throw new CatalogSyncError('operations catalog source public origin is invalid')
		}
		throw cause
	}
}

async function sendCatalog(
	service: HttpService,
	syncKey: string,
	payload: OperationsCatalogReconcileRequestV2,
): Promise<OperationsCatalogReconcileResponseV2> {
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
	const ingest = Reflect.get(value, 'ingest')
	if (
		protocolVersion !== OPERATIONS_CATALOG_PROTOCOL_VERSION
		|| typeof revision !== 'number'
		|| !Number.isSafeInteger(revision)
		|| revision < 1
		|| (outcome !== 'applied' && outcome !== 'unchanged' && outcome !== 'stale')
		|| !Array.isArray(ingest)
	) {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	const parsedIngest = ingest.map(parseIngestResult)
	if (outcome !== 'stale') assertCompleteIngestResponse(payload, parsedIngest)
	return {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision,
		outcome,
		created: responseCount(value, 'created'),
		updated: responseCount(value, 'updated'),
		disabled: responseCount(value, 'disabled'),
		reenabled: responseCount(value, 'reenabled'),
		unchanged: responseCount(value, 'unchanged'),
		ingest: parsedIngest,
	}
}

function parseIngestResult(value: unknown): OperationsCatalogReconcileResponseV2['ingest'][number] {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CatalogSyncError('operations catalog returned an invalid ingest configuration')
	}
	const coordinate = Reflect.get(value, 'coordinate')
	const credentialId = Reflect.get(value, 'credentialId')
	const ingestProjectId = Reflect.get(value, 'ingestProjectId')
	if (typeof coordinate !== 'object' || coordinate === null || Array.isArray(coordinate)) {
		throw new CatalogSyncError('operations catalog returned an invalid ingest configuration')
	}
	const appId = Reflect.get(coordinate, 'appId')
	const environment = Reflect.get(coordinate, 'environment')
	const serviceKey = Reflect.get(coordinate, 'serviceKey')
	if (
		typeof appId !== 'string'
		|| typeof environment !== 'string'
		|| typeof serviceKey !== 'string'
		|| typeof credentialId !== 'string'
		|| typeof ingestProjectId !== 'string'
		|| !/^[1-9][0-9]{0,18}$/.test(ingestProjectId)
	) {
		throw new CatalogSyncError('operations catalog returned an invalid ingest configuration')
	}
	return {
		coordinate: { appId, environment, serviceKey },
		credentialId,
		ingestProjectId,
	}
}

function assertCompleteIngestResponse(
	request: OperationsCatalogReconcileRequestV2,
	ingest: OperationsCatalogReconcileResponseV2['ingest'],
): void {
	if (ingest.length !== request.sources.length) {
		throw new CatalogSyncError('operations catalog returned an incomplete ingest configuration')
	}
	const expected = new Map(request.sources.map((source) => [
		coordinateKey(
			source.coordinate.appId,
			source.coordinate.environment,
			source.coordinate.serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY,
		),
		source.ingestCredential.id,
	]))
	for (const item of ingest) {
		const key = coordinateKey(item.coordinate.appId, item.coordinate.environment, item.coordinate.serviceKey)
		if (expected.get(key) !== item.credentialId) {
			throw new CatalogSyncError('operations catalog returned a mismatched ingest configuration')
		}
		expected.delete(key)
	}
	if (expected.size !== 0) throw new CatalogSyncError('operations catalog returned an incomplete ingest configuration')
}

function coordinateKey(appId: string, environment: string, serviceKey: string): string {
	return JSON.stringify([appId, environment, serviceKey])
}

function responseCount(value: object, key: string): number {
	const count = Reflect.get(value, key)
	if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	return count
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
