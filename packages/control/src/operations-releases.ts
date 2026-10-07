import {
	FABRIKA_RELEASE,
	normalizeOperationsCommit,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	OPERATIONS_RELEASE_RECONCILE_PATH,
	type OperationsArtifactState,
	type OperationsArtifactUploadConfiguration,
	type OperationsReleaseAvailabilityV1,
	operationsReleaseName,
	type OperationsReleasePhase,
	type OperationsReleaseProjectionPayloadV1,
	type OperationsReleaseReconcileRequestV1,
	operationsSourceMapUploadUrl,
	parseOperationsReleasePayload,
} from '@fabrika/operations-contract/releases'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import type { OperationsReleaseRepository, OperationsReleaseSyncRow, RunRepository, RunRow, TerminalOperationsReleaseRow } from './db'

const REQUEST_TIMEOUT_MS = 15_000
const MIN_SYNC_KEY_LENGTH = 32
const UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1_000
const REPLAY_BATCH_SIZE = 100

export interface OperationsReleaseProjectionDeps {
	repository: OperationsReleaseRepository
	service?: HttpService
	syncKey?: string
	artifactOrigin?: string
	now?: () => number
	terminalRepair?: { runs: RunRepository }
}

export interface OperationsReleaseContext {
	managedEnvironment: Readonly<Record<typeof FABRIKA_RELEASE, string>>
	artifactUpload?: OperationsArtifactUploadConfiguration
}

export interface OperationsReleaseProjectionSummary {
	applied: number
	failed: number
	pending: number
}

export async function projectOperationsRun(
	deps: OperationsReleaseProjectionDeps,
	run: RunRow,
	input: {
		dryRun: boolean
		phase: OperationsReleasePhase
		artifactState: OperationsArtifactState
		outcome?: 'succeeded' | 'failed'
	},
): Promise<OperationsReleaseContext | null> {
	const now = deps.now ?? Date.now
	const observedAt = now()
	const uploadExpiresAt = (run.started_at === null ? observedAt : run.started_at * 1_000) + UPLOAD_LIFETIME_MS
	const commitSha = normalizeOperationsCommit(run.commit_sha)
	let release: OperationsReleaseAvailabilityV1
	if (input.dryRun) {
		release = { kind: 'unavailable', reason: 'dry_run' }
	} else if (commitSha === null) {
		release = { kind: 'unavailable', reason: 'missing_commit' }
	} else {
		release = {
			kind: 'available',
			name: operationsReleaseName({ appId: run.app_id, environment: run.env, commitSha }),
			commitSha,
		}
	}
	const context = release.kind === 'available'
		? await releaseContext(deps, run, release.name, uploadExpiresAt)
		: null
	const credential = context?.artifactUpload === undefined
		? undefined
		: {
			verifier: await sha256Hex(context.artifactUpload.bearer),
			expiresAt: uploadExpiresAt,
		}
	const payload: OperationsReleaseProjectionPayloadV1 = {
		runId: run.id,
		coordinate: { appId: run.app_id, environment: run.env },
		phase: input.phase,
		providerRunId: run.external_run_id,
		outcome: input.outcome ?? null,
		artifactState: release.kind === 'unavailable' ? 'not_applicable' : input.artifactState,
		release,
		...(credential === undefined ? {} : { uploadCredential: credential }),
		observedAt,
	}
	try {
		const revision = await deps.repository.project(run.id, JSON.stringify(payload))
		await flushOne(deps, {
			run_id: run.id,
			desired_revision: revision,
			applied_revision: revision - 1,
			payload_json: JSON.stringify(payload),
			last_attempt_at: null,
			last_success_at: null,
			last_error: null,
		})
	} catch {
		console.warn(`operations release projection failed for run ${run.id}`)
	}
	return context
}

export async function replayOperationsReleases(
	deps: OperationsReleaseProjectionDeps,
): Promise<OperationsReleaseProjectionSummary> {
	let applied = 0
	let failed = 0
	await repairTerminalReleases(deps)
	const rows = await deps.repository.listPending(REPLAY_BATCH_SIZE)
	for (const row of rows) {
		let delivery = row
		if (deps.terminalRepair !== undefined) {
			const terminal = await deps.repository.getTerminal(row.run_id)
			if (terminal !== null) {
				delivery = terminal
				try {
					if (terminalPayload(terminal) !== null) {
						failed++
						continue
					}
				} catch {
					failed++
					continue
				}
			}
		}
		if (await flushOne(deps, delivery)) applied++
		else failed++
	}
	const pending = (await deps.repository.listPending(REPLAY_BATCH_SIZE)).length
	return { applied, failed, pending }
}

async function repairTerminalReleases(deps: OperationsReleaseProjectionDeps): Promise<void> {
	if (deps.terminalRepair === undefined) return
	const boundary = await deps.repository.terminalScanBoundary()
	if (boundary === null) return
	let after = ''
	while (true) {
		const page = await deps.repository.listTerminalPage(after, boundary, REPLAY_BATCH_SIZE)
		if (page.length === 0) break
		for (const candidate of page) {
			after = candidate.run_id
			if (validatedTerminalSnapshotAgrees(candidate)) continue
			try {
				const current = await deps.repository.getTerminal(candidate.run_id)
				if (current === null || current.app_id !== candidate.app_id || current.env !== candidate.env) continue
				let payload: OperationsReleaseProjectionPayloadV1 | null
				try {
					integer(current.desired_revision)
					payload = terminalPayload(current)
				} catch {
					await deps.repository.repairTerminal(current, null)
					continue
				}
				if (payload !== null) await deps.repository.repairTerminal(current, JSON.stringify(payload))
			} catch {
				console.warn(`operations terminal release repair failed for run ${candidate.run_id}`)
			}
		}
	}
}

