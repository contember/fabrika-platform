export interface SourceRepository {
	readonly owner: string
	readonly name: string
}

/** The repository-root descriptor the provider binds a deploy to: its path and its size bound. */
export interface SourceDescriptorRule {
	readonly path: string
	readonly maxBytes: number
}

/** A private operation names its connection; an installation id alone never selects a credential (ADR-0029). */
export interface SourcePrivateBinding {
	readonly connectionId: string
	readonly installationId: number
}

/** Platform archives are anonymous, tree-prechecked, and keep relative symlinks. */
export type SourceArchiveKind =
	| { readonly kind: 'application'; readonly privateBinding?: SourcePrivateBinding }
	| { readonly kind: 'platform' }

export interface SourceResolveInput {
	readonly repository: SourceRepository
	readonly requestedRef: string
	readonly expectedCommitSha?: string
	readonly privateBinding?: SourcePrivateBinding
	readonly descriptorSha256: string
	readonly signal: AbortSignal
}

export interface SourceResolution {
	readonly commitSha: string
	readonly descriptorSha256: string
}

export interface SourceUploadInput {
	readonly repository: SourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly archive: SourceArchiveKind
	/** A credential in transit: never logged, persisted, or returned in an error. */
	readonly uploadUrl: string
	readonly signal: AbortSignal
}

export interface SourceUploadResult {
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly entryCount: number
	readonly expandedBytes: number
}
