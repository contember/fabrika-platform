/** Versioned private Delivery → Operations release and artifact protocol. */

import { DEFAULT_OPERATIONS_SERVICE_KEY } from './catalog.js'

export const OPERATIONS_RELEASE_PROTOCOL_VERSION = 1
export const FABRIKA_RELEASE = 'FABRIKA_RELEASE'
export const OPERATIONS_RELEASE_RECONCILE_PATH = '/private/releases/reconcile'
export const OPERATIONS_SOURCE_MAP_UPLOAD_PATH = '/api/artifacts/source-maps/'

export const OPERATIONS_ARTIFACT_HEADERS = {
	appId: 'X-Fabrika-App-Id',
	environment: 'X-Fabrika-Environment',
	serviceKey: 'X-Fabrika-Service-Key',
	release: 'X-Fabrika-Release',
	runId: 'X-Fabrika-Run-Id',
	logicalPath: 'X-Fabrika-Artifact-Path',
	digest: 'X-Fabrika-Artifact-Sha256',
}

export type OperationsReleasePhase = 'started' | 'provider_accepted' | 'terminal'
export type OperationsReleaseOutcome = 'succeeded' | 'failed' | null
export type OperationsArtifactState = 'pending' | 'complete' | 'incomplete' | 'not_applicable'
export type OperationsReleaseUnavailableReason = 'dry_run' | 'missing_commit'

export interface OperationsReleaseCoordinateV1 {
	appId: string
	environment: string
	serviceKey?: string
}

export type OperationsReleaseAvailabilityV1 =
	| {
		kind: 'available'
		name: string
		commitSha: string
	}
	| {
		kind: 'unavailable'
		reason: OperationsReleaseUnavailableReason
	}

export interface OperationsArtifactUploadCredentialV1 {
	/** SHA-256 verifier. The bearer itself never crosses the private projection boundary. */
	verifier: string
	expiresAt: number
}

export interface OperationsReleaseReconcileRequestV1 {
	protocolVersion: typeof OPERATIONS_RELEASE_PROTOCOL_VERSION
	revision: number
	runId: string
	coordinate: OperationsReleaseCoordinateV1
	phase: OperationsReleasePhase
	providerRunId: string | null
	outcome: OperationsReleaseOutcome
	artifactState: OperationsArtifactState
	release: OperationsReleaseAvailabilityV1
	uploadCredential?: OperationsArtifactUploadCredentialV1
	observedAt: number
}

export type OperationsReleaseProjectionPayloadV1 = Omit<OperationsReleaseReconcileRequestV1, 'protocolVersion' | 'revision'>

export class OperationsReleaseDecodeError extends Error {}

export function parseOperationsReleaseRequest(value: unknown): OperationsReleaseReconcileRequestV1 {
	if (!record(value)) throw new OperationsReleaseDecodeError('invalid release request')
	const protocolVersion = value['protocolVersion']
	const revision = value['revision']
	if (
		protocolVersion !== OPERATIONS_RELEASE_PROTOCOL_VERSION
		|| typeof revision !== 'number'
		|| !Number.isSafeInteger(revision)
		|| revision < 1
	) {
		throw new OperationsReleaseDecodeError('invalid release request')
	}
	return { protocolVersion, revision, ...parseOperationsReleasePayload(value) }
}

export function parseOperationsReleasePayload(value: unknown): OperationsReleaseProjectionPayloadV1 {
	if (!record(value)) throw new OperationsReleaseDecodeError('invalid release request')
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
		typeof runId !== 'string'
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
		throw new OperationsReleaseDecodeError('invalid release request')
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
		throw new OperationsReleaseDecodeError('invalid release coordinates')
	}
	const releaseKind = release['kind']
	let parsedRelease: OperationsReleaseAvailabilityV1
	if (releaseKind === 'available') {
		const name = release['name']
		const commitSha = release['commitSha']
		const normalizedCommit = typeof commitSha === 'string' ? normalizeOperationsCommit(commitSha) : null
		if (typeof name !== 'string' || name.length > 512 || normalizedCommit === null) {
			throw new OperationsReleaseDecodeError('invalid available release')
		}
		parsedRelease = { kind: 'available', name, commitSha: normalizedCommit }
	} else if (releaseKind === 'unavailable') {
		const reason = release['reason']
		if (reason !== 'dry_run' && reason !== 'missing_commit') {
			throw new OperationsReleaseDecodeError('invalid unavailable release')
		}
		parsedRelease = { kind: 'unavailable', reason }
	} else {
		throw new OperationsReleaseDecodeError('invalid release availability')
	}
	let parsedCredential: OperationsArtifactUploadCredentialV1 | undefined
	if (uploadCredential !== undefined) {
		if (!record(uploadCredential)) throw new OperationsReleaseDecodeError('invalid upload credential')
		const verifier = uploadCredential['verifier']
		const expiresAt = uploadCredential['expiresAt']
		if (
			typeof verifier !== 'string'
			|| !HASH_PATTERN.test(verifier)
			|| typeof expiresAt !== 'number'
			|| !Number.isSafeInteger(expiresAt)
			|| expiresAt <= observedAt
		) {
			throw new OperationsReleaseDecodeError('invalid upload credential')
		}
		parsedCredential = { verifier, expiresAt }
	}
	if (parsedRelease.kind === 'unavailable' && parsedCredential !== undefined) {
		throw new OperationsReleaseDecodeError('unavailable releases cannot accept artifacts')
	}
	if (phase === 'terminal' && outcome === null) throw new OperationsReleaseDecodeError('terminal release has no outcome')
	if (phase !== 'terminal' && outcome !== null) throw new OperationsReleaseDecodeError('non-terminal release has an outcome')
	// Field order and optional-field omission preserve historical receiver projection hashes.
	return {
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

export type OperationsReleaseReconcileOutcome = 'applied' | 'unchanged' | 'stale'

export interface OperationsReleaseReconcileResponseV1 {
	protocolVersion: typeof OPERATIONS_RELEASE_PROTOCOL_VERSION
	revision: number
	outcome: OperationsReleaseReconcileOutcome
	releaseId: string | null
}

export interface OperationsArtifactUploadConfiguration {
	url: string
	bearer: string
	appId: string
	environment: string
	serviceKey: string
	release: string
	runId: string
}

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function releasePhase(value: unknown): value is OperationsReleasePhase {
	return value === 'started' || value === 'provider_accepted' || value === 'terminal'
}

function artifactStatus(value: unknown): value is OperationsArtifactState {
	return value === 'pending' || value === 'complete' || value === 'incomplete' || value === 'not_applicable'
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeOperationsCommit(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null
	const normalized = value.toLowerCase()
	return COMMIT_PATTERN.test(normalized) ? normalized : null
}

export function operationsReleaseName(input: {
	appId: string
	environment: string
	serviceKey?: string
	commitSha: string
}): string {
	const commitSha = normalizeOperationsCommit(input.commitSha)
	if (commitSha === null) throw new Error('release commit must be a complete immutable git object id')
	return [
		'fabrika',
		encodeURIComponent(input.appId),
		encodeURIComponent(input.environment),
		encodeURIComponent(input.serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY),
		commitSha,
	].join('/')
}

export function operationsSourceMapUploadUrl(origin: string): string {
	const url = new URL(origin)
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:')
		|| url.origin !== origin
		|| url.username !== ''
		|| url.password !== ''
	) {
		throw new Error('Operations artifact origin must be an HTTP origin')
	}
	url.pathname = OPERATIONS_SOURCE_MAP_UPLOAD_PATH
	return url.toString()
}
