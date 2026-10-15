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
	| 'credentials_invalid'
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

export function cancelled(stage: SourceFailureStage): SourceFailure {
	return new SourceFailure('cancelled', stage)
}

export function throwIfAborted(signal: AbortSignal, stage: SourceFailureStage): void {
	if (signal.aborted) throw cancelled(stage)
}
