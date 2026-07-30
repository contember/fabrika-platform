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