function validatedTerminalSnapshotAgrees(row: TerminalOperationsReleaseRow): boolean {
	if (
		row.id !== row.run_id || row.finished_at === null || row.finished_at < 0
		|| !Number.isSafeInteger(row.finished_at) || !Number.isSafeInteger(row.finished_at * 1_000)
		|| (row.external_run_id !== null && (typeof row.external_run_id !== 'string' || row.external_run_id.length > 256))
	) return false
	try {
		integer(row.desired_revision)
		return terminalPayload(row) === null
	} catch {
		return false
	}
}

function terminalPayload(row: TerminalOperationsReleaseRow): OperationsReleaseProjectionPayloadV1 | null {
	const payload = parseStoredPayload(row.payload_json)
	if (
		payload.runId !== row.run_id || payload.coordinate.appId !== row.app_id || payload.coordinate.environment !== row.env
		|| (payload.release.kind === 'available' && payload.release.name !== operationsReleaseName({
					...payload.coordinate,
					commitSha: payload.release.commitSha,
				}))
	) throw new Error('incompatible frozen release context')
	if (payload.phase === 'terminal' && payload.outcome === row.status) return null
	if (
		(row.status !== 'succeeded' && row.status !== 'failed')
		|| (payload.phase === 'terminal' && (payload.outcome !== 'succeeded' || row.status !== 'failed'))
		|| row.finished_at === null || !Number.isSafeInteger(row.finished_at) || row.finished_at < 0
	) throw new Error('insufficient terminal release context')
	return parseOperationsReleasePayload({
		...payload,
		phase: 'terminal',
		providerRunId: row.external_run_id,
		outcome: row.status,
		artifactState: payload.release.kind === 'unavailable'
			? 'not_applicable'
			: payload.artifactState === 'pending'
			? 'incomplete'
			: payload.artifactState,
		observedAt: Math.max(row.finished_at * 1_000, payload.observedAt),
	})
}

async function flushOne(deps: OperationsReleaseProjectionDeps, row: OperationsReleaseSyncRow): Promise<boolean> {
	try {
		const revision = integer(row.desired_revision)
		if (deps.service === undefined || deps.syncKey === undefined || deps.syncKey.length < MIN_SYNC_KEY_LENGTH) {
			throw new ReleaseProjectionError('operations release transport is not configured')
		}
		const payload = parseStoredPayload(row.payload_json)
		if (payload.runId !== row.run_id) throw new ReleaseProjectionError('operations release run does not match its outbox key')
		const request: OperationsReleaseReconcileRequestV1 = {
			protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
			revision,
			...payload,
		}
		await deps.repository.markAttempt(row.run_id, revision)
		const response = await deps.service.fetch(
			new Request(`https://operations.internal${OPERATIONS_RELEASE_RECONCILE_PATH}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${deps.syncKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		)
		if (!response.ok) throw new ReleaseProjectionError(`operations release returned status ${response.status}`)
		const value: unknown = await response.json()
		if (!validResponse(value, revision)) throw new ReleaseProjectionError('operations release returned an invalid response')
		await deps.repository.markApplied(row.run_id, revision)
		return true
	} catch (error) {
		const message = error instanceof ReleaseProjectionError ? error.message : 'operations release request failed'
		await deps.repository.markFailed(row, message).catch(() => {})
		return false
	}
}

async function releaseContext(
	deps: OperationsReleaseProjectionDeps,
	run: RunRow,
	release: string,
	expiresAt: number,
): Promise<OperationsReleaseContext> {
	const managedEnvironment = { [FABRIKA_RELEASE]: release }
	if (
		deps.syncKey === undefined
		|| deps.syncKey.length < MIN_SYNC_KEY_LENGTH
		|| deps.artifactOrigin === undefined
		|| deps.artifactOrigin.trim() === ''
	) {
		return { managedEnvironment }
	}
	try {
		const bearer = await scopedBearer(deps.syncKey, run.id, release, expiresAt)
		return {
			managedEnvironment,
			artifactUpload: {
				url: operationsSourceMapUploadUrl(deps.artifactOrigin),
				bearer,
				appId: run.app_id,
				environment: run.env,
				serviceKey: 'default',
				release,
				runId: run.id,
			},
		}
	} catch {
		return { managedEnvironment }
	}
}

async function scopedBearer(syncKey: string, runId: string, release: string, expiresAt: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(syncKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const bytes = new TextEncoder().encode(`${runId}\u0000${release}\u0000${expiresAt}`)
	return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)))
}

async function sha256Hex(value: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseStoredPayload(raw: string): OperationsReleaseProjectionPayloadV1 {
	const decoded: unknown = JSON.parse(raw)
	return parseOperationsReleasePayload(decoded)
}

function validResponse(value: unknown, revision: number): boolean {
	const parsed = releaseResponseSchema.safeParse(value)
	return parsed.success && parsed.data.revision === revision
}

const releaseResponseSchema = z.object({
	protocolVersion: z.literal(OPERATIONS_RELEASE_PROTOCOL_VERSION),
	revision: z.number(),
	outcome: z.coerce.string().pipe(z.enum(['applied', 'unchanged', 'stale'])),
})

function integer(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('invalid Operations release revision')
	return parsed
}

class ReleaseProjectionError extends Error {}
