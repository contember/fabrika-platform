import { createHash } from 'node:crypto'
import { type ArchiveSummary, createTarRewrite, type SourceBytes } from './archive'
import type { GitHubSourceCredentials } from './credentials'
import { cancelled, SourceFailure, throwIfAborted } from './failure'
import type { GitHubMetadataClient } from './metadata'
import { pullThrough } from './streams'
import type { SourceArchiveKind, SourceDescriptorRule, SourcePrivateBinding, SourceRepository, SourceResolution, SourceResolveInput } from './types'

/** Production origins are fixed; only the transport itself is injectable. */
const GITHUB_API_ORIGIN = 'https://api.github.com'
const CODELOAD_ORIGIN = 'https://codeload.github.com'
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'fabrika-control'
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const REDIRECT_TIMEOUT_MS = 30_000

export interface RepositoryArchiveInput {
	readonly repository: SourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
	readonly archive: SourceArchiveKind
	readonly signal: AbortSignal
}

/**
 * One streamed archive: `body` is the destination payload and `completed` is its verdict.
 *
 * Validation happens while the destination is already reading, so a rejected repository surfaces as a
 * broken `body` plus a settled `completed`: the caller must read the verdict before blaming the
 * transport. `dispose` settles a verdict the destination will never finish producing.
 */
export interface RepositoryArchive {
	readonly body: ReadableStream<SourceBytes>
	readonly completed: Promise<ArchiveSummary>
	dispose(): void
}

export type SourceDownloadFetch = (
	input: string,
	init: RequestInit,
) => Promise<Response>

export interface TarballRepositorySourceOptions {
	readonly credentials: GitHubSourceCredentials
	readonly metadata: GitHubMetadataClient
	readonly descriptor: SourceDescriptorRule
	/** Tests and the local stack inject the tarball transport; the origins stay fixed. */
	readonly downloadFetch?: SourceDownloadFetch
}

type RepositoryStage = 'resolve' | 'archive'

/** Streams GitHub's `git archive` tarball into the Zerops archive without git, a checkout, or a temp file. */
export class TarballRepositorySource {
	private readonly metadata: GitHubMetadataClient
	private readonly downloadFetch: SourceDownloadFetch

	constructor(private readonly options: TarballRepositorySourceOptions) {
		this.metadata = options.metadata
		this.downloadFetch = options.downloadFetch ?? ((input, init) => fetch(input, init))
	}

	async resolve(input: SourceResolveInput): Promise<SourceResolution> {
		throwIfAborted(input.signal, 'resolve')
		const token = await this.token(input.repository, input.privateBinding, input.signal, 'resolve')
		const commitSha = await this.metadata.commit(
			input.repository,
			input.requestedRef,
			token,
			input.signal,
			'resolve',
		)
		if (
			input.expectedCommitSha !== undefined
			&& commitSha !== input.expectedCommitSha
		) {
			throw new SourceFailure('commit_mismatch', 'resolve')
		}
		if (!SHA256_PATTERN.test(input.descriptorSha256)) {
			throw new SourceFailure('descriptor_mismatch', 'resolve')
		}
		const descriptor = await this.metadata.descriptor(
			input.repository,
			this.options.descriptor,
			commitSha,
			token,
			input.signal,
			'resolve',
		)
		const digest = createHash('sha256').update(descriptor).digest('hex')
		if (digest !== input.descriptorSha256) {
			throw new SourceFailure('descriptor_mismatch', 'resolve')
		}
		return { commitSha, descriptorSha256: digest }
	}

	async archive(input: RepositoryArchiveInput): Promise<RepositoryArchive> {
		throwIfAborted(input.signal, 'archive')
		if (!OBJECT_ID_PATTERN.test(input.commitSha)) {
			throw new SourceFailure('commit_mismatch', 'archive')
		}
		if (!SHA256_PATTERN.test(input.descriptorSha256)) {
			throw new SourceFailure('descriptor_mismatch', 'archive')
		}
		const platform = input.archive.kind === 'platform'
		const binding = input.archive.kind === 'application' ? input.archive.privateBinding : undefined
		const token = await this.token(input.repository, binding, input.signal, 'archive')
		if (platform) await this.metadata.validatePlatformTree(input.repository, input.commitSha, input.signal)
		const download = linkedController(input.signal)
		try {
			const tarball = await this.tarball(
				input.repository,
				input.commitSha,
				token,
				download.signal,
				input.signal,
			)
			const rewrite = createTarRewrite({
				...(platform ? { archiveKind: 'platform' } : {}),
				commitSha: input.commitSha,
				descriptor: this.options.descriptor,
				descriptorSha256: input.descriptorSha256,
			})
			const inflated: ReadableStream<SourceBytes> = pullThrough(tarball, new DecompressionStream('gzip'))
			return {
				body: inflated.pipeThrough(rewrite.transform),
				completed: rewrite.completed,
				dispose: () => {
					rewrite.abandon()
					download.abort()
				},
			}
		} catch (error) {
			download.abort()
			if (input.signal.aborted) throw cancelled('archive')
			throw error
		}
	}

