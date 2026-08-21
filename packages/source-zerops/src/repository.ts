import type { ZeropsSourcePrivateBindingV2, ZeropsSourceRepository } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { cancelled, SourceFailure, throwIfAborted } from './failure'
import type { SourceGitHubClient, SourceGitHubConnection } from './github-connection'
import { GitHubMetadataClient } from './github-metadata'
import { type ArchiveSummary, createTarRewrite, type SourceBytes } from './tar'

/** Production origins are fixed; only the transport itself is injectable, and only for tests. */
const GITHUB_API_ORIGIN = 'https://api.github.com'
const CODELOAD_ORIGIN = 'https://codeload.github.com'
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'fabrika-source-zerops'
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const DEFAULT_REDIRECT_TIMEOUT_MS = 30_000
const MAX_REDIRECT_TIMEOUT_MS = 120_000

export interface RepositoryResolveInput {
	repository: ZeropsSourceRepository
	requestedRef: string
	expectedCommitSha?: string
	githubInstallationId?: number
	privateBinding?: ZeropsSourcePrivateBindingV2
	descriptorSha256: string
	signal: AbortSignal
}

export interface RepositoryResolveResult {
	commitSha: string
	descriptorSha256: string
}

export interface RepositoryArchiveInput {
	repository: ZeropsSourceRepository
	commitSha: string
	githubInstallationId?: number
	privateBinding?: ZeropsSourcePrivateBindingV2
	descriptorSha256: string
	signal: AbortSignal
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

export interface RepositorySource {
	resolve(input: RepositoryResolveInput): Promise<RepositoryResolveResult>
	archive(input: RepositoryArchiveInput): Promise<RepositoryArchive>
}

export type SourceDownloadFetch = (
	input: string,
	init: RequestInit,
) => Promise<Response>

export interface TarballRepositorySourceOptions {
	github?: SourceGitHubConnection
	metadata?: GitHubMetadataClient
	/** Tests inject the tarball transport; production always uses the fixed GitHub origins. */
	downloadFetch?: SourceDownloadFetch
	redirectTimeoutMs?: number
}

interface RepositoryCredentials {
	token?: string
}

type RepositoryStage = 'resolve' | 'archive'

/** Streams GitHub's `git archive` tarball into the Zerops archive without git, a checkout, or a temp file. */
export class TarballRepositorySource implements RepositorySource {
	private readonly metadata: GitHubMetadataClient
	private readonly downloadFetch: SourceDownloadFetch
	private readonly redirectTimeoutMs: number

	constructor(private readonly options: TarballRepositorySourceOptions = {}) {
		this.metadata = options.metadata ?? new GitHubMetadataClient()
		this.downloadFetch = options.downloadFetch ?? ((input, init) => fetch(input, init))
		const timeout = options.redirectTimeoutMs ?? DEFAULT_REDIRECT_TIMEOUT_MS
		if (
			!Number.isSafeInteger(timeout)
			|| timeout <= 0
			|| timeout > MAX_REDIRECT_TIMEOUT_MS
		) {
			throw new Error('GitHub redirect timeout is invalid')
		}
		this.redirectTimeoutMs = timeout
	}

	async resolve(
		input: RepositoryResolveInput,
	): Promise<RepositoryResolveResult> {
		throwIfAborted(input.signal, 'resolve')
		const credentials = await this.credentials(input, 'resolve')
		const commitSha = await this.metadata.commit(
			input.repository,
			input.requestedRef,
			credentials.token,
			input.signal,
			'resolve',
		)
		if (
			input.expectedCommitSha !== undefined
			&& commitSha !== input.expectedCommitSha
		) {
			throw new SourceFailure('commit_mismatch', 'resolve', false, 409)
		}
		if (!SHA256_PATTERN.test(input.descriptorSha256)) {
			throw new SourceFailure('descriptor_mismatch', 'resolve', false, 409)
		}
		const descriptor = await this.metadata.descriptor(
			input.repository,
			commitSha,
			credentials.token,
			input.signal,
			'resolve',
		)
		const digest = createHash('sha256').update(descriptor).digest('hex')
		if (digest !== input.descriptorSha256) {
			throw new SourceFailure('descriptor_mismatch', 'resolve', false, 409)
		}
		return { commitSha, descriptorSha256: digest }
	}

