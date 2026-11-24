// Process-only: the archive rewrite hashes with `node:crypto`. The shared layer must not import this
// file (`entrypoint-isolation.test.ts`).
import type { GitHubSourceCredentials } from '../connections/credentials'
import { archiveCommitSource } from './commit-archive'
import type { CommitSource } from './commit-files'
import { SourceFailure } from './failure'
import { GitHubMetadataClient, type GitHubMetadataFetch } from './metadata'
import { type SourceDownloadFetch, TarballRepositorySource } from './repository'
import { SourceTransport, type SourceUploadFetch } from './transport'
import type {
	SourceDescriptorRule,
	SourceResolution,
	SourceResolveInput,
	SourceUploadInput,
	SourceUploadResult,
	UnboundSourceResolution,
	UnboundSourceResolveInput,
	UnboundSourceUploadInput,
	UnboundSourceUploadResult,
} from './types'

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

/** The options of a source that binds no repository descriptor. */
export type UnboundGitHubSourceOptions = Omit<GitHubSourceOptions, 'descriptor'>

/**
 * A source for a provider that renders its whole build from the contract (`contractRecipe`) and so binds no root file:
 * its archive pass hashes nothing, and its inputs and answers carry no descriptor digest.
 */
export interface UnboundGitHubSource {
	resolve(input: UnboundSourceResolveInput): Promise<UnboundSourceResolution>
	upload(input: UnboundSourceUploadInput): Promise<UnboundSourceUploadResult>
	readonly commits: CommitSource
}

/** Control's in-process GitHub source (ADR-0029): exact-commit resolution, a commit's files, and a streamed upload. */
export function createGitHubSource(options: GitHubSourceOptions): GitHubSource {
	const { repository, transport, metadata } = sourceParts(options, options.descriptor)
	return {
		resolve: async (input) => {
			const resolved = await transport.resolve(input)
			return { commitSha: resolved.commitSha, descriptorSha256: boundDigest(resolved.descriptorSha256, 'resolve') }
		},
		upload: async (input) => {
			const { descriptorSha256, ...uploaded } = await transport.upload(input)
			return { ...uploaded, descriptorSha256: boundDigest(descriptorSha256, 'upload') }
		},
		commits: archiveCommitSource(repository, metadata),
	}
}

/** The same source without a descriptor rule (`UnboundGitHubSource`). */
export function createUnboundGitHubSource(options: UnboundGitHubSourceOptions): UnboundGitHubSource {
	const { repository, transport, metadata } = sourceParts(options, null)
	return {
		resolve: async (input) => ({ commitSha: (await transport.resolve(input)).commitSha }),
		upload: async (input) => {
			const uploaded = await transport.upload(input)
			return {
				commitSha: uploaded.commitSha,
				...(uploaded.dataFileSha256 === undefined ? {} : { dataFileSha256: uploaded.dataFileSha256 }),
				entryCount: uploaded.entryCount,
				expandedBytes: uploaded.expandedBytes,
			}
		},
		commits: archiveCommitSource(repository, metadata),
	}
}

function sourceParts(
	options: UnboundGitHubSourceOptions,
	descriptor: SourceDescriptorRule | null,
): { readonly repository: TarballRepositorySource; readonly transport: SourceTransport; readonly metadata: GitHubMetadataClient } {
	const metadata = new GitHubMetadataClient(options.metadataFetch === undefined ? {} : { fetch: options.metadataFetch })
	const repository = new TarballRepositorySource({
		credentials: options.credentials,
		metadata,
		descriptor,
		...(options.downloadFetch === undefined ? {} : { downloadFetch: options.downloadFetch }),
	})
	const transport = new SourceTransport({
		repository,
		isUploadDestination: options.isUploadDestination,
		...(options.isSandboxUploadDestination === undefined ? {} : { isSandboxUploadDestination: options.isSandboxUploadDestination }),
		...(options.uploadFetch === undefined ? {} : { uploadFetch: options.uploadFetch }),
		...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
	})
	return { repository, transport, metadata }
}

/** A bound source's pass always hashes its descriptor or fails `descriptor_missing`; a digest absent here is that failure. */
function boundDigest(descriptorSha256: string | null, stage: 'resolve' | 'upload'): string {
	if (descriptorSha256 === null) throw new SourceFailure('descriptor_missing', stage)
	return descriptorSha256
}
