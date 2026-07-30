import {
	canonicalOperationsServiceKey,
	normalizeOperationsCommit,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	type OperationsArtifactState,
	operationsReleaseName,
	type OperationsReleasePhase,
	type OperationsReleaseReconcileRequestV1,
	type OperationsReleaseReconcileResponseV1,
} from '@fabrika/operations-contract'
import type { OperationsRepositories, ReleaseRow } from './repositories.js'
import { ArtifactProjectionConflictError } from './repositories.js'
import { uuidv7 } from './uuid.js'

const MAX_RELEASE_BODY_BYTES = 64 * 1024
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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
	if (!record(value)) throw new ReleaseRequestError(400, 'invalid release request')
	const protocolVersion = value['protocolVersion']
	const revision = value['revision']
	const runId = value['runId']
	const coordinate = value['coordinate']
	const phase = value['phase']
	const providerRunId = value['providerRunId']
	const outcome = value['outcome']
	const artifactState = value['artifactState']
	const release = value['release']
	const uploadCredential = value['uploadCredential']
	const observedAt = value['observedAt']
	if (
		protocolVersion !== OPERATIONS_RELEASE_PROTOCOL_VERSION
		|| typeof revision !== 'number'
		|| !Number.isSafeInteger(revision)
		|| revision < 1
		|| typeof runId !== 'string'
		|| !RUN_ID_PATTERN.test(runId)
		|| !record(coordinate)
		|| !releasePhase(phase)
		|| (providerRunId !== null && (typeof providerRunId !== 'string' || providerRunId.length > 256))
		|| (outcome !== null && outcome !== 'succeeded' && outcome !== 'failed')
		|| !artifactStatus(artifactState)
		|| !record(release)
		|| typeof observedAt !== 'number'
		|| !Number.isSafeInteger(observedAt)
		|| observedAt < 0
	) {
		throw new ReleaseRequestError(400, 'invalid release request')
	}
	const appId = coordinate['appId']
	const environment = coordinate['environment']
	const serviceKey = coordinate['serviceKey']
	if (
		typeof appId !== 'string'
		|| !COORDINATE_PATTERN.test(appId)
		|| typeof environment !== 'string'
		|| !COORDINATE_PATTERN.test(environment)
		|| (serviceKey !== undefined && (typeof serviceKey !== 'string' || !SERVICE_KEY_PATTERN.test(serviceKey)))
	) {
		throw new ReleaseRequestError(400, 'invalid release coordinates')
	}
	const releaseKind = release['kind']
	let parsedRelease: OperationsReleaseReconcileRequestV1['release']
	if (releaseKind === 'available') {
		const name = release['name']
		const commitSha = release['commitSha']
		const normalizedCommit = typeof commitSha === 'string' ? normalizeOperationsCommit(commitSha) : null
		if (typeof name !== 'string' || name.length > 512 || normalizedCommit === null) {
			throw new ReleaseRequestError(400, 'invalid available release')
		}
		parsedRelease = { kind: 'available', name, commitSha: normalizedCommit }
	} else if (releaseKind === 'unavailable') {
		const reason = release['reason']
		if (reason !== 'dry_run' && reason !== 'missing_commit') {
			throw new ReleaseRequestError(400, 'invalid unavailable release')
		}
		parsedRelease = { kind: 'unavailable', reason }
	} else {
		throw new ReleaseRequestError(400, 'invalid release availability')
	}
	let parsedCredential: OperationsReleaseReconcileRequestV1['uploadCredential']
	if (uploadCredential !== undefined) {
		if (!record(uploadCredential)) throw new ReleaseRequestError(400, 'invalid upload credential')
		const verifier = uploadCredential['verifier']
		const expiresAt = uploadCredential['expiresAt']
		if (
			typeof verifier !== 'string'
			|| !HASH_PATTERN.test(verifier)
			|| typeof expiresAt !== 'number'
			|| !Number.isSafeInteger(expiresAt)
			|| expiresAt <= observedAt
		) {
			throw new ReleaseRequestError(400, 'invalid upload credential')
		}
		parsedCredential = { verifier, expiresAt }
	}
	if (parsedRelease.kind === 'unavailable' && parsedCredential !== undefined) {
		throw new ReleaseRequestError(400, 'unavailable releases cannot accept artifacts')
	}
	if (phase === 'terminal' && outcome === null) throw new ReleaseRequestError(400, 'terminal release has no outcome')
	if (phase !== 'terminal' && outcome !== null) throw new ReleaseRequestError(400, 'non-terminal release has an outcome')
	return {
		protocolVersion,
		revision,
		runId,
		coordinate: { appId, environment, ...(serviceKey === undefined ? {} : { serviceKey }) },
		phase,
		providerRunId,
		outcome,
		artifactState,
		release: parsedRelease,
		...(parsedCredential === undefined ? {} : { uploadCredential: parsedCredential }),
		observedAt,
	}
}

function releaseResponse(
	revision: number,
	outcome: OperationsReleaseReconcileResponseV1['outcome'],
	releaseId: string | null,
): OperationsReleaseReconcileResponseV1 {
	return { protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION, revision, outcome, releaseId }
}

function releasePhase(value: unknown): value is OperationsReleasePhase {
	return value === 'started' || value === 'provider_accepted' || value === 'terminal'
}

function artifactStatus(value: unknown): value is OperationsArtifactState {
	return value === 'pending' || value === 'complete' || value === 'incomplete' || value === 'not_applicable'
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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
