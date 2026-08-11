export const ZEROPS_SOURCE_PROTOCOL_VERSION = 1
export const ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH = '/v1/installations/resolve'
export const ZEROPS_SOURCE_RESOLVE_PATH = '/v1/source/resolve'
export const ZEROPS_SOURCE_UPLOAD_PATH = '/v1/source/upload'
export const ZEROPS_SOURCE_CANCEL_PATH = '/v1/source/cancel'

const MAX_ID_LENGTH = 128
const MAX_REF_LENGTH = 255
const MAX_UPLOAD_URL_LENGTH = 4096
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/

export interface ZeropsSourceRepository {
	owner: string
	name: string
}

export interface ZeropsSourceDescriptor {
	path: 'zerops.yaml'
	sha256: string
}

export interface ZeropsSourceResolveInstallationRequestV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	repository: ZeropsSourceRepository
}

export interface ZeropsSourceResolveInstallationResponseV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	githubInstallationId: number | null
}

export interface ZeropsSourceResolveRequestV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	repository: ZeropsSourceRepository
	requestedRef: string
	expectedCommitSha?: string
	githubInstallationId?: number
	descriptorSha256: string
}

export interface ZeropsSourceResolveResponseV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	commitSha: string
	descriptorSha256: string
}

export interface ZeropsSourceUploadRequestV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	appVersionId: string
	repository: ZeropsSourceRepository
	commitSha: string
	githubInstallationId?: number
	uploadUrl: string
	descriptor: ZeropsSourceDescriptor
}

export interface ZeropsSourceUploadResponseV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	appVersionId: string
	commitSha: string
	descriptorSha256: string
}

export interface ZeropsSourceCancelRequestV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	appVersionId: string
}

export interface ZeropsSourceCancelResponseV1 {
	protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	runId: string
	appVersionId: string
}

export interface ZeropsSourceCancelResult {
	runId: string
	appVersionId: string
}

export type ZeropsSourceErrorCode =
	| 'invalid_request'
	| 'unauthorized'
	| 'repository_not_found'
	| 'installation_not_found'
	| 'ref_not_found'
	| 'commit_mismatch'
	| 'descriptor_missing'
	| 'descriptor_mismatch'
	| 'archive_rejected'
	| 'upload_rejected'
	| 'upload_failed'
	| 'cancelled'
	| 'internal'

export const ZEROPS_SOURCE_ERROR_CODES: readonly ZeropsSourceErrorCode[] = [
	'invalid_request',
	'unauthorized',
	'repository_not_found',
	'installation_not_found',
	'ref_not_found',
	'commit_mismatch',
	'descriptor_missing',
	'descriptor_mismatch',
	'archive_rejected',
	'upload_rejected',
	'upload_failed',
	'cancelled',
	'internal',
]

export type ZeropsSourceErrorStage = 'authenticate' | 'validate' | 'resolve-installation' | 'resolve' | 'archive' | 'upload' | 'cancel'

export const ZEROPS_SOURCE_ERROR_STAGES: readonly ZeropsSourceErrorStage[] = [
	'authenticate',
	'validate',
	'resolve-installation',
	'resolve',
	'archive',
	'upload',
	'cancel',
]

export interface ZeropsSourceErrorEnvelope {
	error: {
		code: ZeropsSourceErrorCode
		stage: ZeropsSourceErrorStage
		retryable: boolean
	}
}

export interface ZeropsSourceResolveInput {
	runId: string
	repository: ZeropsSourceRepository
	requestedRef: string
	expectedCommitSha?: string
	githubInstallationId?: number
	descriptorSha256: string
	signal: AbortSignal
}

export interface ZeropsSourceResolveResult {
	runId: string
	commitSha: string
	descriptorSha256: string
}

export interface ZeropsSourceUploadInput {
	runId: string
	appVersionId: string
	repository: ZeropsSourceRepository
	commitSha: string
	githubInstallationId?: number
	uploadUrl: string
	descriptor: ZeropsSourceDescriptor
	signal: AbortSignal
}

export interface ZeropsSourceUploadResult {
	runId: string
	appVersionId: string
	commitSha: string
	descriptorSha256: string
}

export interface ZeropsSourceCancelInput {
	runId: string
	appVersionId: string
	signal: AbortSignal
}

