import { configurationError, GitHubBranchConflictError, GitHubNotFoundError, GitHubStaleHeadError, requestStatusError, responseError } from './errors'
import type {
	GitHubBlobRead,
	GitHubBlobRef,
	GitHubCommit,
	GitHubCommitFilesInput,
	GitHubComparison,
	GitHubCreateBranchInput,
	GitHubFileRead,
	GitHubOpenPullRequestInput,
	GitHubPullRequestRef,
	GitHubRef,
	GitHubRepositoryClient,
	GitHubTextFile,
	GitHubTreeEntry,
	GitHubTreeListing,
	GitHubUnreadablePath,
	GitHubUnreadableReason,
} from './repository-types'
import {
	decodeCommit,
	decodeComparison,
	decodeCreatedTreeSha,
	decodePullRequest,
	decodePullRequestList,
	decodeRef,
	decodeTextBlob,
	decodeTree,
	encodeBranch,
	MAX_BLOB_RESPONSE_BYTES,
	MAX_CHANGED_BYTES,
	MAX_CHANGED_FILES,
	MAX_COMMIT_MESSAGE_BYTES,
	MAX_COMMIT_RESPONSE_BYTES,
	MAX_COMPARE_RESPONSE_BYTES,
	MAX_FILE_BYTES,
	MAX_PULL_REQUEST_BODY_BYTES,
	MAX_PULL_REQUEST_RESPONSE_BYTES,
	MAX_PULL_REQUEST_TITLE_BYTES,
	MAX_READ_BYTES,
	MAX_READ_PATHS,
	MAX_TREE_ENTRIES,
	MAX_TREE_RESPONSE_BYTES,
	utf8Length,
	validateBranch,
	validatePath,
	validateSha,
	validateText,
} from './repository-validation'
import { createCancellation, GITHUB_ACCEPT, GITHUB_API_VERSION, GITHUB_USER_AGENT, readBoundedJson } from './transport'
import type { GitHubAppFetch, GitHubInstallationToken } from './types'
import { hasAsciiControl } from './validation'

export interface RepositoryClientConfig {
	readonly owner: string
	readonly repository: string
	readonly token: GitHubInstallationToken
	readonly now: () => number
	readonly apiBaseUrl: string
	readonly fetch: GitHubAppFetch
	readonly timeoutMs: number
}

/** Blob reads in flight at once; enough to hide latency, few enough to stay clear of GitHub's secondary rate limits. */
const BLOB_READ_CONCURRENCY = 6

type RequestResult = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: number }

interface RequestOptions {
	readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
	readonly body?: unknown
	readonly signal?: AbortSignal | undefined
	readonly maxResponseBytes?: number
	/** Statuses returned to the caller instead of thrown. */
	readonly expectedFailures?: readonly number[]
}

interface TreeChange {
	readonly path: string
	readonly mode: '100644' | '100755'
	readonly type: 'blob'
	readonly content?: string
	readonly sha?: null
}

export function createRepositoryClient(config: RepositoryClientConfig): GitHubRepositoryClient {
	return new RepositoryClient(config)
}

class RepositoryClient implements GitHubRepositoryClient {
	readonly #config: RepositoryClientConfig

	constructor(config: RepositoryClientConfig) {
		this.#config = config
	}

	async readRef(branch: string, signal?: AbortSignal): Promise<GitHubRef | null> {
		validateBranch(branch)
		const result = await this.#request(`/git/ref/heads/${encodeBranch(branch)}`, { signal, expectedFailures: [404] })
		return result.ok ? decodeRef(result.body, branch) : null
	}

