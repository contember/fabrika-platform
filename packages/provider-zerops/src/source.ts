export const ZEROPS_SOURCE_PROTOCOL_VERSION = 1
export const ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH = '/v1/installations/resolve'
export const ZEROPS_SOURCE_RESOLVE_PATH = '/v1/source/resolve'
export const ZEROPS_SOURCE_UPLOAD_PATH = '/v1/source/upload'
export const ZEROPS_SOURCE_CANCEL_PATH = '/v1/source/cancel'
export const ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH = '/v1/source/credentials/activate'
export const ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH = '/v1/source/credentials/status'
export const ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH = '/v1/source/github/webhook/configure'
export const ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH = '/v1/source/github/installations/verify'
export const ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION = 1
export const ZEROPS_SOURCE_PROTOCOL_VERSION_V2 = 2
export const ZEROPS_SOURCE_RESOLVE_PATH_V2 = '/v2/source/resolve'
export const ZEROPS_SOURCE_UPLOAD_PATH_V2 = '/v2/source/upload'
export const ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2 = '/v2/source/credentials/activate'
export const ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2 = '/v2/source/credentials/status'
export const ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2 = 2
export const ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX = 'GITHUB_APP_CREDENTIALS_V2_'

const MAX_ID_LENGTH = 128
const MAX_REF_LENGTH = 255
const MAX_UPLOAD_URL_LENGTH = 4096
const MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES = 72 * 1024
const MAX_GITHUB_APP_PRIVATE_KEY_LENGTH = 64 * 1024
const MAX_WEBHOOK_URL_LENGTH = 2048
const MAX_WEBHOOK_SECRET_LENGTH = 4096
const MAX_INSTALLATION_REPOSITORIES = 100
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

export interface ZeropsSourceCredentialBundleV2 {
	readonly version: typeof ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2
	readonly connectionId: string
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

export interface ZeropsSourceCredentialActivateRequestV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly connectionId: string
	/** Canonical JSON that is byte-identical to the durable source environment value. */
	readonly credentialBundle: string
	readonly credentialSha256: string
}

export interface ZeropsSourceCredentialActivateResponseV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly connectionId: string
	readonly credentialVersion: typeof ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2
	readonly credentialSha256: string
	readonly githubApp: ZeropsSourceGitHubAppIdentityV1
}

export interface ZeropsSourceCredentialStatusRequestV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly connectionId: string
}

export interface ZeropsSourceCredentialAnonymousStatusResponseV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly connectionId: string
	readonly state: 'anonymous'
}

export interface ZeropsSourceCredentialActiveStatusResponseV2 extends ZeropsSourceCredentialActivateResponseV2 {
	readonly state: 'active'
}

export type ZeropsSourceCredentialStatusResponseV2 =
	| ZeropsSourceCredentialAnonymousStatusResponseV2
	| ZeropsSourceCredentialActiveStatusResponseV2

export interface ZeropsSourceWebhookConfigureInput {
	readonly connectionId: string
	readonly credentialSha256: string
	readonly url: string
	readonly secret: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceWebhookConfigureRequestV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly credentialSha256: string
	readonly url: string
	readonly secret: string
}

export interface ZeropsSourceWebhookConfigureResponseV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly credentialSha256: string
	readonly webhook: { readonly url: string; readonly contentType: 'json'; readonly insecureSsl: '0' }
}

export type ZeropsSourceInstallationScopeV1 =
	| { readonly kind: 'organization'; readonly organization: string }
	| { readonly kind: 'repositories'; readonly repositories: readonly ZeropsSourceRepository[] }

export interface ZeropsSourceInstallationsVerifyInput {
	readonly connectionId: string
	readonly credentialSha256: string
	readonly scope: ZeropsSourceInstallationScopeV1
	readonly signal: AbortSignal
}

export interface ZeropsSourceInstallationsVerifyRequestV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly credentialSha256: string
	readonly scope: ZeropsSourceInstallationScopeV1
}

export type ZeropsSourceInstallationVerificationV1 =
	| { readonly status: 'missing' }
	| {
		readonly status: 'installed'
		readonly installationId: number
		readonly accountLogin: string
		readonly repositorySelection: 'all' | 'selected'
	}

