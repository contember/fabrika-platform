// The files of one exact commit, read through the GitHub API: the tree once, then each file Control asks for.
// Runtime-neutral, so both compositions read a run's snapshot with it (ADR-0050).

import type { ProviderSourceBinding } from '@fabrika/provider-contract'
import type { GitHubSourceCredentials } from '../connections/credentials'
import { parseGitHubRepo } from '../triggers/push-event'
import { SourceFailure } from './failure'
import type { GitHubMetadataClient } from './metadata'
import type { SourceRepository } from './types'

export interface CommitFilesInput {
	/** The registry's `github.com/<owner>/<repo>`. */
	readonly repoUrl: string
	readonly commitSha: string
	/** Absent for a public repository (ADR-0029). */
	readonly sourceBinding?: ProviderSourceBinding
	readonly signal: AbortSignal
}

/** One commit's regular files: which exist, and the text of one. */
export interface CommitFiles {
	/** Repository-relative paths of every regular file at the commit. */
	readonly paths: ReadonlySet<string>
	/** The file's text, refused over `maxBytes` or when it is not UTF-8. */
	read(path: string, maxBytes: number): Promise<string>
}

/** What one anonymous read of a repository answered: GitHub hides a private repository as a 404, as it does a missing one. */
export type AnonymousReadability = 'readable' | 'unreadable' | 'unknown'

export interface CommitSource {
	open(input: CommitFilesInput): Promise<CommitFiles>
	/**
	 * Whether a caller without a token can read the repository: one resolution of its `HEAD`, the request a public
	 * deploy's source resolution makes first. Only a 404 is `unreadable`; any other failure is `unknown`, not a verdict.
	 */
	anonymousReadability(input: { readonly repoUrl: string; readonly signal: AbortSignal }): Promise<AnonymousReadability>
}

/** A commit's files through one connection's repository token, minted once per opened commit. */
export function gitHubCommitSource(metadata: GitHubMetadataClient, credentials: GitHubSourceCredentials): CommitSource {
	return {
		async open(input) {
			const repository = repositoryOf(input.repoUrl)
			const binding = input.sourceBinding
			const token = binding === undefined
				? undefined
				: await credentials.repositoryToken({
					connectionId: binding.connectionId,
					installationId: binding.installationId,
					repository,
					signal: input.signal,
				})
			const paths = await metadata.commitFiles(repository, input.commitSha, token, input.signal, 'resolve')
			return {
				paths,
				async read(path, maxBytes) {
					const bytes = await metadata.readFileAtCommit(repository, path, maxBytes, input.commitSha, token, input.signal, 'resolve')
					try {
						return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
					} catch {
						throw new SourceFailure('archive_rejected', 'resolve')
					}
				},
			}
		},
		async anonymousReadability(input) {
			try {
				await metadata.commit(repositoryOf(input.repoUrl), 'HEAD', undefined, input.signal, 'resolve')
				return 'readable'
			} catch (error) {
				return error instanceof SourceFailure && error.code === 'ref_not_found' ? 'unreadable' : 'unknown'
			}
		},
	}
}

function repositoryOf(repoUrl: string): SourceRepository {
	const parsed = parseGitHubRepo(repoUrl)
	if (parsed === null) throw new SourceFailure('invalid_request', 'resolve')
	return { owner: parsed.owner, name: parsed.repo }
}