	async readTree(commitSha: string, directory = '', signal?: AbortSignal): Promise<GitHubTreeListing> {
		validateSha(commitSha)
		if (directory !== '') validatePath(directory)
		const rootSha = (await this.#readCommit(commitSha, signal)).treeSha
		let treeSha = rootSha
		if (directory !== '') {
			const entry = await this.#treeWalker(rootSha, signal).find(directory)
			if (entry?.type !== 'tree') return { commitSha, directory, entries: [], truncated: false }
			treeSha = entry.sha
		}
		const tree = decodeTree(await this.#readGitObject(`/git/trees/${treeSha}?recursive=1`, signal, MAX_TREE_RESPONSE_BYTES), treeSha)
		const prefix = directory === '' ? '' : `${directory}/`
		const entries = tree.entries.slice(0, MAX_TREE_ENTRIES).map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }))
		return { commitSha, directory, entries, truncated: tree.truncated || tree.entries.length > MAX_TREE_ENTRIES }
	}

	async readFiles(commitSha: string, paths: readonly string[], signal?: AbortSignal): Promise<GitHubFileRead> {
		validateSha(commitSha)
		if (paths.length === 0 || paths.length > MAX_READ_PATHS || new Set(paths).size !== paths.length) throw configurationError()
		for (const path of paths) validatePath(path)
		const directories = this.#treeWalker((await this.#readCommit(commitSha, signal)).treeSha, signal)
		const files: GitHubTextFile[] = []
		const unreadable: GitHubUnreadablePath[] = []
		let remainingBytes = MAX_READ_BYTES
		for (const path of paths) {
			const entry = readableBlob(await directories.find(path), remainingBytes)
			if (typeof entry === 'string') {
				unreadable.push({ path, reason: entry })
				continue
			}
			const body = await this.#readGitObject(`/git/blobs/${entry.sha}`, signal, MAX_BLOB_RESPONSE_BYTES)
			const content = decodeTextBlob(body, entry.sha, entry.size)
			if (content === null) {
				unreadable.push({ path, reason: 'binary' })
				continue
			}
			remainingBytes -= entry.size
			files.push({ path, content })
		}
		return { commitSha, files, unreadable }
	}

	async readBlobTexts(blobs: readonly GitHubBlobRef[], signal?: AbortSignal): Promise<GitHubBlobRead> {
		if (blobs.length === 0 || blobs.length > MAX_READ_PATHS || new Set(blobs.map((blob) => blob.path)).size !== blobs.length) {
			throw configurationError()
		}
		for (const blob of blobs) {
			validatePath(blob.path)
			validateSha(blob.sha)
			if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw configurationError()
		}
		const unreadable = new Map<string, GitHubUnreadableReason>()
		const selected: GitHubBlobRef[] = []
		let remainingBytes = MAX_READ_BYTES
		for (const blob of blobs) {
			if (blob.size > MAX_FILE_BYTES) unreadable.set(blob.path, 'too_large')
			else if (blob.size > remainingBytes) unreadable.set(blob.path, 'budget')
			else {
				remainingBytes -= blob.size
				selected.push(blob)
			}
		}
		const contents = new Map<string, string>()
		for (let start = 0; start < selected.length; start += BLOB_READ_CONCURRENCY) {
			await Promise.all(
				selected.slice(start, start + BLOB_READ_CONCURRENCY).map(async (blob) => {
					const body = await this.#readGitObject(`/git/blobs/${blob.sha}`, signal, MAX_BLOB_RESPONSE_BYTES)
					const content = decodeTextBlob(body, blob.sha, blob.size)
					if (content === null) unreadable.set(blob.path, 'binary')
					else contents.set(blob.path, content)
				}),
			)
		}
		const files: GitHubTextFile[] = []
		const unread: GitHubUnreadablePath[] = []
		for (const blob of blobs) {
			const content = contents.get(blob.path)
			const reason = unreadable.get(blob.path)
			if (content !== undefined) files.push({ path: blob.path, content })
			else if (reason !== undefined) unread.push({ path: blob.path, reason })
		}
		return { files, unreadable: unread }
	}

	async compareCommits(baseSha: string, headSha: string, signal?: AbortSignal): Promise<GitHubComparison> {
		validateSha(baseSha)
		validateSha(headSha)
		// The changed files ride only on the first page of commits, so one commit per page keeps the rest of the body small.
		const body = await this.#readGitObject(`/compare/${baseSha}...${headSha}?per_page=1`, signal, MAX_COMPARE_RESPONSE_BYTES)
		return decodeComparison(body, headSha)
	}

	async createBranch(input: GitHubCreateBranchInput): Promise<GitHubRef> {
		validateBranch(input.branch)
		validateSha(input.fromSha)
		const existing = await this.readRef(input.branch, input.signal)
		if (existing !== null) return requireBranchAt(existing, input.fromSha)
		await this.#readCommit(input.fromSha, input.signal)
		const result = await this.#request('/git/refs', {
			method: 'POST',
			body: { ref: `refs/heads/${input.branch}`, sha: input.fromSha },
			signal: input.signal,
			expectedFailures: [422],
		})
		if (result.ok) return decodeRef(result.body, input.branch)
		// GitHub answers 422 both when the ref already exists (e.g. a concurrent create) and when `fromSha` is unknown.
		const raced = await this.readRef(input.branch, input.signal)
		if (raced === null) throw new GitHubNotFoundError()
		return requireBranchAt(raced, input.fromSha)
	}

	async deleteBranch(branch: string, signal?: AbortSignal): Promise<{ readonly deleted: boolean }> {
		validateBranch(branch)
		const result = await this.#request(`/git/refs/heads/${encodeBranch(branch)}`, { method: 'DELETE', signal, expectedFailures: [422] })
		if (result.ok) return { deleted: true }
		// 422 is "Reference does not exist" among other refusals; only an absent branch counts as already deleted.
		if (await this.readRef(branch, signal) !== null) throw requestStatusError(result.status)
		return { deleted: false }
	}

	async commitFiles(input: GitHubCommitFilesInput): Promise<GitHubCommit> {
		validateBranch(input.branch)
		validateSha(input.expectedHeadSha)
		validateText(input.message, MAX_COMMIT_MESSAGE_BYTES, false)
		validateText(input.author.name, 256, false)
		validateText(input.author.email, 256, false)
		if (hasAsciiControl(input.author.name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(input.author.email)) throw configurationError()
		const changes = treeChanges(input.changes)

		// Known limit: REST has no compare-and-swap, so a concurrent reset to an ancestor still lets the non-force PATCH fast-forward.
		const head = await this.readRef(input.branch, input.signal)
		if (head?.sha !== input.expectedHeadSha) throw new GitHubStaleHeadError()
		const parent = await this.#readCommit(input.expectedHeadSha, input.signal)
		const tree = await this.#resolveModes(changes, parent.treeSha, input.signal)

		const createdTree = await this.#request('/git/trees', {
			method: 'POST',
			body: { base_tree: parent.treeSha, tree },
			signal: input.signal,
			maxResponseBytes: MAX_TREE_RESPONSE_BYTES,
		})
		if (!createdTree.ok) throw requestStatusError(createdTree.status)
		const treeSha = decodeCreatedTreeSha(createdTree.body)

		const author = { name: input.author.name, email: input.author.email }
		const created = await this.#request('/git/commits', {
			method: 'POST',
			body: { message: input.message, tree: treeSha, parents: [parent.sha], author, committer: author },
			signal: input.signal,
			maxResponseBytes: MAX_COMMIT_RESPONSE_BYTES,
		})
		if (!created.ok) throw requestStatusError(created.status)
		const commit = decodeCommit(created.body)
		if (commit.treeSha !== treeSha || commit.parents.length !== 1 || commit.parents[0] !== parent.sha) throw responseError()

		const moved = await this.#request(`/git/refs/heads/${encodeBranch(input.branch)}`, {
			method: 'PATCH',
			body: { sha: commit.sha, force: false },
			signal: input.signal,
			expectedFailures: [422],
		})
		if (!moved.ok) {
			// 422 is both "not a fast forward" and a refusal such as branch protection; only a moved head is stale.
			const current = await this.readRef(input.branch, input.signal)
			if (current?.sha !== input.expectedHeadSha) throw new GitHubStaleHeadError()
			throw requestStatusError(moved.status)
		}
		if (decodeRef(moved.body, input.branch).sha !== commit.sha) throw responseError()
		return commit
	}

	async openPullRequest(input: GitHubOpenPullRequestInput): Promise<GitHubPullRequestRef> {
		validateBranch(input.head)
		validateBranch(input.base)
		if (input.head === input.base) throw configurationError()
		validateText(input.title, MAX_PULL_REQUEST_TITLE_BYTES, false)
		validateText(input.body, MAX_PULL_REQUEST_BODY_BYTES, true)
		const created = await this.#request('/pulls', {
			method: 'POST',
			body: { title: input.title, body: input.body, head: input.head, base: input.base },
			signal: input.signal,
			maxResponseBytes: MAX_PULL_REQUEST_RESPONSE_BYTES,
			expectedFailures: [422],
		})
		if (created.ok) return decodePullRequest(created.body, true)
		// 422 covers "a pull request already exists" among other validation failures; only an open match recovers it.
		const query = new URLSearchParams({ state: 'open', head: `${this.#config.owner}:${input.head}`, base: input.base, per_page: '1' })
		const listed = await this.#request(`/pulls?${query}`, { signal: input.signal, maxResponseBytes: MAX_PULL_REQUEST_RESPONSE_BYTES })
		if (!listed.ok) throw requestStatusError(listed.status)
		const existing = decodePullRequestList(listed.body)[0]
		if (existing === undefined) throw requestStatusError(created.status)
		return decodePullRequest(existing, false)
	}

	/** Keeps an edited executable's mode, and refuses to delete anything but an existing file. */
	async #resolveModes(changes: readonly TreeChange[], rootSha: string, signal: AbortSignal | undefined): Promise<TreeChange[]> {
		const head = this.#treeWalker(rootSha, signal)
		const result: TreeChange[] = []
		for (const change of changes) {
			const existing = await head.find(change.path)
			const isFile = existing?.type === 'blob'
			if (change.content === undefined && !isFile) throw configurationError()
			result.push(isFile && existing.mode === '100755' ? { ...change, mode: '100755' } : change)
		}
		return result
	}

	#treeWalker(rootSha: string, signal: AbortSignal | undefined): TreeWalker {
		return new TreeWalker(rootSha, (treeSha) => this.#readGitObject(`/git/trees/${treeSha}`, signal, MAX_TREE_RESPONSE_BYTES))
	}

	async #readCommit(sha: string, signal: AbortSignal | undefined): Promise<GitHubCommit> {
		const commit = decodeCommit(await this.#readGitObject(`/git/commits/${sha}`, signal, MAX_COMMIT_RESPONSE_BYTES))
		if (commit.sha !== sha) throw responseError()
		return commit
	}

	/** Reads a commit, tree or blob by sha; GitHub answers 404 or 422 for an unknown one. */
	async #readGitObject(path: string, signal: AbortSignal | undefined, maxResponseBytes?: number): Promise<unknown> {
		const result = await this.#request(path, { signal, maxResponseBytes, expectedFailures: [404, 422] })
		if (!result.ok) throw new GitHubNotFoundError()
		return result.body
	}

	async #request(path: string, options: RequestOptions): Promise<RequestResult> {
		const { token } = this.#config
		if (token.expiresAt <= this.#config.now()) throw new Error('GitHub repository token expired')
		const cancellation = createCancellation(options.signal, this.#config.timeoutMs)
		try {
			cancellation.throwIfCancelled()
			const headers = new Headers({
				authorization: `Bearer ${token.token}`,
				accept: GITHUB_ACCEPT,
				'x-github-api-version': GITHUB_API_VERSION,
				'user-agent': GITHUB_USER_AGENT,
			})
			if (options.body !== undefined) headers.set('content-type', 'application/json')
			let response: Response
			try {
				response = await this.#config.fetch(`${this.#config.apiBaseUrl}/repos/${this.#config.owner}/${this.#config.repository}${path}`, {
					method: options.method ?? 'GET',
					headers,
					...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
					redirect: 'error',
					signal: cancellation.signal,
				})
			} catch {
				cancellation.throwIfCancelled()
				throw new Error('GitHub repository request failed')
			}
			cancellation.throwIfCancelled()
			if (!response.ok) {
				void response.body?.cancel().catch(() => {})
				if (options.expectedFailures?.includes(response.status) === true) return { ok: false, status: response.status }
				throw requestStatusError(response.status)
			}
			if (response.status === 204) return { ok: true, body: null }
			return { ok: true, body: await readBoundedJson(response, cancellation, options.maxResponseBytes) }
		} finally {
			cancellation.dispose()
		}
	}
}

