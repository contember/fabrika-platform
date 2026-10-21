import {
	GitHubAppClient,
	type GitHubAppFetch,
	GitHubBranchConflictError,
	GitHubNotFoundError,
	type GitHubRepositoryClient,
	type GitHubRepositoryOpenRequest,
	GitHubRequestError,
	GitHubStaleHeadError,
	type GitHubTreeEntry,
} from '@fabrika/github-app'
import type { Env } from '../env'
import {
	type WorkspaceFile,
	WorkspaceSourceError,
	type WorkspaceSourcePort,
	type WorkspaceSourceTarget,
	type WorkspaceTreeEntry,
} from '../workspace-source-port'
import { type GitHubAppCredential, readBoundAppCredential } from './connections/credentials'
import { SourceFailure } from './source/failure'

export const WORKSPACE_MAX_TREE_ENTRIES = 5000
/** The GitHub client's bound on one blob read. */
export const WORKSPACE_MAX_SCAN_FILES = 100

/** The part of the GitHub App client that workspace operations use. */
export interface WorkspaceGitHubClient {
	openRepository(input: GitHubRepositoryOpenRequest): Promise<GitHubRepositoryClient>
}

export type WorkspaceGitHubClientFactory = (credential: GitHubAppCredential) => Promise<WorkspaceGitHubClient>

/** Production always talks to `api.github.com`; only the transport is injectable. */
export function workspaceGitHubClientFactory(fetch?: GitHubAppFetch): WorkspaceGitHubClientFactory {
	return (credential) =>
		GitHubAppClient.create({ appId: credential.appId, privateKeyPem: credential.privateKeyPem, ...(fetch === undefined ? {} : { fetch }) })
}

/**
 * Git workspace operations through the binding's own GitHub App, with the key read from the vault per
 * operation (ADR-0029). Control's use cases own workspace identity and policy; this only executes.
 */
