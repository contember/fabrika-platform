// Process-only: the archive rewrite hashes with `node:crypto`. The shared layer must not import this
// file (`entrypoint-isolation.test.ts`).
import type { GitHubSourceCredentials } from '../connections/credentials'
import { archiveCommitSource } from './commit-archive'
import type { CommitSource } from './commit-files'
import { GitHubMetadataClient, type GitHubMetadataFetch } from './metadata'
import { type SourceDownloadFetch, TarballRepositorySource } from './repository'
import { SourceTransport, type SourceUploadFetch } from './transport'
import type { SourceDescriptorRule, SourceResolution, SourceResolveInput, SourceUploadInput, SourceUploadResult } from './types'

export { encodeGitHubAppCredential, type GitHubAppCredential } from '../connections/credentials'
export { type ArchiveSummary, createTarRewrite, type SourceBytes, type TarRewrite, type TarRewriteInput } from './archive'
export { SourceFailure, type SourceFailureCode, type SourceFailureStage, SourceRateLimited } from './failure'
export type { GitHubMetadataFetch } from './metadata'
export type { SourceDownloadFetch } from './repository'
export type { SourceUploadFetch, SourceUploadRequestInit } from './transport'
export type * from './types'

export interface GitHubSourceOptions {
	readonly credentials: GitHubSourceCredentials
	readonly descriptor: SourceDescriptorRule
	readonly isUploadDestination: (url: string) => boolean
	/** A dev sandbox host's file endpoint; without it, an upload that carries a bearer is refused. */
	readonly isSandboxUploadDestination?: (url: string) => boolean
	/** Default 2; further uploads queue and leave the queue when their caller aborts. */
	readonly maxConcurrentUploads?: number
	/** Transport seams for tests and the local stack; the GitHub origins stay fixed. */
	readonly metadataFetch?: GitHubMetadataFetch
	readonly downloadFetch?: SourceDownloadFetch
	readonly uploadFetch?: SourceUploadFetch
}

export interface GitHubSource {
	resolve(input: SourceResolveInput): Promise<SourceResolution>
	upload(input: SourceUploadInput): Promise<SourceUploadResult>
	/** A run's snapshot files, from the same archive reader, so both share what it remembers. */
	readonly commits: CommitSource
}

/** Control's in-process GitHub source (ADR-0029): exact-commit resolution, a commit's files, and a streamed upload. */
export function createGitHubSource(options: GitHubSourceOptions): GitHubSource {
	const metadata = new GitHubMetadataClient(options.metadataFetch === undefined ? {} : { fetch: options.metadataFetch })
	const repository = new TarballRepositorySource({
		credentials: options.credentials,
		metadata,
		descriptor: options.descriptor,
		...(options.downloadFetch === undefined ? {} : { downloadFetch: options.downloadFetch }),
	})
	const transport = new SourceTransport({
		repository,
		isUploadDestination: options.isUploadDestination,
		...(options.isSandboxUploadDestination === undefined ? {} : { isSandboxUploadDestination: options.isSandboxUploadDestination }),
		...(options.uploadFetch === undefined ? {} : { uploadFetch: options.uploadFetch }),
		...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
	})
	return {
		resolve: (input) => transport.resolve(input),
		upload: (input) => transport.upload(input),
		commits: archiveCommitSource(repository, metadata),
	}
}
