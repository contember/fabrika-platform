export interface GitHubRef {
	readonly branch: string
	readonly sha: string
}

export interface GitHubCommit {
	readonly sha: string
	readonly treeSha: string
	readonly parents: readonly string[]
}

export type GitHubTreeEntry =
	& { readonly path: string; readonly sha: string }
	& (
		| { readonly type: 'tree'; readonly mode: '040000' }
		| { readonly type: 'blob'; readonly mode: '100644' | '100755' | '120000'; readonly size: number }
		| { readonly type: 'commit'; readonly mode: '160000' }
	)

export interface GitHubTreeListing {
	readonly commitSha: string
	/** Empty for the root; entries use repository-relative paths. */
	readonly directory: string
	/** Every entry below `directory`, recursively, up to the client's bound. */
	readonly entries: readonly GitHubTreeEntry[]
	/** True when the bound cut the listing short. */
	readonly truncated: boolean
}

export interface GitHubTextFile {
	readonly path: string
	readonly content: string
}

/**
 * Why a requested path was not read: `missing` (no such path), `not_a_file` (a directory, symlink or submodule),
 * `too_large` (over the per-file bound), `binary` (not UTF-8), `budget` (past the read's total byte bound).
 */
export type GitHubUnreadableReason = 'missing' | 'not_a_file' | 'too_large' | 'binary' | 'budget'

export interface GitHubUnreadablePath {
	readonly path: string
	readonly reason: GitHubUnreadableReason
}

export interface GitHubFileRead {
	readonly commitSha: string
	readonly files: readonly GitHubTextFile[]
	/** Requested paths that were not read at `commitSha`, in request order. */
	readonly unreadable: readonly GitHubUnreadablePath[]
}

export interface GitHubFileChange {
	readonly path: string
	/** UTF-8 regular-file contents, or null to delete the path. */
	readonly content: string | null
}

export interface GitHubCreateBranchInput {
	readonly branch: string
	readonly fromSha: string
	readonly signal?: AbortSignal
}

export interface GitHubCommitFilesInput {
	readonly branch: string
	/** The branch head the changes were made against; a different live head fails with `GitHubStaleHeadError`. */
	readonly expectedHeadSha: string
	readonly message: string
	readonly author: { readonly name: string; readonly email: string }
	readonly changes: readonly GitHubFileChange[]
	readonly signal?: AbortSignal
}

export interface GitHubOpenPullRequestInput {
	readonly head: string
	readonly base: string
	readonly title: string
	readonly body: string
	readonly signal?: AbortSignal
}

export interface GitHubPullRequestRef {
	readonly number: number
	readonly url: string
	/** False when an open pull request for the same head and base already existed and was returned instead. */
	readonly created: boolean
}

/**
 * One repository, reached with an installation token restricted to it. The caller (Source) decides
 * which branches it may write; the client only refuses a non-fast-forward or stale update.
 */
export interface GitHubRepositoryClient {
	readRef(branch: string, signal?: AbortSignal): Promise<GitHubRef | null>
	readTree(commitSha: string, directory?: string, signal?: AbortSignal): Promise<GitHubTreeListing>
	readFiles(commitSha: string, paths: readonly string[], signal?: AbortSignal): Promise<GitHubFileRead>
	/** Idempotent: an existing branch already at `fromSha` is returned; one elsewhere is a conflict. */
	createBranch(input: GitHubCreateBranchInput): Promise<GitHubRef>
	/** Creates exactly one commit on top of `expectedHeadSha` and moves the branch to it without force. */
	commitFiles(input: GitHubCommitFilesInput): Promise<GitHubCommit>
	openPullRequest(input: GitHubOpenPullRequestInput): Promise<GitHubPullRequestRef>
}

export interface GitHubRepositoryOpenRequest {
	readonly installationId: number
	readonly owner: string
	readonly repository: string
	readonly signal?: AbortSignal
}