export interface ZeropsSourceClient {
	resolveInstallationId(repoUrl: string, signal: AbortSignal): Promise<number | null>
	resolve(input: ZeropsSourceResolveInput): Promise<ZeropsSourceResolveResult>
	upload(input: ZeropsSourceUploadInput): Promise<ZeropsSourceUploadResult>
	cancel(input: ZeropsSourceCancelInput): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, label: string): Record<string, unknown> => {
	if (!isRecord(value)) throw new Error(`${label} must be an object`)
	return value
}

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
	const allowedKeys = new Set(allowed)
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key))
	if (unknownKey !== undefined) throw new Error(`${label} contains an unknown field`)
	const missingKey = allowed.find((key) => !(key in value))
	if (missingKey !== undefined) throw new Error(`${label} is missing field ${missingKey}`)
}

const protocolVersion = (value: Record<string, unknown>, label: string): typeof ZEROPS_SOURCE_PROTOCOL_VERSION => {
	if (value['protocolVersion'] !== ZEROPS_SOURCE_PROTOCOL_VERSION) throw new Error(`${label} has an unsupported protocolVersion`)
	return ZEROPS_SOURCE_PROTOCOL_VERSION
}

const boundedString = (value: unknown, label: string, maximum: number): string => {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
	}
	return value
}

const identifier = (value: unknown, label: string): string => {
	const parsed = boundedString(value, label, MAX_ID_LENGTH)
	if (!ID_PATTERN.test(parsed)) throw new Error(`${label} contains invalid characters`)
	return parsed
}

const ref = (value: unknown, label: string): string => {
	const parsed = boundedString(value, label, MAX_REF_LENGTH)
	if (COMMIT_SHA_PATTERN.test(parsed)) return parsed
	const hasForbiddenCharacter = [...parsed].some((character) => {
		const code = character.charCodeAt(0)
		return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)
	})
	const components = parsed.split('/')
	if (
		parsed.startsWith('-')
		|| parsed.trim() !== parsed
		|| parsed === '@'
		|| parsed.includes('..')
		|| parsed.includes('@{')
		|| parsed.includes('//')
		|| parsed.endsWith('/')
		|| parsed.endsWith('.')
		|| hasForbiddenCharacter
		|| components.some((component) => component === '' || component.startsWith('.') || component.endsWith('.lock'))
	) {
		throw new Error(`${label} must be a safe Git ref or lowercase commit digest`)
	}
	return parsed
}

const commitSha = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) throw new Error(`${label} must be a lowercase 40- or 64-character hex digest`)
	return value
}

const sha256 = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase 64-character hex digest`)
	return value
}

const installationId = (value: unknown, label: string): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
	return value
}

const optionalCommitSha = (value: unknown, label: string): string | undefined => value === undefined ? undefined : commitSha(value, label)

const optionalInstallationId = (value: unknown, label: string): number | undefined => value === undefined ? undefined : installationId(value, label)

const repository = (value: unknown, label: string): ZeropsSourceRepository => {
	const parsed = record(value, label)
	exactKeys(parsed, ['owner', 'name'], label)
	const owner = boundedString(parsed['owner'], `${label}.owner`, 39)
	const name = boundedString(parsed['name'], `${label}.name`, 100)
	if (!GITHUB_OWNER_PATTERN.test(owner)) throw new Error(`${label}.owner must be a normalized lowercase GitHub owner`)
	if (!GITHUB_REPOSITORY_PATTERN.test(name) || name === '.' || name === '..') {
		throw new Error(`${label}.name must be a normalized lowercase GitHub repository name`)
	}
	return { owner, name }
}

const descriptor = (value: unknown, label: string): ZeropsSourceDescriptor => {
	const parsed = record(value, label)
	exactKeys(parsed, ['path', 'sha256'], label)
	if (parsed['path'] !== 'zerops.yaml') throw new Error(`${label}.path must be zerops.yaml`)
	return { path: 'zerops.yaml', sha256: sha256(parsed['sha256'], `${label}.sha256`) }
}

const optionalFields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void => {
	const allowed = [...required, ...optional]
	const unknownKey = Object.keys(value).find((key) => !allowed.includes(key))
	if (unknownKey !== undefined) throw new Error(`${label} contains an unknown field`)
	const missingKey = required.find((key) => !(key in value))
	if (missingKey !== undefined) throw new Error(`${label} is missing field ${missingKey}`)
	for (const key of optional) {
		if (key in value && value[key] === undefined) throw new Error(`${label}.${key} must be omitted instead of undefined`)
	}
}

/** Validate only credential-safe URL structure; the source runtime owns the exact Zerops destination allowlist. */
const uploadUrl = (value: unknown, label: string): string => {
	const candidate = boundedString(value, label, MAX_UPLOAD_URL_LENGTH)
	if (/\s/u.test(candidate) || candidate.includes('#')) throw new Error(`${label} must be a signed HTTPS URL`)
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error(`${label} must be a signed HTTPS URL`)
	}
	if (
		parsed.protocol !== 'https:'
		|| parsed.username !== ''
		|| parsed.password !== ''
		|| parsed.hash !== ''
		|| parsed.search === ''
	) {
		throw new Error(`${label} must be a signed HTTPS URL without userinfo or fragment`)
	}
	return candidate
}

export function normalizeZeropsSourceRepository(repoUrl: string): ZeropsSourceRepository {
	if (/\s/u.test(repoUrl) || /\p{Cc}/u.test(repoUrl)) {
		throw new Error('source repository URL must be a canonical GitHub repository URL')
	}
	const candidate = repoUrl.startsWith('github.com/') ? `https://${repoUrl}` : repoUrl
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error('source repository URL must be a canonical GitHub repository URL')
	}
	if (
		parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port !== '' || parsed.username !== '' || parsed.password !== ''
		|| parsed.search !== '' || parsed.hash !== ''
	) {
		throw new Error('source repository URL must be an HTTPS GitHub URL without credentials, port, query, or fragment')
	}
	const segments = parsed.pathname.split('/')
	if (segments.length !== 3 || segments[0] !== '') throw new Error('source repository URL must identify one GitHub repository')
	const owner = segments[1]
	const rawName = segments[2]
	if (owner === undefined || rawName === undefined) throw new Error('source repository URL must identify one GitHub repository')
	const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
	return repository({ owner: owner.toLowerCase(), name: name.toLowerCase() }, 'source repository')
}

