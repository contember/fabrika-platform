// Process-only: the archive rewrite hashes with `node:crypto`. The shared layer must not import this
// file (`entrypoint-isolation.test.ts`).
import type { GitHubSourceCredentials } from '../connections/credentials'
import { GitHubMetadataClient, type GitHubMetadataFetch } from './metadata'
import { type SourceDownloadFetch, TarballRepositorySource } from './repository'
import { SourceTransport, type SourceUploadFetch } from './transport'
import type { SourceDescriptorRule, SourceResolution, SourceResolveInput, SourceUploadInput, SourceUploadResult } from './types'

export { encodeGitHubAppCredential, type GitHubAppCredential } from '../connections/credentials'
export { type ArchiveSummary, createTarRewrite, type SourceBytes, type TarRewrite, type TarRewriteInput } from './archive'
export { SourceFailure, type SourceFailureCode, type SourceFailureStage } from './failure'
export type { GitHubMetadataFetch } from './metadata'
export type { SourceDownloadFetch } from './repository'
export type { SourceUploadFetch, SourceUploadRequestInit } from './transport'
export type * from './types'

export interface GitHubSourceOptions {
	readonly credentials: GitHubSourceCredentials
	readonly descriptor: SourceDescriptorRule
	readonly isUploadDestination: (url: string) => boolean
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
}

/** Control's in-process GitHub source (ADR-0029): exact-commit resolution and a streamed upload. */
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
		...(options.uploadFetch === undefined ? {} : { uploadFetch: options.uploadFetch }),
		...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
	})
	return {
		resolve: (input) => transport.resolve(input),
		upload: (input) => transport.upload(input),
	}
}
