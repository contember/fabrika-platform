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
	/**
	 * The size of every part but the last: a multiple of `MIN_SOURCE_PART_BYTES` (256 KiB, Cloud Storage's chunk unit)
	 * up to `MAX_SOURCE_PART_BYTES`. An S3 writer picks at least 5 MiB, an Azure writer at most its service version's block.
	 */
	readonly partBytes: number
	/**
	 * Stores part `index`, counted from 0: every part but the last, each exactly `partBytes`. Called in order, one call at
	 * a time. The writer may keep `bytes`; the transport never touches them again. It must not make the object exist: a
	 * Cloud Storage writer sends each as a chunk without the total size.
	 */
	writePart(index: number, bytes: Uint8Array, signal: AbortSignal): Promise<void>
	/**
	 * Stores the last part (`last`: 1 to `partBytes` bytes, empty only for an empty archive) and makes all `parts` one
	 * object of `bytes` bytes. Called once, and only after the archive's verdict passed, so a rejected repository never
	 * becomes an object. Read the whole answer: S3's `CompleteMultipartUpload` can answer 200 with an error in its body.
	 */
	complete(upload: { readonly last: Uint8Array; readonly parts: number; readonly bytes: number }, signal: AbortSignal): Promise<void>
	/**
	 * Drops what may be stored, after `writePart` or `complete` was called and the upload then failed or was cancelled:
	 * the parts, and an object a failed `complete` may have made anyway (its answer can be lost after the commit). Best
	 * effort, within its signal; the archive that object would hold passed its verdict.
	 */
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
