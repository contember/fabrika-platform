import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	type OperationsCatalogReconcileRequest,
	type OperationsCatalogReconcileResponse,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSource,
} from '@fabrika/operations-contract/catalog'
import { buildOperationsDsn } from '@fabrika/operations-contract/ingest'
import type { DeployLocks, HttpService } from '@fabrika/platform'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { z } from 'zod'
import type { OperationsCatalogRepository } from './db'
import { acquireLease, CATALOG_LEASE_KEY, type Lease, type LeaseClock } from './lease'
import { canonicalPublicOrigin, PublicOriginValidationError } from './public-origin'

/** The origin of an environment's Operations DSN, which its proxy's `connect-src` admits; never the key. */
export function ingestOrigin(ingest: { readonly dsn: string | null } | null): string | undefined {
	if (ingest?.dsn === null || ingest?.dsn === undefined) return undefined
	try {
		return new URL(ingest.dsn).origin
	} catch {
		return undefined
	}
}

const CATALOG_ENDPOINT = 'https://operations.internal/private/catalog/reconcile'
const CATALOG_REQUEST_TIMEOUT_MS = 15_000
const MIN_SYNC_KEY_LENGTH = 32
const MAX_COALESCED_PASSES = 20
/** Guarded flushes after a release, for a change that coalesced against this holder's own handoff. */
const MAX_HANDOFF_PASSES = 2
/** A release that hangs must not hold up its flush's task, and with it a shutdown's drain. */
const RELEASE_TIMEOUT_MS = 5_000

export type OperationsCatalogSyncOutcome = 'disabled' | 'applied' | 'unchanged' | 'coalesced' | 'failed'

export interface OperationsCatalogSyncSummary {
	outcome: OperationsCatalogSyncOutcome
	revision: number | null
}

/** Catalog leases this process holds right now, so a shutdown can hand them back instead of leaving them to expire. */
const heldLeases = new Set<Lease>()
let closing = false

/** A closing process takes no new catalog lease; a pending revision is left to the replay or the next process. */
export function closeCatalogProjection(): void {
	closing = true
}

/** Undo `closeCatalogProjection`, for a test process that keeps using this module after a shutdown. */
export function reopenCatalogProjection(): void {
	closing = false
}

/**
 * Interrupt every flush this process still runs and release its lease. The process a rolling deploy
 * replaces is the usual dead holder (backlog 84); an interrupted flush leaves its revision pending.
 */
export async function releaseHeldCatalogLeases(): Promise<void> {
	const leases = [...heldLeases]
	heldLeases.clear()
	if (leases.length === 0) return
	console.warn('operations catalog sync interrupted by shutdown')
	await Promise.all(leases.map((lease) => releaseCatalogLease(lease)))
}

export interface OperationsCatalogSyncDeps {
	catalog: OperationsCatalogRepository
	locks: DeployLocks
	service?: HttpService
	syncKey?: string
	operationsOrigin?: string
	leaseClock?: LeaseClock
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
		const service = deps.service
		const syncKey = deps.syncKey
		if (service === undefined || syncKey === undefined || syncKey.length < MIN_SYNC_KEY_LENGTH) {
			return await failCatalogSync(deps.catalog, requestedRevision, 'operations catalog transport is not configured')
		}
		const operationsOrigin = deps.operationsOrigin?.trim()
		if (operationsOrigin === undefined || operationsOrigin === '') {
			return await failCatalogSync(deps.catalog, requestedRevision, 'operations public origin is not configured')
		}

		let summary = await flushUnderLock(deps, service, syncKey, operationsOrigin)
		if (summary === null) {
			logCatalogSync('coalesced', requestedRevision)
			return { outcome: 'coalesced', revision: requestedRevision }
		}
		// A change that advanced `desired` after the holder's last read but before its release is invisible
		// to the flush loop, and used to wait for the 5-minute maintenance replay (backlog 84). The last
		// pass has the same window, so this narrows the gap rather than removing it; a `coalesced` flush
		// already gave up under churn, so replaying it here would only burn the lease.
		for (let pass = 0; pass < MAX_HANDOFF_PASSES && summary.outcome !== 'coalesced'; pass++) {
			const state = await deps.catalog.getState()
			if (state.desiredRevision <= state.appliedRevision) break
			const handoff = await flushUnderLock(deps, service, syncKey, operationsOrigin)
			if (handoff === null) break
			summary = handoff
		}
		logCatalogSync(summary.outcome, summary.revision)
		return summary
	} catch (cause) {
		const message = cause instanceof CatalogSyncError ? cause.message : 'operations catalog sync failed'
		// A lost lease is not a catalog failure: the next holder or the maintenance replay delivers the revision.
		if (!(cause instanceof ProviderInvocationAbort)) await recordCatalogFailure(deps.catalog, message)
		// Only a CatalogSyncError carries a reason worth printing; the fallback just repeats the outcome.
		logCatalogSync('failed', requestedRevision, cause instanceof CatalogSyncError ? cause.message : undefined)
		return { outcome: 'failed', revision: requestedRevision }
	}
}

