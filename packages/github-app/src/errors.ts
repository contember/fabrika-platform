export function configurationError(): Error {
	return new Error('GitHub App configuration is invalid')
}

/** GitHub answered a request with an unexpected status; the message never carries GitHub's response text. */
export class GitHubRequestError extends Error {
	constructor(readonly status: number) {
		super(`GitHub App request failed with status ${status}`)
		this.name = 'GitHubRequestError'
	}
}

/**
 * GitHub refused a request for its rate limit: a 429, or a 403 that says the limit is spent (`x-ratelimit-remaining: 0`)
 * or when to come back (`retry-after`, GitHub's secondary limit). An anonymous read spends the caller's address's limit,
 * which every tenant of a cloud's shared egress spends with it.
 */
export class GitHubRateLimitError extends GitHubRequestError {
	constructor(
		status: number,
		readonly anonymous: boolean,
		/** When GitHub admits the next request: `retry-after` when it sends one, else `x-ratelimit-reset`. */
		readonly resetAt: Date | undefined,
		/** GitHub's `retry-after`, in milliseconds; only the secondary limit sends it. */
		readonly retryAfterMs: number | undefined,
	) {
		super(status)
		this.name = 'GitHubRateLimitError'
	}
}

export function requestStatusError(
	status: number,
	headers?: Headers,
	anonymous = false,
	now: () => number = Date.now,
): GitHubRequestError {
	const retryAfter = headers?.get('retry-after') ?? null
	const limited = status === 429 || (status === 403 && (headers?.get('x-ratelimit-remaining') === '0' || retryAfter !== null))
	if (!limited) return new GitHubRequestError(status)
	const retryAfterMs = retryAfter !== null && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined
	const reset = headers?.get('x-ratelimit-reset') ?? null
	const resetAt = retryAfterMs !== undefined
		? new Date(now() + retryAfterMs)
		: reset !== null && /^\d{1,12}$/.test(reset)
		? new Date(Number(reset) * 1000)
		: undefined
	return new GitHubRateLimitError(status, anonymous, resetAt, retryAfterMs)
}

export function responseError(): Error {
	return new Error('GitHub App response is invalid')
}

/** The branch moved since the caller read it; re-read the head and retry the change on top of it. */
export class GitHubStaleHeadError extends Error {
	constructor() {
		super('GitHub branch head changed')
		this.name = 'GitHubStaleHeadError'
	}
}

/** The branch exists at a different commit than the one it was to be created from. */
export class GitHubBranchConflictError extends Error {
	constructor() {
		super('GitHub branch already exists at a different commit')
		this.name = 'GitHubBranchConflictError'
	}
}

/** A commit, tree or blob sha the caller named does not exist in the repository. */
export class GitHubNotFoundError extends Error {
	constructor() {
		super('GitHub commit or tree was not found')
		this.name = 'GitHubNotFoundError'
	}
}
