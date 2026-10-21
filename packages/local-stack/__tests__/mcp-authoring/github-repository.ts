// The only GitHub stand-in of the MCP authoring witness: one repository as a tiny Git model. A branch
// names a commit; a commit is an immutable file map with one parent. Everything Control asks of a
// repository is answered from that model, and refusals use the real `@fabrika/github-app` error classes,
// which Control's workspace source classifies.

import {
	type GitHubBlobRef,
	GitHubBranchConflictError,
	type GitHubChangedFile,
	type GitHubCommitFilesInput,
	type GitHubCreateBranchInput,
	GitHubNotFoundError,
	type GitHubOpenPullRequestInput,
	type GitHubRepositoryClient,
	type GitHubRepositoryOpenRequest,
	GitHubStaleHeadError,
	type GitHubTreeEntry,
	type GitHubUnreadablePath,
} from '../../../github-app/src/index'

export interface FakeCommit {
	readonly sha: string
	readonly parent: string | null
	readonly message: string
	readonly author: { readonly name: string; readonly email: string } | null
	readonly files: ReadonlyMap<string, string>
}

export interface FakePullRequest {
	readonly number: number
	readonly head: string
	readonly base: string
	readonly title: string
	readonly body: string
}

export class FakeGitHubRepository implements GitHubRepositoryClient {
	readonly commits = new Map<string, FakeCommit>()
	readonly branches = new Map<string, string>()
	readonly pullRequests: FakePullRequest[] = []
	/** Every `openRepository` Control made, without its signal. */
	readonly opened: Omit<GitHubRepositoryOpenRequest, 'signal'>[] = []

	constructor(readonly owner: string, readonly name: string, defaultBranch: string, files: Record<string, string>) {
		const root = this.store(null, 'Initial commit', null, new Map(Object.entries(files)))
		this.branches.set(defaultBranch, root.sha)
	}

	/** What `WorkspaceGitHubClient.openRepository` returns: this repository, for its own coordinates only. */
	open(request: GitHubRepositoryOpenRequest): Promise<GitHubRepositoryClient> {
		this.opened.push({ installationId: request.installationId, owner: request.owner, repository: request.repository })
		if (request.owner !== this.owner || request.repository !== this.name) return Promise.reject(new GitHubNotFoundError())
		return Promise.resolve(this)
	}

	commit(sha: string): FakeCommit {
		const commit = this.commits.get(sha)
		if (commit === undefined) throw new GitHubNotFoundError()
		return commit
	}

	readRef(branch: string) {
		const sha = this.branches.get(branch)
		return Promise.resolve(sha === undefined ? null : { branch, sha })
	}

	readTree(commitSha: string, directory?: string) {
		const commit = this.commit(commitSha)
		const prefix = directory === undefined || directory === '' ? '' : `${directory}/`
		const entries: GitHubTreeEntry[] = []
		const directories = new Set<string>()
		for (const [path, content] of commit.files) {
			if (!path.startsWith(prefix)) continue
			const segments = path.split('/')
			for (let depth = 1; depth < segments.length; depth++) {
				const parent = segments.slice(0, depth).join('/')
				if (parent.startsWith(prefix) && !directories.has(parent)) {
					directories.add(parent)
					entries.push({ path: parent, sha: gitHash(`tree ${parent}`), type: 'tree', mode: '040000' })
				}
			}
			entries.push({ path, sha: gitHash(content), type: 'blob', mode: '100644', size: new TextEncoder().encode(content).byteLength })
		}
		return Promise.resolve({ commitSha, directory: directory ?? '', entries, truncated: false })
	}

	readFiles(commitSha: string, paths: readonly string[]) {
		const commit = this.commit(commitSha)
		const files = paths.flatMap((path) => {
			const content = commit.files.get(path)
			return content === undefined ? [] : [{ path, content }]
		})
		const unreadable = paths.filter((path) => !commit.files.has(path)).map((path): GitHubUnreadablePath => ({ path, reason: 'missing' }))
		return Promise.resolve({ commitSha, files, unreadable })
	}

