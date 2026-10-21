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

export function requestStatusError(status: number): GitHubRequestError {
	return new GitHubRequestError(status)
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
