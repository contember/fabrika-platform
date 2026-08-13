export const ZEROPS_SOURCE_PROTOCOL_VERSION = 1
export const ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH = '/v1/installations/resolve'
export const ZEROPS_SOURCE_RESOLVE_PATH = '/v1/source/resolve'
export const ZEROPS_SOURCE_UPLOAD_PATH = '/v1/source/upload'
export const ZEROPS_SOURCE_CANCEL_PATH = '/v1/source/cancel'
export const ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH = '/v1/source/credentials/activate'
export const ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH = '/v1/source/credentials/status'
export const ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION = 1

const MAX_ID_LENGTH = 128
const MAX_REF_LENGTH = 255
const MAX_UPLOAD_URL_LENGTH = 4096
const MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES = 72 * 1024
const MAX_GITHUB_APP_PRIVATE_KEY_LENGTH = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/
const GITHUB_APP_ID_PATTERN = /^[1-9][0-9]{0,31}$/
const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/

export interface ZeropsSourceCredentialBundleV1 {
	readonly version: typeof ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION
	readonly githubAppId: string
	readonly privateKeyPem: string
}

export interface ZeropsSourceGitHubAppIdentityV1 {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly owner: {
		readonly login: string
		readonly type: 'Organization'
	}
	readonly permissions: {
		readonly contents: 'read'
	}
	readonly events: readonly ['push']
}

export interface ZeropsSourceCredentialActivateRequestV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	/** Canonical JSON that is byte-identical to the durable source environment value. */
	readonly credentialBundle: string
	readonly credentialSha256: string
}

export interface ZeropsSourceCredentialActivateResponseV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly credentialVersion: typeof ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION
	readonly credentialSha256: string
	readonly githubApp: ZeropsSourceGitHubAppIdentityV1
}

export interface ZeropsSourceCredentialStatusRequestV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
}

export interface ZeropsSourceCredentialAnonymousStatusResponseV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly state: 'anonymous'
}

export interface ZeropsSourceCredentialActiveStatusResponseV1 extends ZeropsSourceCredentialActivateResponseV1 {
	readonly state: 'active'
}

export type ZeropsSourceCredentialStatusResponseV1 =
	| ZeropsSourceCredentialAnonymousStatusResponseV1
	| ZeropsSourceCredentialActiveStatusResponseV1

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
	| 'credentials_invalid'
	| 'credentials_conflict'
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
	'credentials_invalid',
	'credentials_conflict',
	'cancelled',
	'internal',
]

export type ZeropsSourceErrorStage =
	| 'authenticate'
	| 'validate'
	| 'resolve-installation'
	| 'resolve'
	| 'archive'
	| 'upload'
	| 'cancel'
	| 'credentials'

