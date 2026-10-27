import type { GitHubSourceCredentials } from '../connections/credentials'
import { type ArchiveSummary, createTarRewrite, type FileCollection, type SourceBytes } from './archive'
import { atStage, cancelled, rateLimitFailure, SourceFailure, throwIfAborted } from './failure'
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
/** Resolutions of an exact commit remembered per process; a commit's content never changes, so neither does the verdict. */
const MAX_VERIFIED_RESOLUTIONS = 1024

/** One pass over an archive that uploads nothing. */
export interface RepositoryReadInput {
	readonly repository: SourceRepository
	/** A branch, a tag or a commit: GitHub resolves it in the tarball request itself. */
	readonly ref: string
	readonly expectedCommitSha?: string
	readonly descriptorSha256?: string
	readonly privateBinding?: SourcePrivateBinding
	readonly collect?: FileCollection
	readonly signal: AbortSignal
}

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
	private readonly verifiedResolutions = new Set<string>()

	constructor(private readonly options: TarballRepositorySourceOptions) {
		this.metadata = options.metadata
		this.downloadFetch = options.downloadFetch ?? ((input, init) => fetch(input, init))
	}

	/**
	 * Resolve a ref to the commit its archive names and check the descriptor's digest, before any platform state exists.
	 * The tarball request resolves the ref, and GitHub's REST rate limit does not count it (ADR-0029). A ref that is
	 * already an exact commit is checked once per process.
	 */
	async resolve(input: SourceResolveInput): Promise<SourceResolution> {
		throwIfAborted(input.signal, 'resolve')
		if (!SHA256_PATTERN.test(input.descriptorSha256)) {
			throw new SourceFailure('descriptor_mismatch', 'resolve')
		}
		const exact = OBJECT_ID_PATTERN.test(input.requestedRef) ? input.requestedRef : undefined
		if (exact !== undefined && input.expectedCommitSha !== undefined && exact !== input.expectedCommitSha) {
			throw new SourceFailure('commit_mismatch', 'resolve')
		}
		const verified = exact === undefined
			? undefined
			: `${input.repository.owner.toLowerCase()}/${input.repository.name.toLowerCase()}@${exact}#${input.descriptorSha256}`
		if (exact !== undefined && verified !== undefined && this.verifiedResolutions.has(verified)) {
			return { commitSha: exact, descriptorSha256: input.descriptorSha256 }
		}
		let summary: ArchiveSummary
		try {
			summary = await this.read({
				repository: input.repository,
				ref: input.requestedRef,
				...(input.expectedCommitSha === undefined ? {} : { expectedCommitSha: input.expectedCommitSha }),
				descriptorSha256: input.descriptorSha256,
				...(input.privateBinding === undefined ? {} : { privateBinding: input.privateBinding }),
				signal: input.signal,
			})
		} catch (error) {
			throw atStage(error, 'resolve')
		}
		if (verified !== undefined) {
			if (this.verifiedResolutions.size >= MAX_VERIFIED_RESOLUTIONS) this.verifiedResolutions.clear()
			this.verifiedResolutions.add(verified)
		}
		return { commitSha: summary.commitSha, descriptorSha256: summary.descriptorSha256 }
	}

	/**
	 * One pass over the archive of `ref` that uploads nothing: the commit it names, its descriptor's digest, and the files
	 * `collect` keeps. It admits relative symbolic links, so it refuses nothing an application or a platform upload accepts.
	 */
	async read(input: RepositoryReadInput): Promise<ArchiveSummary> {
		throwIfAborted(input.signal, 'archive')
		const token = await this.token(input.repository, input.privateBinding, input.signal, 'archive')
		const rewrite = createTarRewrite({
			archiveKind: 'platform',
			descriptor: this.options.descriptor,
			...(input.expectedCommitSha === undefined ? {} : { commitSha: input.expectedCommitSha }),
			...(input.descriptorSha256 === undefined ? {} : { descriptorSha256: input.descriptorSha256 }),
			...(input.collect === undefined ? {} : { collect: input.collect }),
		})
		const download = linkedController(input.signal)
		try {
			const tarball = await this.tarball(input.repository, input.ref, token, download.signal, input.signal)
			const inflated: ReadableStream<SourceBytes> = pullThrough(tarball, new DecompressionStream('gzip'))
			// A refused archive breaks the pipe; its verdict, not the broken pipe, is the reason.
			await inflated.pipeThrough(rewrite.transform).pipeTo(new WritableStream()).catch(() => {})
			rewrite.abandon(input.signal.aborted ? cancelled('archive') : new SourceFailure('internal', 'archive'))
			return await rewrite.completed
		} catch (error) {
			rewrite.abandon()
			if (input.signal.aborted) throw cancelled('archive')
			throw error
		} finally {
			download.abort()
		}
	}

	/** One file of an exact commit through the contents API, for a reader that wants a file its archive pass did not keep. */
	async readFile(
		input: {
			readonly repository: SourceRepository
			readonly commitSha: string
			readonly privateBinding?: SourcePrivateBinding
			readonly signal: AbortSignal
		},
		path: string,
		maxBytes: number,
	): Promise<Uint8Array> {
		const token = await this.token(input.repository, input.privateBinding, input.signal, 'resolve')
		return await this.metadata.readFileAtCommit(input.repository, path, maxBytes, input.commitSha, token, input.signal, 'resolve')
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
		const dataFile = input.archive.kind === 'platform' ? input.archive.dataFile : undefined
		const binding = input.archive.kind === 'application' ? input.archive.privateBinding : undefined
		const token = await this.token(input.repository, binding, input.signal, 'archive')
		if (platform) await this.metadata.validatePlatformTree(input.repository, input.commitSha, token, input.signal)
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
				...(dataFile === undefined ? {} : { dataFile }),
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
		ref: string,
		token: string | undefined,
		signal: AbortSignal,
		callerSignal: AbortSignal,
	): Promise<ReadableStream<SourceBytes>> {
		const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${encodeURIComponent(ref)}`
		const timeout = AbortSignal.timeout(REDIRECT_TIMEOUT_MS)
		const redirect = linkedController(signal, timeout)
		let location: string
		try {
			const response = await this.request(
				`${GITHUB_API_ORIGIN}${path}`,
				token,
				redirect.signal,
				callerSignal,
				timeout,
			)
			try {
				location = codeloadLocation(response, token === undefined)
			} finally {
				await response.body?.cancel().catch(() => {})
			}
		} finally {
			redirect.abort()
		}
		const archive = await this.request(
			location,
			undefined,
			signal,
			callerSignal,
		)
		if (!archive.ok) {
			await archive.body?.cancel().catch(() => {})
			throw responseFailure(archive, token === undefined)
		}
		const body = archive.body
		if (body === null) throw new SourceFailure('archive_rejected', 'archive')
		return body
	}

	private async request(
		url: string,
		token: string | undefined,
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
			// Every hop is `manual`, like every GitHub request Control makes (a Worker refuses `redirect: 'error'`, though this
			// download runs in the Bun process only): the archive's redirect is followed by hand above, and any other 3xx fails.
			return await this.downloadFetch(url, { headers, redirect: 'manual', signal })
		} catch {
			if (callerSignal.aborted) throw cancelled('archive')
			throw new SourceFailure('internal', 'archive')
		}
	}

	/**
	 * A bound read names exactly one connection. An unbound one uses the owning organization's connection when its
	 * installation can read the repository, and is anonymous otherwise.
	 */
	private async token(
		repository: SourceRepository,
		binding: SourcePrivateBinding | undefined,
		signal: AbortSignal,
		stage: RepositoryStage,
	): Promise<string | undefined> {
		try {
			return binding === undefined
				? await this.options.credentials.ownerConnectionToken({ repository, signal })
				: await this.options.credentials.repositoryToken({ ...binding, repository, signal })
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw cancelled(stage)
			if (error instanceof SourceFailure) throw error
			throw new SourceFailure('internal', stage)
		}
	}
}

/** The only redirect target we follow, checked before any repository byte is read. */
function codeloadLocation(response: Response, anonymous: boolean): string {
	if (response.status < 300 || response.status >= 400) {
		throw responseFailure(response, anonymous)
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

function responseFailure(response: Response, anonymous: boolean): SourceFailure {
	if (response.status === 404) {
		return new SourceFailure('ref_not_found', 'archive')
	}
	return rateLimitFailure(response, 'archive', anonymous) ?? new SourceFailure('internal', 'archive')
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