	/**
	 * GitHub answers the tarball endpoint with a redirect to codeload, whose URL carries its own
	 * short-lived token in the query. That URL is a credential in transit: it is never logged, never
	 * persisted, never returned in an error, and never receives the installation Authorization header.
	 */
	private async tarball(
		repository: SourceRepository,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		callerSignal: AbortSignal,
	): Promise<ReadableStream<SourceBytes>> {
		const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${encodeURIComponent(commitSha)}`
		const timeout = AbortSignal.timeout(REDIRECT_TIMEOUT_MS)
		const redirect = linkedController(signal, timeout)
		let location: string
		try {
			const response = await this.request(
				`${GITHUB_API_ORIGIN}${path}`,
				token,
				'manual',
				redirect.signal,
				callerSignal,
				timeout,
			)
			try {
				location = codeloadLocation(response)
			} finally {
				await response.body?.cancel().catch(() => {})
			}
		} finally {
			redirect.abort()
		}
		const archive = await this.request(
			location,
			undefined,
			'error',
			signal,
			callerSignal,
		)
		if (!archive.ok) {
			await archive.body?.cancel().catch(() => {})
			throw responseFailure(archive.status)
		}
		const body = archive.body
		if (body === null) throw new SourceFailure('archive_rejected', 'archive')
		return body
	}

	private async request(
		url: string,
		token: string | undefined,
		redirect: 'manual' | 'error',
		signal: AbortSignal,
		callerSignal: AbortSignal,
		timeout?: AbortSignal,
	): Promise<Response> {
		const headers = new Headers({
			accept: GITHUB_ACCEPT,
			'user-agent': GITHUB_USER_AGENT,
			'x-github-api-version': GITHUB_API_VERSION,
		})
		if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
		try {
			return await this.downloadFetch(url, { headers, redirect, signal })
		} catch {
			if (callerSignal.aborted) throw cancelled('archive')
			throw new SourceFailure('internal', 'archive')
		}
	}

	/** A public repository needs no token; a private one names exactly one connection. */
	private async token(
		repository: SourceRepository,
		binding: SourcePrivateBinding | undefined,
		signal: AbortSignal,
		stage: RepositoryStage,
	): Promise<string | undefined> {
		if (binding === undefined) return undefined
		try {
			return await this.options.credentials.repositoryToken({ ...binding, repository, signal })
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw cancelled(stage)
			if (error instanceof SourceFailure) throw error
			throw new SourceFailure('internal', stage)
		}
	}
}

/** The only redirect target we follow, checked before any repository byte is read. */
function codeloadLocation(response: Response): string {
	if (response.status < 300 || response.status >= 400) {
		throw responseFailure(response.status)
	}
	const location = response.headers.get('location')
	if (location === null) throw new SourceFailure('archive_rejected', 'archive')
	let url: URL
	try {
		url = new URL(location)
	} catch {
		throw new SourceFailure('archive_rejected', 'archive')
	}
	if (
		url.origin !== CODELOAD_ORIGIN
		|| url.protocol !== 'https:'
		|| url.port !== ''
		|| url.username !== ''
		|| url.password !== ''
	) {
		throw new SourceFailure('archive_rejected', 'archive')
	}
	return url.href
}

function responseFailure(status: number): SourceFailure {
	if (status === 404) {
		return new SourceFailure('ref_not_found', 'archive')
	}
	return new SourceFailure('internal', 'archive')
}

function linkedController(...signals: AbortSignal[]): AbortController {
	const controller = new AbortController()
	for (const signal of signals) {
		if (signal.aborted) controller.abort()
		else {
			signal.addEventListener('abort', () => controller.abort(), {
				once: true,
				signal: controller.signal,
			})
		}
	}
	return controller
}