export const ZEROPS_SOURCE_ERROR_STAGES: readonly ZeropsSourceErrorStage[] = [
	'authenticate',
	'validate',
	'resolve-installation',
	'resolve',
	'archive',
	'upload',
	'cancel',
	'credentials',
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

export interface ZeropsSourceCredentialActivateInput {
	readonly connectionId: string
	readonly credentialBundle: string
	readonly credentialSha256: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceCredentialStatusInput {
	readonly connectionId: string
	readonly signal: AbortSignal
}

/** Credential management is separate from the deploy source client and is composed only in the authenticated admin flow. */
export interface ZeropsSourceCredentialManager {
	activate(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV1>
	status(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV1>
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

const sourceCredentialBundleValue = (value: unknown): ZeropsSourceCredentialBundleV1 => {
	const parsed = record(value, 'source credential bundle')
	exactKeys(parsed, ['version', 'githubAppId', 'privateKeyPem'], 'source credential bundle')
	if (parsed['version'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION) {
		throw new Error('source credential bundle has an unsupported version')
	}
	const githubAppId = boundedString(parsed['githubAppId'], 'source credential bundle.githubAppId', 32)
	if (!GITHUB_APP_ID_PATTERN.test(githubAppId)) throw new Error('source credential bundle.githubAppId is invalid')
	const privateKeyPem = boundedString(
		parsed['privateKeyPem'],
		'source credential bundle.privateKeyPem',
		MAX_GITHUB_APP_PRIVATE_KEY_LENGTH,
	)
	if (!isCanonicalPrivateKeyPem(privateKeyPem)) throw new Error('source credential bundle.privateKeyPem is invalid')
	return { version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION, githubAppId, privateKeyPem }
}

const isCanonicalPrivateKeyPem = (value: string): boolean => {
	const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\n([A-Za-z0-9+/=\n]+)\n-----END (RSA PRIVATE KEY|PRIVATE KEY)-----\n?$/.exec(value)
	if (match === null || match[1] !== match[3]) return false
	const body = match[2]
	if (body === undefined) return false
	const lines = body.split('\n')
	if (lines.some((line) => line.length === 0 || line.length > 64)) return false
	if (lines.slice(0, -1).some((line) => line.includes('='))) return false
	const encoded = lines.join('')
	if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
	try {
		const decoded = atob(encoded)
		return decoded.length > 0 && decoded.charCodeAt(0) === 0x30
	} catch {
		return false
	}
}

export function buildZeropsSourceCredentialBundle(
	input: Omit<ZeropsSourceCredentialBundleV1, 'version'>,
): ZeropsSourceCredentialBundleV1 {
	return sourceCredentialBundleValue({ version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION, ...input })
}

export function serializeZeropsSourceCredentialBundle(bundle: ZeropsSourceCredentialBundleV1): string {
	const parsed = sourceCredentialBundleValue(bundle)
	return JSON.stringify({ version: parsed.version, githubAppId: parsed.githubAppId, privateKeyPem: parsed.privateKeyPem })
}

export function decodeZeropsSourceCredentialBundle(value: unknown): ZeropsSourceCredentialBundleV1 {
	if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES) {
		throw new Error('source credential bundle must be bounded canonical JSON')
	}
	let decoded: unknown
	try {
		decoded = JSON.parse(value)
	} catch {
		throw new Error('source credential bundle must be bounded canonical JSON')
	}
	const bundle = sourceCredentialBundleValue(decoded)
	if (serializeZeropsSourceCredentialBundle(bundle) !== value) throw new Error('source credential bundle must be bounded canonical JSON')
	return bundle
}

export async function sha256ZeropsSourceCredentialBundle(value: string): Promise<string> {
	decodeZeropsSourceCredentialBundle(value)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

const githubAppIdentity = (value: unknown, label: string): ZeropsSourceGitHubAppIdentityV1 => {
	const parsed = record(value, label)
	exactKeys(parsed, ['id', 'slug', 'htmlUrl', 'public', 'owner', 'permissions', 'events'], label)
	const id = installationId(parsed['id'], `${label}.id`)
	const slug = boundedString(parsed['slug'], `${label}.slug`, 100)
	if (!GITHUB_APP_SLUG_PATTERN.test(slug)) throw new Error(`${label}.slug is invalid`)
	const htmlUrl = boundedString(parsed['htmlUrl'], `${label}.htmlUrl`, 2048)
	let parsedHtmlUrl: URL
	try {
		parsedHtmlUrl = new URL(htmlUrl)
	} catch {
		throw new Error(`${label}.htmlUrl is invalid`)
	}
	if (
		parsedHtmlUrl.protocol !== 'https:' || parsedHtmlUrl.hostname !== 'github.com' || parsedHtmlUrl.port !== ''
		|| parsedHtmlUrl.username !== '' || parsedHtmlUrl.password !== '' || parsedHtmlUrl.search !== '' || parsedHtmlUrl.hash !== ''
		|| parsedHtmlUrl.pathname !== `/apps/${slug}`
	) {
		throw new Error(`${label}.htmlUrl is invalid`)
	}
	if (typeof parsed['public'] !== 'boolean') throw new Error(`${label}.public must be boolean`)
	const owner = record(parsed['owner'], `${label}.owner`)
	exactKeys(owner, ['login', 'type'], `${label}.owner`)
	const login = boundedString(owner['login'], `${label}.owner.login`, 100)
	if (!GITHUB_LOGIN_PATTERN.test(login) || owner['type'] !== 'Organization') throw new Error(`${label}.owner is invalid`)
	const permissions = record(parsed['permissions'], `${label}.permissions`)
	exactKeys(permissions, ['contents'], `${label}.permissions`)
	if (permissions['contents'] !== 'read') throw new Error(`${label}.permissions is invalid`)
	if (!Array.isArray(parsed['events']) || parsed['events'].length !== 1 || parsed['events'][0] !== 'push') {
		throw new Error(`${label}.events is invalid`)
	}
	return {
		id,
		slug,
		htmlUrl,
		public: parsed['public'],
		owner: { login, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	}
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

export function decodeZeropsSourceCredentialActivateRequest(value: unknown): ZeropsSourceCredentialActivateRequestV1 {
	const parsed = record(value, 'source credential activate request')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialBundle', 'credentialSha256'],
		'source credential activate request',
	)
	const credentialBundle = boundedString(
		parsed['credentialBundle'],
		'source credential activate request.credentialBundle',
		MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES,
	)
	decodeZeropsSourceCredentialBundle(credentialBundle)
	return {
		protocolVersion: protocolVersion(parsed, 'source credential activate request'),
		connectionId: identifier(parsed['connectionId'], 'source credential activate request.connectionId'),
		credentialBundle,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate request.credentialSha256'),
	}
}

export function buildZeropsSourceCredentialActivateRequest(
	input: ZeropsSourceCredentialActivateInput,
): ZeropsSourceCredentialActivateRequestV1 {
	return decodeZeropsSourceCredentialActivateRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialBundle: input.credentialBundle,
		credentialSha256: input.credentialSha256,
	})
}

export function decodeZeropsSourceCredentialActivateResponse(value: unknown): ZeropsSourceCredentialActivateResponseV1 {
	const parsed = record(value, 'source credential activate response')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential activate response',
	)
	if (parsed['credentialVersion'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION) {
		throw new Error('source credential activate response has an unsupported credentialVersion')
	}
	return {
		protocolVersion: protocolVersion(parsed, 'source credential activate response'),
		connectionId: identifier(parsed['connectionId'], 'source credential activate response.connectionId'),
		credentialVersion: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate response.credentialSha256'),
		githubApp: githubAppIdentity(parsed['githubApp'], 'source credential activate response.githubApp'),
	}
}

export function buildZeropsSourceCredentialActivateResponse(
	input: Omit<ZeropsSourceCredentialActivateResponseV1, 'protocolVersion'>,
): ZeropsSourceCredentialActivateResponseV1 {
	return decodeZeropsSourceCredentialActivateResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}

export function decodeZeropsSourceCredentialStatusRequest(value: unknown): ZeropsSourceCredentialStatusRequestV1 {
	const parsed = record(value, 'source credential status request')
	exactKeys(parsed, ['protocolVersion', 'connectionId'], 'source credential status request')
	return {
		protocolVersion: protocolVersion(parsed, 'source credential status request'),
		connectionId: identifier(parsed['connectionId'], 'source credential status request.connectionId'),
	}
}

export function buildZeropsSourceCredentialStatusRequest(
	input: ZeropsSourceCredentialStatusInput,
): ZeropsSourceCredentialStatusRequestV1 {
	return decodeZeropsSourceCredentialStatusRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
	})
}

export function decodeZeropsSourceCredentialStatusResponse(value: unknown): ZeropsSourceCredentialStatusResponseV1 {
	const parsed = record(value, 'source credential status response')
	if (parsed['state'] === 'anonymous') {
		exactKeys(parsed, ['protocolVersion', 'connectionId', 'state'], 'source credential status response')
		return {
			protocolVersion: protocolVersion(parsed, 'source credential status response'),
			connectionId: identifier(parsed['connectionId'], 'source credential status response.connectionId'),
			state: 'anonymous',
		}
	}
	if (parsed['state'] !== 'active') throw new Error('source credential status response.state is invalid')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'state', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential status response',
	)
	const active = decodeZeropsSourceCredentialActivateResponse({
		protocolVersion: parsed['protocolVersion'],
		connectionId: parsed['connectionId'],
		credentialVersion: parsed['credentialVersion'],
		credentialSha256: parsed['credentialSha256'],
		githubApp: parsed['githubApp'],
	})
	return { ...active, state: 'active' }
}

export function buildZeropsSourceCredentialStatusResponse(
	input:
		| { readonly connectionId: string; readonly state: 'anonymous' }
		| Omit<ZeropsSourceCredentialActiveStatusResponseV1, 'protocolVersion'>,
): ZeropsSourceCredentialStatusResponseV1 {
	return decodeZeropsSourceCredentialStatusResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
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
