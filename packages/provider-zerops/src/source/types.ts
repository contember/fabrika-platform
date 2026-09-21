import { ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, ZEROPS_SOURCE_PROTOCOL_VERSION, ZEROPS_SOURCE_PROTOCOL_VERSION_V2 } from './constants'

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
	| 'resolve'
	| 'archive'
	| 'upload'
	| 'cancel'
	| 'credentials'

export const ZEROPS_SOURCE_ERROR_STAGES: readonly ZeropsSourceErrorStage[] = [
	'authenticate',
	'validate',
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
	resolve(input: ZeropsSourceResolveInput): Promise<ZeropsSourceResolveResult>
	upload(input: ZeropsSourceUploadInput): Promise<ZeropsSourceUploadResult>
	cancel(input: ZeropsSourceCancelInput): Promise<void>
}

/** Keyed source operations; the unkeyed v1 wire remains the anonymous public-repository path. */
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
	configureWebhook(input: ZeropsSourceWebhookConfigureInput): Promise<ZeropsSourceWebhookConfigureResponseV1>
	verifyInstallations(input: ZeropsSourceInstallationsVerifyInput): Promise<ZeropsSourceInstallationsVerifyResponseV1>
}

/** Keyed credential operations — the only way a private credential reaches `source`. */
export interface ZeropsSourceCredentialManagerV2 {
	activateV2(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV2>
	statusV2(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV2>
}
