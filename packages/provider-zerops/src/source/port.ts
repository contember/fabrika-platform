import type { ZeropsSourceRepository } from './types'

/** A private source names its connection; an installation id alone never selects a credential (ADR-0029). */
export interface ZeropsSourcePrivateBinding {
	readonly connectionId: string
	readonly installationId: number
}

export interface ZeropsSourceResolveInput {
	readonly repository: ZeropsSourceRepository
	readonly requestedRef: string
	readonly expectedCommitSha?: string
	readonly privateBinding?: ZeropsSourcePrivateBinding
	readonly descriptorSha256: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceResolution {
	readonly commitSha: string
	readonly descriptorSha256: string
}

/** ADR-0045: platform archives are anonymous, tree-prechecked, keep relative symlinks. */
export type ZeropsSourceArchive =
	| { readonly kind: 'application'; readonly privateBinding?: ZeropsSourcePrivateBinding }
	| { readonly kind: 'platform' }

export interface ZeropsSourceUploadInput {
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly archive: ZeropsSourceArchive
	/** A credential in transit: never logged, persisted, or returned in an error. */
	readonly uploadUrl: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceUploadResult {
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly entryCount: number
	readonly expandedBytes: number
}

/** The GitHub source the Zerops composition injects; Control implements it in process. Callers verify what it returns. */
export interface ZeropsSourcePort {
	resolve(input: ZeropsSourceResolveInput): Promise<ZeropsSourceResolution>
	upload(input: ZeropsSourceUploadInput): Promise<ZeropsSourceUploadResult>
}