	async archive(input: RepositoryArchiveInput): Promise<RepositoryArchive> {
		throwIfAborted(input.signal, 'archive')
		if (!OBJECT_ID_PATTERN.test(input.commitSha)) {
			throw new SourceFailure('commit_mismatch', 'archive', false, 409)
		}
		if (!SHA256_PATTERN.test(input.descriptorSha256)) {
			throw new SourceFailure('descriptor_mismatch', 'archive', false, 409)
		}
		const credentials = await this.credentials(input, 'archive')
		const download = linkedController(input.signal)
		try {
			const tarball = await this.tarball(
				input.repository,
				input.commitSha,
				credentials.token,
				download.signal,
				input.signal,
			)
			const rewrite = createTarRewrite({
				commitSha: input.commitSha,
				descriptorSha256: input.descriptorSha256,
			})
			const inflated: ReadableStream<SourceBytes> = tarball.pipeThrough(
				new DecompressionStream('gzip'),
			)
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
		repository: ZeropsSourceRepository,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		callerSignal: AbortSignal,
	): Promise<ReadableStream<SourceBytes>> {
		const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${encodeURIComponent(commitSha)}`
		const timeout = AbortSignal.timeout(this.redirectTimeoutMs)
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
		if (body === null) throw new SourceFailure('archive_rejected', 'archive', false, 422)
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
			throw new SourceFailure(
				'internal',
				'archive',
				true,
				timeout?.aborted === true ? 504 : 502,
			)
		}
	}

	private async credentials(
		input: RepositoryResolveInput | RepositoryArchiveInput,
		stage: RepositoryStage,
	): Promise<RepositoryCredentials> {
		if (
			input.githubInstallationId !== undefined
			&& input.privateBinding !== undefined
		) {
			throw new SourceFailure('invalid_request', stage, false, 400)
		}
		const installationId = input.privateBinding?.installationId ?? input.githubInstallationId
		if (installationId === undefined) return {}
		const github: SourceGitHubClient | undefined = input.privateBinding === undefined
			? this.options.github?.snapshot()?.client
			: this.options.github?.snapshotV2?.(input.privateBinding.connectionId)?.client
		if (github === undefined) {
			throw new SourceFailure('installation_not_found', stage, false, 404)
		}
		try {
			const token = await github.mintRepositoryToken({
				installationId,
				owner: input.repository.owner,
				repository: input.repository.name,
				signal: input.signal,
			})
			return { token: token.token }
		} catch (error) {
			if (
				input.signal.aborted
				|| (error instanceof Error && error.name === 'AbortError')
			) {
				throw cancelled(stage)
			}
			throw new SourceFailure('internal', stage, true, 502)
		}
	}
}

/** The only redirect target we follow, checked before any repository byte is read. */
function codeloadLocation(response: Response): string {
	if (response.status < 300 || response.status >= 400) {
		throw responseFailure(response.status)
	}
	const location = response.headers.get('location')
	if (location === null) throw new SourceFailure('archive_rejected', 'archive', false, 422)
	let url: URL
	try {
		url = new URL(location)
	} catch {
		throw new SourceFailure('archive_rejected', 'archive', false, 422)
	}
	if (
		url.origin !== CODELOAD_ORIGIN
		|| url.protocol !== 'https:'
		|| url.port !== ''
		|| url.username !== ''
		|| url.password !== ''
	) {
		throw new SourceFailure('archive_rejected', 'archive', false, 422)
	}
	return url.href
}

function responseFailure(status: number): SourceFailure {
	if (status === 404) {
		return new SourceFailure('ref_not_found', 'archive', false, 404)
	}
	return new SourceFailure('internal', 'archive', status >= 500, 502)
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
