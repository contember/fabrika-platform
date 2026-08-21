import { ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES, type ZeropsSourceRepository } from '@fabrika/provider-zerops'
import { cancelled, SourceFailure } from './failure'
import { SOURCE_DESCRIPTOR_PATH } from './tar'

const GITHUB_COMMIT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'fabrika-source-zerops'

export type GitHubMetadataFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type GitHubMetadataStage = 'resolve' | 'archive'

export interface GitHubMetadataClientOptions {
	apiBaseUrl?: string
	fetch?: GitHubMetadataFetch
	timeoutMs?: number
}

export class GitHubMetadataClient {
	private readonly apiBaseUrl: string
	private readonly fetchImplementation: GitHubMetadataFetch
	private readonly timeoutMs: number

	constructor(options: GitHubMetadataClientOptions = {}) {
		this.apiBaseUrl = normalizedApiBaseUrl(
			options.apiBaseUrl ?? 'https://api.github.com',
		)
		this.fetchImplementation = options.fetch ?? fetch
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		if (
			!Number.isSafeInteger(timeoutMs)
			|| timeoutMs <= 0
			|| timeoutMs > MAX_TIMEOUT_MS
		) {
			throw new Error('GitHub metadata timeout is invalid')
		}
		this.timeoutMs = timeoutMs
	}

	/** Resolve a branch, tag or sha to the one exact commit the whole run is then bound to. */
	async commit(
		repository: ZeropsSourceRepository,
		ref: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<string> {
		const body = await this.request(
			`${prefix(repository)}/commits/${encodeURIComponent(ref)}`,
			GITHUB_ACCEPT,
			token,
			signal,
			stage,
			GITHUB_COMMIT_MAX_RESPONSE_BYTES,
			() => new SourceFailure('archive_rejected', stage, false, 413),
		)
		let parsed: unknown
		try {
			parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
		} catch {
			throw rejected(stage)
		}
		if (!isObject(parsed)) throw rejected(stage)
		const sha = parsed['sha']
		if (typeof sha !== 'string' || !OBJECT_ID_PATTERN.test(sha)) {
			throw rejected(stage)
		}
		return sha
	}

	/** Read the repository-root descriptor at an exact commit, bounded, without any other repository content. */
	async descriptor(
		repository: ZeropsSourceRepository,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<Uint8Array> {
		return await this.request(
			`${prefix(repository)}/contents/${SOURCE_DESCRIPTOR_PATH}?ref=${encodeURIComponent(commitSha)}`,
			GITHUB_RAW_ACCEPT,
			token,
			signal,
			stage,
			ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
			() => new SourceFailure('archive_rejected', stage, false, 422),
			() => new SourceFailure('descriptor_missing', stage, false, 422),
		)
	}

	private async request(
		path: string,
		accept: string,
		token: string | undefined,
		callerSignal: AbortSignal,
		stage: GitHubMetadataStage,
		maximumBytes: number,
		tooLarge: () => SourceFailure,
		notFound: () => SourceFailure = () => new SourceFailure('ref_not_found', stage, false, 404),
	): Promise<Uint8Array> {
		const timeout = AbortSignal.timeout(this.timeoutMs)
		const controller = linkedController(callerSignal, timeout)
		try {
			const headers = new Headers({
				accept,
				'user-agent': GITHUB_USER_AGENT,
				'x-github-api-version': GITHUB_API_VERSION,
			})
			if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
			let response: Response
			try {
				response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
					headers,
					redirect: 'error',
					signal: controller.signal,
				})
			} catch {
				if (callerSignal.aborted) throw cancelled(stage)
				throw new SourceFailure(
					'internal',
					stage,
					true,
					timeout.aborted ? 504 : 502,
				)
			}
			if (callerSignal.aborted) throw cancelled(stage)
			if (timeout.aborted) {
				throw new SourceFailure('internal', stage, true, 504)
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {})
				if (response.status === 404) throw notFound()
				throw new SourceFailure('internal', stage, response.status >= 500, 502)
			}
			return await readBounded(
				response,
				maximumBytes,
				controller,
				callerSignal,
				timeout,
				stage,
				tooLarge,
			)
		} finally {
			controller.abort()
		}
	}
}

function prefix(repository: ZeropsSourceRepository): string {
	return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
}

async function readBounded(
	response: Response,
	maximumBytes: number,
	controller: AbortController,
	callerSignal: AbortSignal,
	timeout: AbortSignal,
	stage: GitHubMetadataStage,
	tooLarge: () => SourceFailure,
): Promise<Uint8Array> {
	const contentLength = response.headers.get('content-length')
	if (
		contentLength !== null
		&& /^\d+$/.test(contentLength)
		&& Number(contentLength) > maximumBytes
	) {
		controller.abort()
		throw tooLarge()
	}
	const reader = response.body?.getReader()
	if (reader === undefined) throw rejected(stage)
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readNext(reader, callerSignal, timeout, stage)
			if (result.done) break
			total += result.value.byteLength
			if (total > maximumBytes) {
				controller.abort()
				throw tooLarge()
			}
			chunks.push(result.value)
		}
	} finally {
		reader.releaseLock()
	}
	if (callerSignal.aborted) throw cancelled(stage)
	if (timeout.aborted) throw new SourceFailure('internal', stage, true, 504)
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

async function readNext(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	callerSignal: AbortSignal,
	timeout: AbortSignal,
	stage: GitHubMetadataStage,
) {
	try {
		return await reader.read()
	} catch {
		if (callerSignal.aborted) throw cancelled(stage)
		throw new SourceFailure('internal', stage, true, timeout.aborted ? 504 : 502)
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedApiBaseUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('GitHub metadata API URL is invalid')
	}
	if (
		(url.protocol !== 'https:'
			&& url.hostname !== '127.0.0.1'
			&& url.hostname !== 'localhost')
		|| url.username !== ''
		|| url.password !== ''
		|| url.search !== ''
		|| url.hash !== ''
	) {
		throw new Error('GitHub metadata API URL is invalid')
	}
	return url.href.replace(/\/$/, '')
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

function rejected(stage: GitHubMetadataStage): SourceFailure {
	return new SourceFailure('archive_rejected', stage, false, 422)
}
