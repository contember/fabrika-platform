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

/** ADR-0045: the one generated data file a platform archive carries beside the exact commit, at a path the commit lacks. */
export interface ZeropsSourceDataFile {
	readonly path: string
	readonly contents: string
}

/** ADR-0045: platform archives are anonymous, tree-prechecked, keep relative symlinks. */
export type ZeropsSourceArchive =
	| { readonly kind: 'application'; readonly privateBinding?: ZeropsSourcePrivateBinding }
	| { readonly kind: 'platform'; readonly dataFile?: ZeropsSourceDataFile }

export interface ZeropsSourceUploadInput {
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly archive: ZeropsSourceArchive
	/** A credential in transit: never logged, persisted, or returned in an error. */
	readonly uploadUrl: string
	/**
	 * Present for a dev sandbox: `uploadUrl` is the sandbox host's file endpoint for one sandbox, and the PUT carries this
	 * bearer. A credential in transit, like `uploadUrl`.
	 */
	readonly uploadBearer?: string
	readonly signal: AbortSignal
}

export interface ZeropsSourceUploadResult {
	readonly commitSha: string
	readonly descriptorSha256: string
	/** The sha256 of the data file the archive carried; absent without one. */
	readonly dataFileSha256?: string
	readonly entryCount: number
	readonly expandedBytes: number
}

/** The GitHub source the Zerops composition injects; Control implements it in process. Callers verify what it returns. */
export interface ZeropsSourcePort {
	resolve(input: ZeropsSourceResolveInput): Promise<ZeropsSourceResolution>
	upload(input: ZeropsSourceUploadInput): Promise<ZeropsSourceUploadResult>
}

/**
 * The source refused a read for GitHub's rate limit. The read succeeds again once the limit resets, so a namespace
 * mutation that hits it stays retryable. The message is the user's: whose limit, when it resets, how to avoid it.
 */
export class ZeropsSourceRateLimitedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ZeropsSourceRateLimitedError'
	}
}