export function githubWorkspaceSource(env: Env, createClient: WorkspaceGitHubClientFactory = workspaceGitHubClientFactory()): WorkspaceSourcePort {
	const withRepository = async <T>(target: WorkspaceSourceTarget, signal: AbortSignal, use: (repository: GitHubRepositoryClient) => Promise<T>) => {
		let repository: GitHubRepositoryClient
		try {
			const { installationId, credential } = await readBoundAppCredential(
				env,
				{ connectionId: target.connectionId, installationId: target.installationId },
				{ owner: target.owner, name: target.repository },
			)
			const client = await createClient(credential)
			repository = await client.openRepository({ installationId, owner: target.owner, repository: target.repository, signal })
		} catch (error) {
			if (isAbort(error, signal)) throw error
			console.error('workspace could not open the repository')
			const refused = error instanceof SourceFailure || (error instanceof GitHubRequestError && OPEN_REFUSALS.includes(error.status))
			throw new WorkspaceSourceError(refused ? 'refused' : 'unavailable')
		}
		try {
			return await use(repository)
		} catch (error) {
			throw workspaceFailure(error, signal)
		}
	}

	return {
		readBranch: ({ target, branch, signal }) =>
			withRepository(target, signal, async (repository) => (await repository.readRef(branch, signal))?.sha ?? null),
		createBranch: ({ target, branch, fromSha, signal }) =>
			withRepository(target, signal, async (repository) => (await repository.createBranch({ branch, fromSha, signal })).sha),
		listTree: ({ target, commitSha, directory, signal }) =>
			withRepository(target, signal, async (repository) => {
				const listing = await repository.readTree(commitSha, directory, signal)
				return {
					commitSha: listing.commitSha,
					entries: listing.entries.slice(0, WORKSPACE_MAX_TREE_ENTRIES).map(treeEntry),
					truncated: listing.truncated || listing.entries.length > WORKSPACE_MAX_TREE_ENTRIES,
				}
			}),
		readFiles: ({ target, commitSha, paths, signal }) =>
			withRepository(target, signal, async (repository) => {
				const read = await repository.readFiles(commitSha, paths, signal)
				const contents = new Map(read.files.map((file) => [file.path, file.content]))
				const reasons = new Map(read.unreadable.map((entry) => [entry.path, entry.reason]))
				return {
					commitSha: read.commitSha,
					files: paths.map((path): WorkspaceFile => {
						const content = contents.get(path)
						return content === undefined ? { path, content: null, reason: reasons.get(path) ?? 'missing' } : { path, content }
					}),
				}
			}),
		scanFiles: ({ target, commitSha, directory, include, maxFiles, signal }) =>
			withRepository(target, signal, async (repository) => {
				const listing = await repository.readTree(commitSha, directory, signal)
				const admitted = listing.entries.flatMap((entry) =>
					entry.type === 'blob' && entry.mode !== '120000' && include(entry.path) ? [{ path: entry.path, sha: entry.sha, size: entry.size }] : []
				)
				const scanned = admitted.slice(0, Math.min(maxFiles, WORKSPACE_MAX_SCAN_FILES))
				const read = scanned.length === 0 ? { files: [], unreadable: [] } : await repository.readBlobTexts(scanned, signal)
				const contents = new Map(read.files.map((file) => [file.path, file.content]))
				const reasons = new Map(read.unreadable.map((entry) => [entry.path, entry.reason]))
				return {
					commitSha: listing.commitSha,
					files: scanned.map(({ path }): WorkspaceFile => {
						const content = contents.get(path)
						return content === undefined ? { path, content: null, reason: reasons.get(path) ?? 'missing' } : { path, content }
					}),
					candidates: admitted.length,
					treeTruncated: listing.truncated,
				}
			}),
		compare: ({ target, baseSha, headSha, signal }) =>
			withRepository(target, signal, async (repository) => {
				const comparison = await repository.compareCommits(baseSha, headSha, signal)
				return {
					baseSha: comparison.baseSha,
					headSha: comparison.headSha,
					aheadBy: comparison.aheadBy,
					files: comparison.files,
					filesCapped: comparison.filesCapped,
				}
			}),
		commit: ({ target, branch, expectedHeadSha, message, author, changes, signal }) =>
			withRepository(
				target,
				signal,
				async (repository) => (await repository.commitFiles({ branch, expectedHeadSha, message, author, changes, signal })).sha,
			),
		openPullRequest: ({ target, head, base, title, body, signal }) =>
			withRepository(target, signal, async (repository) => {
				const pullRequest = await repository.openPullRequest({ head, base, title, body, signal })
				return { number: pullRequest.number, url: pullRequest.url, created: pullRequest.created }
			}),
	}
}

function treeEntry(entry: GitHubTreeEntry): WorkspaceTreeEntry {
	if (entry.type === 'tree') return { path: entry.path, kind: 'directory' }
	if (entry.type === 'blob' && entry.mode !== '120000') return { path: entry.path, kind: 'file', size: entry.size }
	return { path: entry.path, kind: 'other' }
}

/** A token GitHub will not mint: an unknown, suspended or under-permitted installation, or a bad App key. */
const OPEN_REFUSALS: readonly number[] = [401, 403, 404, 422]
// 403 is left out on purpose: GitHub answers its secondary rate limit with it, and a retry then helps.
const OPERATION_REFUSALS: readonly number[] = [401, 422]

/** GitHub error bodies and messages never reach the caller or the log; they may carry repository detail. */
function workspaceFailure(error: unknown, signal: AbortSignal): unknown {
	if (isAbort(error, signal)) return error
	if (error instanceof GitHubStaleHeadError) return new WorkspaceSourceError('stale_head')
	if (error instanceof GitHubBranchConflictError) return new WorkspaceSourceError('conflict')
	if (error instanceof GitHubNotFoundError) return new WorkspaceSourceError('not_found')
	console.error('workspace GitHub operation failed')
	return new WorkspaceSourceError(error instanceof GitHubRequestError && OPERATION_REFUSALS.includes(error.status) ? 'refused' : 'unavailable')
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}
