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

/**
 * A provider's writer of an upload in parts, for a destination that takes no stream of unknown length in one request:
 * an S3 multipart upload, Azure blocks under one SAS, a Cloud Storage resumable session. It holds its own credentials
 * and makes its own requests (no redirect followed), and an error it raises is never forwarded: the transport reports
 * `upload_failed`.
 */
export interface SourcePartWriter {
	/** Every part but the last has this many bytes: from `MIN_SOURCE_PART_BYTES` to `MAX_SOURCE_PART_BYTES`. */
	readonly partBytes: number
	/** Stores part `index`, counted from 0. Called in order, one call at a time; only an empty archive has an empty part. */
	writePart(index: number, bytes: Uint8Array, signal: AbortSignal): Promise<void>
	/** Makes the parts one object. Called once, after the last part and only once the archive's verdict passed. */
	complete(upload: { readonly parts: number; readonly bytes: number }, signal: AbortSignal): Promise<void>
	/** Drops what was stored, after a part was written and the upload then failed or was cancelled. Best effort. */
	abort(signal: AbortSignal): Promise<void>
}

interface SourceUploadCommon {
	readonly repository: SourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly archive: SourceArchiveKind
	readonly signal: AbortSignal
}

/** One streamed PUT of the whole archive to a URL the composition's destination check accepts. */
interface SourceUploadToUrl {
	/** A credential in transit: never logged, persisted, or returned in an error. */
	readonly uploadUrl: string
	/**
	 * Present for a dev sandbox: `uploadUrl` is the sandbox host's file endpoint for one sandbox, and the PUT carries this
	 * bearer. A credential in transit, like `uploadUrl`.
	 */
	readonly uploadBearer?: string
	readonly parts?: undefined
}

/** The archive in parts, handed to the provider's writer. */
interface SourceUploadInParts {
	readonly parts: SourcePartWriter
	readonly uploadUrl?: undefined
	readonly uploadBearer?: undefined
}

export type SourceUploadInput = SourceUploadCommon & (SourceUploadToUrl | SourceUploadInParts)

export interface SourceUploadResult {
	readonly commitSha: string
	readonly descriptorSha256: string
	/** The sha256 of the data file the archive carried; absent without one. */
	readonly dataFileSha256?: string
	readonly entryCount: number
	readonly expandedBytes: number
}
