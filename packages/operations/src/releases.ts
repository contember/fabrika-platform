import {
	canonicalOperationsServiceKey,
	normalizeOperationsCommit,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
	type OperationsReleaseReconcileResponseV1,
} from '@fabrika/operations-contract'
import { OperationsReleaseDecodeError, parseOperationsReleaseRequest } from '@fabrika/operations-contract/releases'
import type { OperationsRepositories, ReleaseRow } from './repositories.js'
import { ArtifactProjectionConflictError } from './repositories.js'
import { uuidv7 } from './uuid.js'

const MAX_RELEASE_BODY_BYTES = 64 * 1024

export interface ReleaseHandlerOptions {
	repositories: OperationsRepositories
	syncKey: string
}

export async function reconcileOperationsRelease(
	repositories: OperationsRepositories,
	request: OperationsReleaseReconcileRequestV1,
): Promise<OperationsReleaseReconcileResponseV1> {
	const serviceKey = canonicalOperationsServiceKey(request.coordinate.serviceKey)
	const source = await repositories.sources.getByCoordinate(
		request.coordinate.appId,
		request.coordinate.environment,
		serviceKey,
	)
	if (source === null) throw new ReleaseRequestError(404, 'Operations source is unavailable')
	const projectionHash = await hashProjection(request)
	const disposition = await repositories.artifacts.projectionDisposition(
		request.runId,
		source.id,
		request.revision,
		projectionHash,
	)
	if (disposition === 'stale') return releaseResponse(request.revision, 'stale', null)

	let release: ReleaseRow | null = null
	if (request.release.kind === 'available') {
		const commitSha = normalizeOperationsCommit(request.release.commitSha)
		if (commitSha === null) throw new ReleaseRequestError(400, 'release commit is not an immutable git object id')
		const expectedName = operationsReleaseName({
			appId: request.coordinate.appId,
			environment: request.coordinate.environment,
			serviceKey,
			commitSha,
		})
		if (request.release.name !== expectedName) {
			throw new ReleaseRequestError(400, 'release name does not match its coordinates and commit')
		}
		release = await repositories.artifacts.upsertRelease({
			id: uuidv7(request.observedAt),
			sourceId: source.id,
			runId: request.runId,
			commitSha,
			releaseName: request.release.name,
			state: request.outcome ?? request.phase,
			artifactState: request.artifactState,
			...(request.phase === 'terminal' ? { finishedAt: request.observedAt } : {}),
			observedAt: request.observedAt,
		})
	}

	const outcome = disposition === 'unchanged'
		? 'unchanged'
		: await repositories.artifacts.reconcileRunLink({
			runId: request.runId,
			sourceId: source.id,
			releaseId: release?.id ?? null,
			availability: request.release.kind,
			unavailableReason: request.release.kind === 'unavailable' ? request.release.reason : null,
			phase: request.phase,
			providerRunId: request.providerRunId,
			outcome: request.outcome,
			artifactState: request.artifactState,
			revision: request.revision,
			projectionHash,
			observedAt: request.observedAt,
		})
	if (release !== null && request.uploadCredential !== undefined) {
		const stored = await repositories.artifacts.putUploadCredential({
			id: uuidv7(request.observedAt),
			runId: request.runId,
			releaseId: release.id,
			verifier: request.uploadCredential.verifier,
			expiresAt: request.uploadCredential.expiresAt,
		})
		if (!stored) throw new ArtifactProjectionConflictError('artifact upload credential conflicts with this run')
	}
	return releaseResponse(request.revision, outcome, release?.id ?? null)
}

export async function handleOperationsReleaseRequest(request: Request, options: ReleaseHandlerOptions): Promise<Response> {
	if (request.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST' })
	if (!(await validBearer(request.headers.get('authorization'), options.syncKey))) {
		return jsonError(401, 'unauthorized')
	}
	const declaredLength = request.headers.get('content-length')
	if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_RELEASE_BODY_BYTES)) {
		return jsonError(413, 'payload too large')
	}
	let raw: string
	try {
		raw = await request.text()
	} catch {
		return jsonError(400, 'malformed request')
	}
	if (new TextEncoder().encode(raw).length > MAX_RELEASE_BODY_BYTES) return jsonError(413, 'payload too large')
	try {
		const parsed: unknown = JSON.parse(raw)
		return Response.json(await reconcileOperationsRelease(options.repositories, parseReleaseRequest(parsed)))
	} catch (error) {
		if (error instanceof ReleaseRequestError) return jsonError(error.status, error.message)
		if (error instanceof ArtifactProjectionConflictError) return jsonError(409, error.message)
		console.error('operations release reconcile failed')
		return jsonError(500, 'internal error')
	}
}

export function parseReleaseRequest(value: unknown): OperationsReleaseReconcileRequestV1 {
	try {
		return parseOperationsReleaseRequest(value)
	} catch (error) {
		if (error instanceof OperationsReleaseDecodeError) throw new ReleaseRequestError(400, error.message)
		throw error
	}
}

function releaseResponse(
	revision: number,
	outcome: OperationsReleaseReconcileResponseV1['outcome'],
	releaseId: string | null,
): OperationsReleaseReconcileResponseV1 {
	return { protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION, revision, outcome, releaseId }
}

async function hashProjection(request: OperationsReleaseReconcileRequestV1): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(request))
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function validBearer(header: string | null, expected: string): Promise<boolean> {
	if (expected.length < 32 || header === null || !header.startsWith('Bearer ')) return false
	const supplied = header.slice('Bearer '.length)
	if (supplied.length === 0) return false
	const [left, right] = await Promise.all([sha256(supplied), sha256(expected)])
	let difference = left.length ^ right.length
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
	return difference === 0
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json({ error: message }, { status, headers })
}

class ReleaseRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message)
	}
}
