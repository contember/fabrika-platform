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

/**
 * The one generated file a platform archive may carry beside the commit (ADR-0045): data the build reads, never code.
 * Its path must be one the commit does not hold, as a file, a directory or a link.
 */
export interface SourceDataFile {
	readonly path: string
	readonly contents: string
}

/** Platform archives are anonymous, tree-prechecked, and keep relative symlinks. */
export type SourceArchiveKind =
	| { readonly kind: 'application'; readonly privateBinding?: SourcePrivateBinding }
	| { readonly kind: 'platform'; readonly dataFile?: SourceDataFile }

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
	/** The sha256 of the data file the archive carried; absent without one. */
	readonly dataFileSha256?: string
	readonly entryCount: number
	readonly expandedBytes: number
}
