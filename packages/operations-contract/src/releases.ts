/** Private Delivery → Operations release and artifact protocol; both services ship together. */

import { DEFAULT_OPERATIONS_SERVICE_KEY } from './catalog.js'
import {
	operationsReleaseIssueMessage,
	operationsReleasePayloadSchema,
	operationsReleaseRequestSchema,
	operationsSourceMapBuildUploadSchema,
} from './release-schemas.js'

export {
	operationsArtifactUploadCredentialSchema,
	operationsReleaseAvailabilitySchema,
	operationsReleaseCoordinateSchema,
	operationsReleasePayloadSchema,
	operationsReleaseRequestSchema,
	operationsSourceMapBuildUploadSchema,
} from './release-schemas.js'

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

export interface OperationsReleaseCoordinate {
	appId: string
	environment: string
	serviceKey?: string
}

export type OperationsReleaseAvailability =
	| {
		kind: 'available'
		name: string
		commitSha: string
	}
	| {
		kind: 'unavailable'
		reason: OperationsReleaseUnavailableReason
	}

export interface OperationsArtifactUploadCredential {
	/** SHA-256 verifier. The bearer itself never crosses the private projection boundary. */
	verifier: string
	expiresAt: number
}

export interface OperationsReleaseReconcileRequest {
	revision: number
	runId: string
	coordinate: OperationsReleaseCoordinate
	phase: OperationsReleasePhase
	providerRunId: string | null
	outcome: OperationsReleaseOutcome
	artifactState: OperationsArtifactState
	release: OperationsReleaseAvailability
	uploadCredential?: OperationsArtifactUploadCredential
	observedAt: number
}

export type OperationsReleaseProjectionPayload = Omit<OperationsReleaseReconcileRequest, 'revision'>

export class OperationsReleaseDecodeError extends Error {}

export function parseOperationsReleaseRequest(value: unknown): OperationsReleaseReconcileRequest {
	const result = operationsReleaseRequestSchema.safeParse(value)
	if (!result.success) throw new OperationsReleaseDecodeError(operationsReleaseIssueMessage(result.error.issues))
	return result.data
}

export function parseOperationsReleasePayload(value: unknown): OperationsReleaseProjectionPayload {
	const result = operationsReleasePayloadSchema.safeParse(value)
	if (!result.success) throw new OperationsReleaseDecodeError(operationsReleaseIssueMessage(result.error.issues))
	return result.data
}

export type OperationsReleaseReconcileOutcome = 'applied' | 'unchanged' | 'stale'

export interface OperationsReleaseReconcileResponse {
	revision: number
	outcome: OperationsReleaseReconcileOutcome
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

/** A directory of a build's public assets and the URL path its files are served under: `{ prefix: '/', dir: 'dist/web' }`. */
export interface OperationsAssetRoot {
	prefix: string
	dir: string
}

/**
 * What a platform build reads to upload its source maps: the destination without its bearer, which travels apart, and
 * the asset roots whose maps it uploads. A map's logical path is the URL path of the file it maps.
 */
export interface OperationsSourceMapBuildUpload {
	destination: Omit<OperationsArtifactUploadConfiguration, 'bearer'>
	assetRoots: OperationsAssetRoot[]
}

/** Throws on any other value. */
export function parseOperationsSourceMapBuildUpload(value: unknown): OperationsSourceMapBuildUpload {
	return operationsSourceMapBuildUploadSchema.parse(value)
}

/** Whether every source map a build found reached Operations. */
export type OperationsSourceMapUploadState = 'complete' | 'incomplete'

const SOURCE_MAP_REPORT_PREFIX = 'fabrika-source-maps:'
const SOURCE_MAP_REPORT = /fabrika-source-maps: \d+ uploaded, state=(complete|incomplete)\s*$/

/** The one line a build prints after its upload; the provider reads the state back from the build log. */
export function sourceMapUploadReport(uploaded: number, state: OperationsSourceMapUploadState): string {
	return `${SOURCE_MAP_REPORT_PREFIX} ${uploaded} uploaded, state=${state}`
}

/** The state a build-log line reports, or `null` for any other line. */
export function readSourceMapUploadReport(line: string): OperationsSourceMapUploadState | null {
	const state = SOURCE_MAP_REPORT.exec(line)?.[1]
	return state === 'complete' || state === 'incomplete' ? state : null
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