export interface ZeropsSourceInstallationsVerifyResponseV1 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION
	readonly connectionId: string
	readonly credentialSha256: string
	readonly installation: ZeropsSourceInstallationVerificationV1
}

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

export interface ZeropsSourcePrivateBindingV2 {
	readonly connectionId: string
	readonly installationId: number
}

export interface ZeropsSourceResolveRequestV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly runId: string
	readonly repository: ZeropsSourceRepository
	readonly requestedRef: string
	readonly expectedCommitSha?: string
	readonly privateBinding?: ZeropsSourcePrivateBindingV2
	readonly descriptorSha256: string
}

export interface ZeropsSourceResolveResponseV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly runId: string
	readonly commitSha: string
	readonly descriptorSha256: string
}

export interface ZeropsSourceUploadRequestV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly runId: string
	readonly appVersionId: string
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly privateBinding?: ZeropsSourcePrivateBindingV2
	readonly uploadUrl: string
	readonly descriptor: ZeropsSourceDescriptor
}

export interface ZeropsSourceUploadResponseV2 {
	readonly protocolVersion: typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2
	readonly runId: string
	readonly appVersionId: string
	readonly commitSha: string
	readonly descriptorSha256: string
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

export interface ZeropsSourceResolveInputV2 {
	readonly runId: string
	readonly repository: ZeropsSourceRepository
	readonly requestedRef: string
	readonly expectedCommitSha?: string
	readonly privateBinding?: ZeropsSourcePrivateBindingV2
	readonly descriptorSha256: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceUploadInputV2 {
	readonly runId: string
	readonly appVersionId: string
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly privateBinding?: ZeropsSourcePrivateBindingV2
	readonly uploadUrl: string
	readonly descriptor: ZeropsSourceDescriptor
	readonly signal: AbortSignal
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

/** Keyed source operations are additive so legacy client implementations remain valid. */
export interface ZeropsSourceClientV2 {
	resolveV2(input: ZeropsSourceResolveInputV2): Promise<ZeropsSourceResolveResult>
	uploadV2(input: ZeropsSourceUploadInputV2): Promise<ZeropsSourceUploadResult>
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
	configureWebhook(input: ZeropsSourceWebhookConfigureInput): Promise<ZeropsSourceWebhookConfigureResponseV1>
	verifyInstallations(input: ZeropsSourceInstallationsVerifyInput): Promise<ZeropsSourceInstallationsVerifyResponseV1>
}

/** Keyed credential operations are additive so legacy credential managers remain valid. */
export interface ZeropsSourceCredentialManagerV2 {
	activateV2(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV2>
	statusV2(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV2>
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

const protocolVersionV2 = (value: Record<string, unknown>, label: string): typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2 => {
	if (value['protocolVersion'] !== ZEROPS_SOURCE_PROTOCOL_VERSION_V2) throw new Error(`${label} has an unsupported protocolVersion`)
	return ZEROPS_SOURCE_PROTOCOL_VERSION_V2
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

const sourceCredentialBundleValueV2 = (value: unknown): ZeropsSourceCredentialBundleV2 => {
	const parsed = record(value, 'source credential bundle v2')
	exactKeys(parsed, ['version', 'connectionId', 'githubAppId', 'privateKeyPem'], 'source credential bundle v2')
	if (parsed['version'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2) {
		throw new Error('source credential bundle v2 has an unsupported version')
	}
	const connectionId = identifier(parsed['connectionId'], 'source credential bundle v2.connectionId')
	const githubAppId = boundedString(parsed['githubAppId'], 'source credential bundle v2.githubAppId', 32)
	if (!GITHUB_APP_ID_PATTERN.test(githubAppId)) throw new Error('source credential bundle v2.githubAppId is invalid')
	const privateKeyPem = boundedString(
		parsed['privateKeyPem'],
		'source credential bundle v2.privateKeyPem',
		MAX_GITHUB_APP_PRIVATE_KEY_LENGTH,
	)
	if (!isCanonicalPrivateKeyPem(privateKeyPem)) throw new Error('source credential bundle v2.privateKeyPem is invalid')
	return { version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, connectionId, githubAppId, privateKeyPem }
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

export function buildZeropsSourceCredentialBundleV2(
	input: Omit<ZeropsSourceCredentialBundleV2, 'version'>,
): ZeropsSourceCredentialBundleV2 {
	return sourceCredentialBundleValueV2({ version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, ...input })
}

export function serializeZeropsSourceCredentialBundleV2(bundle: ZeropsSourceCredentialBundleV2): string {
	const parsed = sourceCredentialBundleValueV2(bundle)
	return JSON.stringify({
		version: parsed.version,
		connectionId: parsed.connectionId,
		githubAppId: parsed.githubAppId,
		privateKeyPem: parsed.privateKeyPem,
	})
}

export function decodeZeropsSourceCredentialBundleV2(value: unknown): ZeropsSourceCredentialBundleV2 {
	if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES) {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	let decoded: unknown
	try {
		decoded = JSON.parse(value)
	} catch {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	const bundle = sourceCredentialBundleValueV2(decoded)
	if (serializeZeropsSourceCredentialBundleV2(bundle) !== value) {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	return bundle
}

export async function sha256ZeropsSourceCredentialBundleV2(value: string): Promise<string> {
	decodeZeropsSourceCredentialBundleV2(value)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function zeropsSourceCredentialEnvV2(connectionId: string): Promise<string> {
	const canonicalConnectionId = identifier(connectionId, 'source credential connectionId')
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalConnectionId)))
	return `${ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX}${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const installationId = (value: unknown, label: string): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
	return value
}

const optionalCommitSha = (value: unknown, label: string): string | undefined => value === undefined ? undefined : commitSha(value, label)

const optionalInstallationId = (value: unknown, label: string): number | undefined => value === undefined ? undefined : installationId(value, label)

const privateBindingV2 = (value: unknown, label: string): ZeropsSourcePrivateBindingV2 => {
	const parsed = record(value, label)
	exactKeys(parsed, ['connectionId', 'installationId'], label)
	return {
		connectionId: identifier(parsed['connectionId'], `${label}.connectionId`),
		installationId: installationId(parsed['installationId'], `${label}.installationId`),
	}
}

const optionalPrivateBindingV2 = (value: unknown, label: string): ZeropsSourcePrivateBindingV2 | undefined =>
	value === undefined ? undefined : privateBindingV2(value, label)

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

export function decodeZeropsSourceCredentialActivateRequestV2(value: unknown): ZeropsSourceCredentialActivateRequestV2 {
	const parsed = record(value, 'source credential activate request v2')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialBundle', 'credentialSha256'],
		'source credential activate request v2',
	)
	const connectionId = identifier(parsed['connectionId'], 'source credential activate request v2.connectionId')
	const credentialBundle = boundedString(
		parsed['credentialBundle'],
		'source credential activate request v2.credentialBundle',
		MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES,
	)
	const bundle = decodeZeropsSourceCredentialBundleV2(credentialBundle)
	if (bundle.connectionId !== connectionId) throw new Error('source credential activate request v2 connectionId does not match its bundle')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential activate request v2'),
		connectionId,
		credentialBundle,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate request v2.credentialSha256'),
	}
}

export function buildZeropsSourceCredentialActivateRequestV2(
	input: ZeropsSourceCredentialActivateInput,
): ZeropsSourceCredentialActivateRequestV2 {
	return decodeZeropsSourceCredentialActivateRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		connectionId: input.connectionId,
		credentialBundle: input.credentialBundle,
		credentialSha256: input.credentialSha256,
	})
}

export function decodeZeropsSourceCredentialActivateResponseV2(value: unknown): ZeropsSourceCredentialActivateResponseV2 {
	const parsed = record(value, 'source credential activate response v2')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential activate response v2',
	)
	if (parsed['credentialVersion'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2) {
		throw new Error('source credential activate response v2 has an unsupported credentialVersion')
	}
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential activate response v2'),
		connectionId: identifier(parsed['connectionId'], 'source credential activate response v2.connectionId'),
		credentialVersion: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate response v2.credentialSha256'),
		githubApp: githubAppIdentity(parsed['githubApp'], 'source credential activate response v2.githubApp'),
	}
}

export function buildZeropsSourceCredentialActivateResponseV2(
	input: Omit<ZeropsSourceCredentialActivateResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialActivateResponseV2 {
	return decodeZeropsSourceCredentialActivateResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}

export function decodeZeropsSourceCredentialStatusRequestV2(value: unknown): ZeropsSourceCredentialStatusRequestV2 {
	const parsed = record(value, 'source credential status request v2')
	exactKeys(parsed, ['protocolVersion', 'connectionId'], 'source credential status request v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential status request v2'),
		connectionId: identifier(parsed['connectionId'], 'source credential status request v2.connectionId'),
	}
}

export function buildZeropsSourceCredentialStatusRequestV2(
	input: ZeropsSourceCredentialStatusInput,
): ZeropsSourceCredentialStatusRequestV2 {
	return decodeZeropsSourceCredentialStatusRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		connectionId: input.connectionId,
	})
}

export function decodeZeropsSourceCredentialStatusResponseV2(value: unknown): ZeropsSourceCredentialStatusResponseV2 {
	const parsed = record(value, 'source credential status response v2')
	if (parsed['state'] === 'anonymous') {
		exactKeys(parsed, ['protocolVersion', 'connectionId', 'state'], 'source credential status response v2')
		return {
			protocolVersion: protocolVersionV2(parsed, 'source credential status response v2'),
			connectionId: identifier(parsed['connectionId'], 'source credential status response v2.connectionId'),
			state: 'anonymous',
		}
	}
	if (parsed['state'] !== 'active') throw new Error('source credential status response v2.state is invalid')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'state', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential status response v2',
	)
	const active = decodeZeropsSourceCredentialActivateResponseV2({
		protocolVersion: parsed['protocolVersion'],
		connectionId: parsed['connectionId'],
		credentialVersion: parsed['credentialVersion'],
		credentialSha256: parsed['credentialSha256'],
		githubApp: parsed['githubApp'],
	})
	return { ...active, state: 'active' }
}

export function buildZeropsSourceCredentialStatusResponseV2(
	input:
		| { readonly connectionId: string; readonly state: 'anonymous' }
		| Omit<ZeropsSourceCredentialActiveStatusResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialStatusResponseV2 {
	return decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}

const webhookUrl = (value: unknown, label: string): string => {
	const candidate = boundedString(value, label, MAX_WEBHOOK_URL_LENGTH)
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error(`${label} must be a secure URL`)
	}
	if (
		parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
		|| parsed.pathname !== '/webhooks/github' || parsed.hostname === '' || candidate !== parsed.href
	) throw new Error(`${label} must be an exact secure GitHub webhook URL`)
	return candidate
}

const webhookSecret = (value: unknown, label: string): string => {
	const secret = boundedString(value, label, MAX_WEBHOOK_SECRET_LENGTH)
	if ([...secret].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
		throw new Error(`${label} is invalid`)
	}
	return secret
}

export function decodeZeropsSourceWebhookConfigureRequest(value: unknown): ZeropsSourceWebhookConfigureRequestV1 {
	const parsed = record(value, 'source webhook configure request')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'url', 'secret'], 'source webhook configure request')
	return {
		protocolVersion: protocolVersion(parsed, 'source webhook configure request'),
		connectionId: identifier(parsed['connectionId'], 'source webhook configure request.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source webhook configure request.credentialSha256'),
		url: webhookUrl(parsed['url'], 'source webhook configure request.url'),
		secret: webhookSecret(parsed['secret'], 'source webhook configure request.secret'),
	}
}

export function buildZeropsSourceWebhookConfigureRequest(input: ZeropsSourceWebhookConfigureInput): ZeropsSourceWebhookConfigureRequestV1 {
	return decodeZeropsSourceWebhookConfigureRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		url: input.url,
		secret: input.secret,
	})
}

export function decodeZeropsSourceWebhookConfigureResponse(value: unknown): ZeropsSourceWebhookConfigureResponseV1 {
	const parsed = record(value, 'source webhook configure response')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'webhook'], 'source webhook configure response')
	const webhook = record(parsed['webhook'], 'source webhook configure response.webhook')
	exactKeys(webhook, ['url', 'contentType', 'insecureSsl'], 'source webhook configure response.webhook')
	if (webhook['contentType'] !== 'json' || webhook['insecureSsl'] !== '0') throw new Error('source webhook configure response is insecure')
	return {
		protocolVersion: protocolVersion(parsed, 'source webhook configure response'),
		connectionId: identifier(parsed['connectionId'], 'source webhook configure response.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source webhook configure response.credentialSha256'),
		webhook: { url: webhookUrl(webhook['url'], 'source webhook configure response.webhook.url'), contentType: 'json', insecureSsl: '0' },
	}
}

export function buildZeropsSourceWebhookConfigureResponse(
	input: Omit<ZeropsSourceWebhookConfigureResponseV1, 'protocolVersion'>,
): ZeropsSourceWebhookConfigureResponseV1 {
	return decodeZeropsSourceWebhookConfigureResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}

const installationScope = (value: unknown, label: string): ZeropsSourceInstallationScopeV1 => {
	const parsed = record(value, label)
	if (parsed['kind'] === 'organization') {
		exactKeys(parsed, ['kind', 'organization'], label)
		const organization = boundedString(parsed['organization'], `${label}.organization`, 39).toLowerCase()
		if (!GITHUB_OWNER_PATTERN.test(organization)) throw new Error(`${label}.organization is invalid`)
		return { kind: 'organization', organization }
	}
	if (parsed['kind'] !== 'repositories') throw new Error(`${label}.kind is invalid`)
	exactKeys(parsed, ['kind', 'repositories'], label)
	if (!Array.isArray(parsed['repositories']) || parsed['repositories'].length === 0 || parsed['repositories'].length > MAX_INSTALLATION_REPOSITORIES) {
		throw new Error(`${label}.repositories is invalid`)
	}
	const repositories = parsed['repositories'].map((entry) => repository(entry, `${label}.repositories entry`))
	const keys = repositories.map((entry) => `${entry.owner}/${entry.name}`)
	if (new Set(keys).size !== keys.length) throw new Error(`${label}.repositories contains a duplicate`)
	return { kind: 'repositories', repositories }
}

export function decodeZeropsSourceInstallationsVerifyRequest(value: unknown): ZeropsSourceInstallationsVerifyRequestV1 {
	const parsed = record(value, 'source installations verify request')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'scope'], 'source installations verify request')
	return {
		protocolVersion: protocolVersion(parsed, 'source installations verify request'),
		connectionId: identifier(parsed['connectionId'], 'source installations verify request.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source installations verify request.credentialSha256'),
		scope: installationScope(parsed['scope'], 'source installations verify request.scope'),
	}
}

export function buildZeropsSourceInstallationsVerifyRequest(
	input: ZeropsSourceInstallationsVerifyInput,
): ZeropsSourceInstallationsVerifyRequestV1 {
	return decodeZeropsSourceInstallationsVerifyRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		scope: input.scope,
	})
}

const installationVerification = (value: unknown, label: string): ZeropsSourceInstallationVerificationV1 => {
	const parsed = record(value, label)
	if (parsed['status'] === 'missing') {
		exactKeys(parsed, ['status'], label)
		return { status: 'missing' }
	}
	if (parsed['status'] !== 'installed') throw new Error(`${label}.status is invalid`)
	exactKeys(parsed, ['status', 'installationId', 'accountLogin', 'repositorySelection'], label)
	const accountLogin = boundedString(parsed['accountLogin'], `${label}.accountLogin`, 100)
	if (!GITHUB_LOGIN_PATTERN.test(accountLogin)) throw new Error(`${label}.accountLogin is invalid`)
	const repositorySelection = parsed['repositorySelection']
	if (repositorySelection !== 'all' && repositorySelection !== 'selected') throw new Error(`${label}.repositorySelection is invalid`)
	return {
		status: 'installed',
		installationId: installationId(parsed['installationId'], `${label}.installationId`),
		accountLogin,
		repositorySelection,
	}
}

export function decodeZeropsSourceInstallationsVerifyResponse(value: unknown): ZeropsSourceInstallationsVerifyResponseV1 {
	const parsed = record(value, 'source installations verify response')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'installation'], 'source installations verify response')
	return {
		protocolVersion: protocolVersion(parsed, 'source installations verify response'),
		connectionId: identifier(parsed['connectionId'], 'source installations verify response.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source installations verify response.credentialSha256'),
		installation: installationVerification(parsed['installation'], 'source installations verify response.installation'),
	}
}

export function buildZeropsSourceInstallationsVerifyResponse(
	input: Omit<ZeropsSourceInstallationsVerifyResponseV1, 'protocolVersion'>,
): ZeropsSourceInstallationsVerifyResponseV1 {
	return decodeZeropsSourceInstallationsVerifyResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
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

export function decodeZeropsSourceResolveRequestV2(value: unknown): ZeropsSourceResolveRequestV2 {
	const parsed = record(value, 'source resolve request v2')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'repository', 'requestedRef', 'descriptorSha256'],
		['expectedCommitSha', 'privateBinding'],
		'source resolve request v2',
	)
	const expected = optionalCommitSha(parsed['expectedCommitSha'], 'source resolve request v2.expectedCommitSha')
	const binding = optionalPrivateBindingV2(parsed['privateBinding'], 'source resolve request v2.privateBinding')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source resolve request v2'),
		runId: identifier(parsed['runId'], 'source resolve request v2.runId'),
		repository: repository(parsed['repository'], 'source resolve request v2.repository'),
		requestedRef: ref(parsed['requestedRef'], 'source resolve request v2.requestedRef'),
		...(expected !== undefined ? { expectedCommitSha: expected } : {}),
		...(binding !== undefined ? { privateBinding: binding } : {}),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve request v2.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveRequestV2(input: ZeropsSourceResolveInputV2): ZeropsSourceResolveRequestV2 {
	return decodeZeropsSourceResolveRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		runId: input.runId,
		repository: input.repository,
		requestedRef: input.requestedRef,
		...(input.expectedCommitSha !== undefined ? { expectedCommitSha: input.expectedCommitSha } : {}),
		...(input.privateBinding !== undefined ? { privateBinding: input.privateBinding } : {}),
		descriptorSha256: input.descriptorSha256,
	})
}

export function decodeZeropsSourceResolveResponseV2(value: unknown): ZeropsSourceResolveResponseV2 {
	const parsed = record(value, 'source resolve response v2')
	exactKeys(parsed, ['protocolVersion', 'runId', 'commitSha', 'descriptorSha256'], 'source resolve response v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source resolve response v2'),
		runId: identifier(parsed['runId'], 'source resolve response v2.runId'),
		commitSha: commitSha(parsed['commitSha'], 'source resolve response v2.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve response v2.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveResponseV2(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV2 {
	return decodeZeropsSourceResolveResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
}

export function decodeZeropsSourceUploadRequestV2(value: unknown): ZeropsSourceUploadRequestV2 {
	const parsed = record(value, 'source upload request v2')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'appVersionId', 'repository', 'commitSha', 'uploadUrl', 'descriptor'],
		['privateBinding'],
		'source upload request v2',
	)
	const binding = optionalPrivateBindingV2(parsed['privateBinding'], 'source upload request v2.privateBinding')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source upload request v2'),
		runId: identifier(parsed['runId'], 'source upload request v2.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload request v2.appVersionId'),
		repository: repository(parsed['repository'], 'source upload request v2.repository'),
		commitSha: commitSha(parsed['commitSha'], 'source upload request v2.commitSha'),
		...(binding !== undefined ? { privateBinding: binding } : {}),
		uploadUrl: uploadUrl(parsed['uploadUrl'], 'source upload request v2.uploadUrl'),
		descriptor: descriptor(parsed['descriptor'], 'source upload request v2.descriptor'),
	}
}

export function buildZeropsSourceUploadRequestV2(input: ZeropsSourceUploadInputV2): ZeropsSourceUploadRequestV2 {
	return decodeZeropsSourceUploadRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		runId: input.runId,
		appVersionId: input.appVersionId,
		repository: input.repository,
		commitSha: input.commitSha,
		...(input.privateBinding !== undefined ? { privateBinding: input.privateBinding } : {}),
		uploadUrl: input.uploadUrl,
		descriptor: input.descriptor,
	})
}

export function decodeZeropsSourceUploadResponseV2(value: unknown): ZeropsSourceUploadResponseV2 {
	const parsed = record(value, 'source upload response v2')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId', 'commitSha', 'descriptorSha256'], 'source upload response v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source upload response v2'),
		runId: identifier(parsed['runId'], 'source upload response v2.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload response v2.appVersionId'),
		commitSha: commitSha(parsed['commitSha'], 'source upload response v2.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source upload response v2.descriptorSha256'),
	}
}

export function buildZeropsSourceUploadResponseV2(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV2 {
	return decodeZeropsSourceUploadResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
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
