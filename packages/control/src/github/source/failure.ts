export type SourceFailureCode =
	| 'invalid_request'
	| 'installation_not_found'
	| 'ref_not_found'
	| 'commit_mismatch'
	| 'descriptor_missing'
	| 'descriptor_mismatch'
	| 'archive_rejected'
	| 'upload_rejected'
	| 'upload_failed'
	/** The sandbox host refused the archive for its size (413); a smaller repository is the remedy, not a retry. */
	| 'upload_too_large'
	| 'credentials_invalid'
	/** The GitHub App belongs to a personal account; Control connects an organization's App only. */
	| 'app_owner_not_organization'
	| 'rate_limited'
	| 'cancelled'
	| 'internal'

export type SourceFailureStage = 'resolve' | 'archive' | 'upload' | 'credentials'

/** A source failure names its stage and class only; upstream text and URLs can carry credentials. */
export class SourceFailure extends Error {
	constructor(
		readonly code: SourceFailureCode,
		readonly stage: SourceFailureStage,
		message = `source ${stage} failed (${code})`,
	) {
		super(message)
		this.name = 'SourceFailure'
	}
}

/** What a descriptor mismatch names: the file, the commit it was read at, and both digests. A digest is not a secret. */
export interface SourceDescriptorMismatchDetail {
	readonly path: string
	readonly commitSha: string
	/** The digest the environment's registered manifest names. */
	readonly expectedSha256: string
	/** The digest of the file at the commit. */
	readonly actualSha256: string
}

/**
 * The descriptor at the commit is not the one the environment's manifest registered. A retry fails the same way: the
 * remedy is a manifest built from that commit, so the message names the file, the commit and both digests, and a caller
 * that knows the environment adds the commands that send it. The code stays `descriptor_mismatch`.
 */
export class SourceDescriptorMismatch extends SourceFailure {
	constructor(
		stage: SourceFailureStage,
		readonly detail: SourceDescriptorMismatchDetail,
		readonly remedy?: string,
	) {
		super(
			'descriptor_mismatch',
			stage,
			`source ${stage} failed (descriptor_mismatch): ${detail.path} at commit ${detail.commitSha} has sha256 ${detail.actualSha256}, `
				+ `but the environment's registered manifest names sha256 ${detail.expectedSha256}${remedy === undefined ? '' : `; ${remedy}`}`,
		)
	}

	withRemedy(remedy: string): SourceDescriptorMismatch {
		return new SourceDescriptorMismatch(this.stage, this.detail, remedy)
	}
}

/**
 * GitHub refused a read for its rate limit. The message is the user's: whose limit it was, when it resets, and how to
 * avoid it. An anonymous read counts against the address Control calls from, which other tenants of a cloud share.
 */
export class SourceRateLimited extends SourceFailure {
	constructor(
		stage: SourceFailureStage,
		readonly anonymous: boolean,
		readonly resetAt: Date | undefined,
	) {
		const resets = resetAt === undefined ? 'retry later' : `resets at ${resetAt.toISOString()}`
		super(
			'rate_limited',
			stage,
			anonymous
				? `GitHub rate limit for anonymous reads reached; ${resets}; connect the GitHub App to avoid it`
				: `GitHub rate limit for the GitHub App's reads reached; ${resets}`,
		)
	}
}

/**
 * A 429, or a 403 that says the limit is spent (`x-ratelimit-remaining: 0`) or when to come back (`retry-after`), is a
 * rate limit; any other refusal is not. The reset is `retry-after` when GitHub sends it, else `x-ratelimit-reset`.
 */
export function rateLimitFailure(
	response: Response,
	stage: SourceFailureStage,
	anonymous: boolean,
	now: () => number = Date.now,
): SourceRateLimited | null {
	const remaining = response.headers.get('x-ratelimit-remaining')
	const retryAfter = response.headers.get('retry-after')
	const limited = response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null))
	if (!limited) return null
	const reset = response.headers.get('x-ratelimit-reset')
	const resetAt = retryAfter !== null && /^\d{1,6}$/.test(retryAfter)
		? new Date(now() + Number(retryAfter) * 1000)
		: reset !== null && /^\d{1,12}$/.test(reset)
		? new Date(Number(reset) * 1000)
		: undefined
	return new SourceRateLimited(stage, anonymous, resetAt)
}

/** A failure of one step, reported at the stage of the operation that took it. Anything else passes unchanged. */
export function atStage(error: unknown, stage: SourceFailureStage): unknown {
	if (error instanceof SourceRateLimited) return new SourceRateLimited(stage, error.anonymous, error.resetAt)
	if (error instanceof SourceDescriptorMismatch) return new SourceDescriptorMismatch(stage, error.detail, error.remedy)
	if (error instanceof SourceFailure) return new SourceFailure(error.code, stage)
	return error
}

export function uploadTooLarge(): SourceFailure {
	return new SourceFailure('upload_too_large', 'upload', 'the source archive is larger than the sandbox host accepts (50 MiB)')
}

export function cancelled(stage: SourceFailureStage): SourceFailure {
	return new SourceFailure('cancelled', stage)
}

export function throwIfAborted(signal: AbortSignal, stage: SourceFailureStage): void {
	if (signal.aborted) throw cancelled(stage)
}