/** One leased flush. `null` means another holder owns the lease and is delivering the same desired revision. */
async function flushUnderLock(
	deps: OperationsCatalogSyncDeps,
	service: HttpService,
	syncKey: string,
	operationsOrigin: string,
): Promise<OperationsCatalogSyncSummary | null> {
	if (closing) return null
	const lease = await acquireLease(deps.locks, CATALOG_LEASE_KEY, deps.leaseClock)
	if (lease === null) return null
	// A shutdown sweep that ran while the acquisition was in flight never saw this lease.
	if (closing) {
		await releaseCatalogLease(lease)
		return null
	}
	heldLeases.add(lease)
	try {
		return await flushCatalog(deps.catalog, lease, service, syncKey, operationsOrigin)
	} finally {
		// A shutdown that already took the lease out of the set releases it itself.
		if (heldLeases.delete(lease)) await releaseCatalogLease(lease)
	}
}

/** Bounded: a stalled release leaves the row to expire on its TTL; the lease's own renewal has already stopped. */
async function releaseCatalogLease(lease: Lease): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			console.warn('operations catalog lock release timed out')
			resolve()
		}, RELEASE_TIMEOUT_MS)
	})
	const released = lease.release().catch(() => {
		console.warn('operations catalog lock release failed')
	})
	try {
		await Promise.race([released, timedOut])
	} finally {
		clearTimeout(timer)
	}
}

async function failCatalogSync(
	catalog: OperationsCatalogRepository,
	revision: number | null,
	message: string,
): Promise<OperationsCatalogSyncSummary> {
	await catalog.markFailed(message)
	logCatalogSync('failed', revision, message)
	return { outcome: 'failed', revision }
}

/** One line per sync, so an installation can answer "what did the catalog do" without database access. */
function logCatalogSync(outcome: OperationsCatalogSyncOutcome, revision: number | null, reason?: string): void {
	const at = revision === null ? '' : ` revision ${revision}`
	if (outcome === 'failed') {
		console.warn(`operations catalog sync: failed${at}${reason === undefined ? '' : ` (${reason})`}`)
		return
	}
	console.info(`operations catalog sync: ${outcome}${at}`)
}

// Applying a reconcile is holder-fenced. `markAttempt` records a diagnostic and `advancePast` only moves the
// desired revision forward, so a stale holder's late write to either cannot undo a newer one.
async function flushCatalog(
	catalog: OperationsCatalogRepository,
	lease: Lease,
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
		const request: OperationsCatalogReconcileRequest = {
			revision: snapshot.revision,
			snapshotHash,
			sources,
		}
		lease.assertHeld()
		await catalog.markAttempt(snapshot.revision, snapshotHash)
		const response = await sendCatalog(service, syncKey, request, lease.signal)
		lastRevision = response.revision
		if (response.outcome === 'stale') {
			if (response.revision <= snapshot.revision) {
				throw new CatalogSyncError('operations catalog returned an invalid stale revision')
			}
			lease.assertHeld()
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
		lease.assertWritten(await catalog.markApplied(snapshot.revision, snapshotHash, configs, lease.fence()))
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
}): OperationsCatalogSource {
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
	payload: OperationsCatalogReconcileRequest,
	signal: AbortSignal,
): Promise<OperationsCatalogReconcileResponse> {
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
				signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS)]),
			}),
		)
	} catch {
		signal.throwIfAborted()
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
	const parsed = catalogResponseSchema.safeParse(value)
	if (!parsed.success) {
		throw new CatalogSyncError('operations catalog returned an invalid response')
	}
	const { revision, outcome, ingest } = parsed.data
	const parsedIngest = ingest.map(parseIngestResult)
	if (outcome !== 'stale') assertCompleteIngestResponse(payload, parsedIngest)
	return { revision, outcome, ingest: parsedIngest }
}

const catalogResponseSchema = z.object({
	revision: z.number().int().safe().positive(),
	outcome: z.enum(['applied', 'unchanged', 'stale']),
	ingest: z.array(z.unknown()),
})
const catalogIngestSchema = z.object({
	coordinate: z.object({ appId: z.string(), environment: z.string(), serviceKey: z.string() }),
	credentialId: z.string(),
	ingestProjectId: z.string().regex(/^[1-9][0-9]{0,18}$/),
})

function parseIngestResult(value: unknown): OperationsCatalogReconcileResponse['ingest'][number] {
	const parsed = catalogIngestSchema.safeParse(value)
	if (!parsed.success) throw new CatalogSyncError('operations catalog returned an invalid ingest configuration')
	return parsed.data
}

function assertCompleteIngestResponse(
	request: OperationsCatalogReconcileRequest,
	ingest: OperationsCatalogReconcileResponse['ingest'],
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

async function recordCatalogFailure(catalog: OperationsCatalogRepository, message: string): Promise<void> {
	try {
		await catalog.markFailed(message)
	} catch {
		console.warn('operations catalog failure status could not be stored')
	}
}

class CatalogSyncError extends Error {}