/** Resolves repository paths through non-recursive tree reads, caching each directory once. */
class TreeWalker {
	readonly #directories = new Map<string, Promise<ReadonlyMap<string, GitHubTreeEntry>>>()

	constructor(
		private readonly rootSha: string,
		private readonly fetchTree: (treeSha: string) => Promise<unknown>,
	) {}

	async find(path: string): Promise<GitHubTreeEntry | null> {
		let treeSha = this.rootSha
		const parts = path.split('/')
		for (const [index, part] of parts.entries()) {
			const entry = (await this.#read(treeSha)).get(part)
			if (entry === undefined) return null
			if (index === parts.length - 1) return entry
			if (entry.type !== 'tree') return null
			treeSha = entry.sha
		}
		return null
	}

	#read(treeSha: string): Promise<ReadonlyMap<string, GitHubTreeEntry>> {
		let directory = this.#directories.get(treeSha)
		if (directory === undefined) {
			directory = this.#load(treeSha)
			this.#directories.set(treeSha, directory)
		}
		return directory
	}

	async #load(treeSha: string): Promise<ReadonlyMap<string, GitHubTreeEntry>> {
		const tree = decodeTree(await this.fetchTree(treeSha), treeSha)
		// A truncated directory listing cannot prove a path is absent.
		if (tree.truncated) throw responseError()
		return new Map(tree.entries.map((entry) => [entry.path, entry]))
	}
}