export function decodeZeropsSourceResolveInstallationRequest(value: unknown): ZeropsSourceResolveInstallationRequestV1 {
	const parsed = record(value, 'source resolve-installation request')
	exactKeys(parsed, ['protocolVersion', 'repository'], 'source resolve-installation request')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve-installation request'),
		repository: repository(parsed['repository'], 'source resolve-installation request.repository'),
	}
}

export function buildZeropsSourceResolveInstallationRequest(repoUrl: string): ZeropsSourceResolveInstallationRequestV1 {
	return decodeZeropsSourceResolveInstallationRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		repository: normalizeZeropsSourceRepository(repoUrl),
	})
}

export function decodeZeropsSourceResolveInstallationResponse(value: unknown): ZeropsSourceResolveInstallationResponseV1 {
	const parsed = record(value, 'source resolve-installation response')
	exactKeys(parsed, ['protocolVersion', 'githubInstallationId'], 'source resolve-installation response')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve-installation response'),
		githubInstallationId: parsed['githubInstallationId'] === null
			? null
			: installationId(parsed['githubInstallationId'], 'source resolve-installation response.githubInstallationId'),
	}
}

export function buildZeropsSourceResolveInstallationResponse(githubInstallationId: number | null): ZeropsSourceResolveInstallationResponseV1 {
	return decodeZeropsSourceResolveInstallationResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, githubInstallationId })
}

export function decodeZeropsSourceResolveRequest(value: unknown): ZeropsSourceResolveRequestV1 {
	const parsed = record(value, 'source resolve request')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'repository', 'requestedRef', 'descriptorSha256'],
		['expectedCommitSha', 'githubInstallationId'],
		'source resolve request',
	)
	const expected = optionalCommitSha(parsed['expectedCommitSha'], 'source resolve request.expectedCommitSha')
	const installation = optionalInstallationId(parsed['githubInstallationId'], 'source resolve request.githubInstallationId')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve request'),
		runId: identifier(parsed['runId'], 'source resolve request.runId'),
		repository: repository(parsed['repository'], 'source resolve request.repository'),
		requestedRef: ref(parsed['requestedRef'], 'source resolve request.requestedRef'),
		...(expected !== undefined ? { expectedCommitSha: expected } : {}),
		...(installation !== undefined ? { githubInstallationId: installation } : {}),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve request.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveRequest(input: ZeropsSourceResolveInput): ZeropsSourceResolveRequestV1 {
	return decodeZeropsSourceResolveRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		repository: input.repository,
		requestedRef: input.requestedRef,
		...(input.expectedCommitSha !== undefined ? { expectedCommitSha: input.expectedCommitSha } : {}),
		...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
		descriptorSha256: input.descriptorSha256,
	})
}

