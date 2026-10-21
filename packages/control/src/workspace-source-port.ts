/** Provider-neutral Git workspace operations on an app's repository (ADR-0049). */
export interface WorkspaceSourcePort {
	readBranch(input: WorkspaceSourceCall & { branch: string }): Promise<string | null>
	/** The heads of several branches of one repository, in request order; null for a branch that does not exist. */
	readBranches(input: WorkspaceSourceCall & { branches: readonly string[] }): Promise<(string | null)[]>
	createBranch(input: WorkspaceSourceCall & { branch: string; fromSha: string }): Promise<string>
	/** Idempotent: false when the branch did not exist. */
	deleteBranch(input: WorkspaceSourceCall & { branch: string }): Promise<boolean>
	listTree(input: WorkspaceSourceCall & { commitSha: string; directory?: string }): Promise<WorkspaceTree>
	readFiles(input: WorkspaceSourceCall & { commitSha: string; paths: readonly string[] }): Promise<WorkspaceFiles>
	/** Read the regular files under `directory` that `include` admits, the first `maxFiles` of them in tree order. */
	scanFiles(input: WorkspaceSourceCall & WorkspaceScanInput): Promise<WorkspaceScan>
	/** The changes from the merge base of `baseSha` and `headSha` to `headSha`. */
	compare(input: WorkspaceSourceCall & { baseSha: string; headSha: string }): Promise<WorkspaceComparison>
	commit(input: WorkspaceSourceCall & WorkspaceCommit): Promise<string>
	openPullRequest(input: WorkspaceSourceCall & WorkspacePullRequestInput): Promise<WorkspacePullRequest>
}

/** The repository and the connection binding whose GitHub App reaches it. */
export interface WorkspaceSourceTarget {
	readonly connectionId: string
	readonly installationId: number
	readonly owner: string
	readonly repository: string
}

export interface WorkspaceSourceCall {
	readonly target: WorkspaceSourceTarget
	readonly signal: AbortSignal
}

export interface WorkspaceTreeEntry {
	readonly path: string
	readonly kind: 'file' | 'directory' | 'other'
	readonly size?: number
}

export interface WorkspaceTree {
	readonly commitSha: string
	readonly entries: readonly WorkspaceTreeEntry[]
	readonly truncated: boolean
}

/**
 * Why a file was not read: `missing`, `not_a_file` (a directory, symlink or submodule), `too_large` (over 512 KiB),
 * `binary` (not UTF-8), or `budget` (past the 2 MiB a single read may return).
 */
export type WorkspaceUnreadableReason = 'missing' | 'not_a_file' | 'too_large' | 'binary' | 'budget'

export type WorkspaceFile =
	| { readonly path: string; readonly content: string }
	| { readonly path: string; readonly content: null; readonly reason: WorkspaceUnreadableReason }

export interface WorkspaceFiles {
	readonly commitSha: string
	/** One entry per requested path, in request order. */
	readonly files: readonly WorkspaceFile[]
}

export interface WorkspaceScanInput {
	readonly commitSha: string
	readonly directory?: string
	readonly include: (path: string) => boolean
	readonly maxFiles: number
}

export interface WorkspaceScan {
	readonly commitSha: string
	/** The admitted files that were scanned, read or not, in tree order. */
	readonly files: readonly WorkspaceFile[]
	/** Every regular file `include` admitted, those past `maxFiles` included. */
	readonly candidates: number
	/** The tree listing was cut short, so files beyond it were never considered. */
	readonly treeTruncated: boolean
}

export interface WorkspaceChangedFile {
	readonly path: string
	/** The path before a rename or copy. */
	readonly previousPath: string | null
	readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
	readonly additions: number
	readonly deletions: number
	/** null when the host omits it, for a binary file or a very large change. */
	readonly patch: string | null
}

export interface WorkspaceComparison {
	readonly baseSha: string
	readonly headSha: string
	readonly aheadBy: number
	readonly files: readonly WorkspaceChangedFile[]
	/** The host lists a bounded number of files; true when it listed that many, so more may have changed. */
	readonly filesCapped: boolean
}

export interface WorkspaceCommit {
	readonly branch: string
	readonly expectedHeadSha: string
	readonly message: string
	readonly author: { readonly name: string; readonly email: string }
	/** `content: null` deletes the path. */
	readonly changes: readonly { readonly path: string; readonly content: string | null }[]
}

export interface WorkspacePullRequestInput {
	readonly head: string
	readonly base: string
	readonly title: string
	readonly body: string
}

export interface WorkspacePullRequest {
	readonly number: number
	readonly url: string
	readonly created: boolean
}

/**
 * A classified, detail-free repository failure. `stale_head`: the branch moved past the expected head.
 * `not_found`: a branch, commit or path does not exist. `conflict`: the branch already exists. `refused`: the host
 * refused the connection's credentials, permissions or the change itself, so a retry does not help. `unavailable`:
 * the host failed or rate-limited the call, so a retry later may.
 */
export type WorkspaceSourceErrorKind = 'stale_head' | 'not_found' | 'conflict' | 'refused' | 'unavailable'

export class WorkspaceSourceError extends Error {
	constructor(readonly kind: WorkspaceSourceErrorKind) {
		super(`workspace repository operation failed: ${kind}`)
		this.name = 'WorkspaceSourceError'
	}
}