type GitHubBlobEntry = Extract<GitHubTreeEntry, { readonly type: 'blob' }>

/** The entry when it is a regular file within both bounds, otherwise why it is not read. */
function readableBlob(entry: GitHubTreeEntry | null, remainingBytes: number): GitHubBlobEntry | GitHubUnreadableReason {
	if (entry === null) return 'missing'
	if (entry.type !== 'blob' || entry.mode === '120000') return 'not_a_file'
	if (entry.size > MAX_FILE_BYTES) return 'too_large'
	if (entry.size > remainingBytes) return 'budget'
	return entry
}

function requireBranchAt(ref: GitHubRef, sha: string): GitHubRef {
	if (ref.sha !== sha) throw new GitHubBranchConflictError()
	return ref
}

function treeChanges(changes: GitHubCommitFilesInput['changes']): TreeChange[] {
	if (changes.length === 0 || changes.length > MAX_CHANGED_FILES) throw configurationError()
	const paths = new Set<string>()
	let bytes = 0
	const tree = changes.map((change): TreeChange => {
		validatePath(change.path)
		if (paths.has(change.path)) throw configurationError()
		paths.add(change.path)
		if (change.content === null) return { path: change.path, mode: '100644', type: 'blob', sha: null }
		validateText(change.content, MAX_FILE_BYTES, true)
		bytes += utf8Length(change.content)
		if (bytes > MAX_CHANGED_BYTES) throw configurationError()
		return { path: change.path, mode: '100644', type: 'blob', content: change.content }
	})
	for (const path of paths) {
		const parts = path.split('/')
		for (let length = 1; length < parts.length; length++) {
			if (paths.has(parts.slice(0, length).join('/'))) throw configurationError()
		}
	}
	return tree
}