	readBlobTexts(blobs: readonly GitHubBlobRef[]) {
		const contents = new Map([...this.commits.values()].flatMap((commit) => [...commit.files.values()]).map((content) => [gitHash(content), content]))
		const files = blobs.flatMap((blob) => {
			const content = contents.get(blob.sha)
			return content === undefined ? [] : [{ path: blob.path, content }]
		})
		const unreadable = blobs.filter((blob) => !contents.has(blob.sha)).map((blob): GitHubUnreadablePath => ({ path: blob.path, reason: 'missing' }))
		return Promise.resolve({ files, unreadable })
	}

	/** Compares base with head directly: in this model a workspace's base is always an ancestor of its head. */
	compareCommits(baseSha: string, headSha: string) {
		const base = this.commit(baseSha).files
		const head = this.commit(headSha).files
		const paths = [...new Set([...base.keys(), ...head.keys()])].sort()
		const files = paths.flatMap((path): GitHubChangedFile[] => {
			const before = base.get(path)
			const after = head.get(path)
			if (before === after) return []
			const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified'
			return [{ path, previousPath: null, status, additions: after === undefined ? 0 : 1, deletions: before === undefined ? 0 : 1, patch: null }]
		})
		let aheadBy = 0
		for (let sha: string | null = headSha; sha !== null && sha !== baseSha; sha = this.commit(sha).parent) aheadBy += 1
		return Promise.resolve({ baseSha, headSha, aheadBy, behindBy: 0, files, filesCapped: false })
	}

	createBranch(input: GitHubCreateBranchInput) {
		this.commit(input.fromSha)
		const existing = this.branches.get(input.branch)
		if (existing !== undefined && existing !== input.fromSha) return Promise.reject(new GitHubBranchConflictError())
		this.branches.set(input.branch, input.fromSha)
		return Promise.resolve({ branch: input.branch, sha: input.fromSha })
	}

	deleteBranch(branch: string) {
		return Promise.resolve({ deleted: this.branches.delete(branch) })
	}

	commitFiles(input: GitHubCommitFilesInput) {
		if (this.branches.get(input.branch) !== input.expectedHeadSha) return Promise.reject(new GitHubStaleHeadError())
		const files = new Map(this.commit(input.expectedHeadSha).files)
		for (const change of input.changes) {
			if (change.content === null) files.delete(change.path)
			else files.set(change.path, change.content)
		}
		const commit = this.store(input.expectedHeadSha, input.message, input.author, files)
		this.branches.set(input.branch, commit.sha)
		return Promise.resolve({ sha: commit.sha, treeSha: gitHash(JSON.stringify([...files])), parents: [input.expectedHeadSha] })
	}

	openPullRequest(input: GitHubOpenPullRequestInput) {
		const url = (number: number) => `https://github.com/${this.owner}/${this.name}/pull/${number}`
		const open = this.pullRequests.find((pull) => pull.head === input.head && pull.base === input.base)
		if (open !== undefined) return Promise.resolve({ number: open.number, url: url(open.number), created: false })
		const number = this.pullRequests.length + 1
		this.pullRequests.push({ number, head: input.head, base: input.base, title: input.title, body: input.body })
		return Promise.resolve({ number, url: url(number), created: true })
	}

	private store(
		parent: string | null,
		message: string,
		author: FakeCommit['author'],
		files: ReadonlyMap<string, string>,
	): FakeCommit {
		const sha = gitHash(JSON.stringify({ parent, message, author, files: [...files] }))
		const commit: FakeCommit = { sha, parent, message, author, files }
		this.commits.set(sha, commit)
		return commit
	}
}

function gitHash(value: string): string {
	return new Bun.CryptoHasher('sha1').update(value).digest('hex')
}