export function decodeZeropsSourceResolveResponse(value: unknown): ZeropsSourceResolveResponseV1 {
	const parsed = record(value, 'source resolve response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'commitSha', 'descriptorSha256'], 'source resolve response')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve response'),
		runId: identifier(parsed['runId'], 'source resolve response.runId'),
		commitSha: commitSha(parsed['commitSha'], 'source resolve response.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve response.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveResponse(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV1 {
	return decodeZeropsSourceResolveResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceUploadRequest(value: unknown): ZeropsSourceUploadRequestV1 {
	const parsed = record(value, 'source upload request')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'appVersionId', 'repository', 'commitSha', 'uploadUrl', 'descriptor'],
		['githubInstallationId'],
		'source upload request',
	)
	const installation = optionalInstallationId(parsed['githubInstallationId'], 'source upload request.githubInstallationId')
	return {
		protocolVersion: protocolVersion(parsed, 'source upload request'),
		runId: identifier(parsed['runId'], 'source upload request.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload request.appVersionId'),
		repository: repository(parsed['repository'], 'source upload request.repository'),
		commitSha: commitSha(parsed['commitSha'], 'source upload request.commitSha'),
		...(installation !== undefined ? { githubInstallationId: installation } : {}),
		uploadUrl: uploadUrl(parsed['uploadUrl'], 'source upload request.uploadUrl'),
		descriptor: descriptor(parsed['descriptor'], 'source upload request.descriptor'),
	}
}

export function buildZeropsSourceUploadRequest(input: ZeropsSourceUploadInput): ZeropsSourceUploadRequestV1 {
	return decodeZeropsSourceUploadRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		appVersionId: input.appVersionId,
		repository: input.repository,
		commitSha: input.commitSha,
		...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
		uploadUrl: input.uploadUrl,
		descriptor: input.descriptor,
	})
}

export function decodeZeropsSourceUploadResponse(value: unknown): ZeropsSourceUploadResponseV1 {
	const parsed = record(value, 'source upload response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId', 'commitSha', 'descriptorSha256'], 'source upload response')
	return {
		protocolVersion: protocolVersion(parsed, 'source upload response'),
		runId: identifier(parsed['runId'], 'source upload response.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload response.appVersionId'),
		commitSha: commitSha(parsed['commitSha'], 'source upload response.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source upload response.descriptorSha256'),
	}
}

export function buildZeropsSourceUploadResponse(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV1 {
	return decodeZeropsSourceUploadResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceCancelRequest(value: unknown): ZeropsSourceCancelRequestV1 {
	const parsed = record(value, 'source cancel request')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId'], 'source cancel request')
	return {
		protocolVersion: protocolVersion(parsed, 'source cancel request'),
		runId: identifier(parsed['runId'], 'source cancel request.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source cancel request.appVersionId'),
	}
}

export function buildZeropsSourceCancelRequest(input: ZeropsSourceCancelInput): ZeropsSourceCancelRequestV1 {
	return decodeZeropsSourceCancelRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		appVersionId: input.appVersionId,
	})
}

export function decodeZeropsSourceCancelResponse(value: unknown): ZeropsSourceCancelResponseV1 {
	const parsed = record(value, 'source cancel response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId'], 'source cancel response')
	return {
		protocolVersion: protocolVersion(parsed, 'source cancel response'),
		runId: identifier(parsed['runId'], 'source cancel response.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source cancel response.appVersionId'),
	}
}

export function buildZeropsSourceCancelResponse(result: ZeropsSourceCancelResult): ZeropsSourceCancelResponseV1 {
	return decodeZeropsSourceCancelResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

const includesString = <T extends string>(values: readonly T[], value: unknown): value is T =>
	typeof value === 'string' && values.some((entry) => entry === value)

export function decodeZeropsSourceErrorEnvelope(value: unknown): ZeropsSourceErrorEnvelope {
	const parsed = record(value, 'source error response')
	exactKeys(parsed, ['error'], 'source error response')
	const error = record(parsed['error'], 'source error response.error')
	exactKeys(error, ['code', 'stage', 'retryable'], 'source error response.error')
	if (!includesString(ZEROPS_SOURCE_ERROR_CODES, error['code'])) throw new Error('source error response.error.code is invalid')
	if (!includesString(ZEROPS_SOURCE_ERROR_STAGES, error['stage'])) throw new Error('source error response.error.stage is invalid')
	if (typeof error['retryable'] !== 'boolean') throw new Error('source error response.error.retryable must be boolean')
	return { error: { code: error['code'], stage: error['stage'], retryable: error['retryable'] } }
}

export function buildZeropsSourceErrorEnvelope(
	code: ZeropsSourceErrorCode,
	stage: ZeropsSourceErrorStage,
	retryable: boolean,
): ZeropsSourceErrorEnvelope {
	return decodeZeropsSourceErrorEnvelope({ error: { code, stage, retryable } })
}
