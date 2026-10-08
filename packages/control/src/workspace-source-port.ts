/** Provider-neutral Git workspace operations on an app's repository (ADR-0049). */
export interface WorkspaceSourcePort {
	readBranch(input: WorkspaceSourceCall & { branch: string }): Promise<string | null>
	createBranch(input: WorkspaceSourceCall & { branch: string; fromSha: string }): Promise<string>
	listTree(input: WorkspaceSourceCall & { commitSha: string; directory?: string }): Promise<WorkspaceTree>
	readFiles(input: WorkspaceSourceCall & { commitSha: string; paths: readonly string[] }): Promise<WorkspaceFiles>
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

export interface WorkspaceFiles {
	readonly commitSha: string
	/** `content` is null for a path that is missing, binary, or too large to read. */
	readonly files: readonly { readonly path: string; readonly content: string | null }[]
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
 * `not_found`: a branch, commit or path does not exist. `conflict`: the branch already exists.
 */
export type WorkspaceSourceErrorKind = 'stale_head' | 'not_found' | 'conflict' | 'unavailable'

export class WorkspaceSourceError extends Error {
	constructor(readonly kind: WorkspaceSourceErrorKind) {
		super(`workspace repository operation failed: ${kind}`)
		this.name = 'WorkspaceSourceError'
	}
}
