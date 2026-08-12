import type { ZeropsSourceRepository } from '@fabrika/provider-zerops'
import { cancelled, SourceFailure } from './failure'

export const GITHUB_METADATA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const GITHUB_COMMIT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'fabrika-source-zerops'

export type GitHubMetadataFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export interface GitHubTreeBlob {
	path: string
	mode: '100644' | '100755'
	type: 'blob'
	objectId: string
	size: number
}

export interface GitHubTreeDirectory {
	path: string
	mode: '040000'
	type: 'tree'
	objectId: string
}

export type GitHubTreeEntry = GitHubTreeBlob | GitHubTreeDirectory

export interface GitHubRepositorySnapshot {
	commitSha: string
	treeSha: string
	entries: GitHubTreeEntry[]
}

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

	async snapshot(
		repository: ZeropsSourceRepository,
		ref: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: 'resolve' | 'archive',
	): Promise<GitHubRepositorySnapshot> {
		const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
		const commitBody = await this.requestJson(
			`${prefix}/commits/${encodeURIComponent(ref)}`,
			token,
			signal,
			stage,
			GITHUB_COMMIT_MAX_RESPONSE_BYTES,
		)
		const commitSha = requiredObjectId(commitBody, 'sha', stage)
		const commit = requiredObject(commitBody, 'commit', stage)
		const tree = requiredObject(commit, 'tree', stage)
		const treeSha = requiredObjectId(tree, 'sha', stage)
		const treeBody = await this.requestJson(
			`${prefix}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
			token,
			signal,
			stage,
			GITHUB_METADATA_MAX_RESPONSE_BYTES,
		)
		if (
			treeBody['truncated'] !== false
			|| treeBody['sha'] !== treeSha
			|| !Array.isArray(treeBody['tree'])
		) {
			throw rejected(stage)
		}
		const entries = treeBody['tree'].map((entry) => parseEntry(entry, stage))
		return { commitSha, treeSha, entries }
	}

	private async requestJson(
		path: string,
		token: string | undefined,
		callerSignal: AbortSignal,
		stage: 'resolve' | 'archive',
		maximumBytes: number,
	): Promise<Record<string, unknown>> {
		const timeout = AbortSignal.timeout(this.timeoutMs)
		const controller = linkedController(callerSignal, timeout)
		try {
			const headers = new Headers({
				accept: GITHUB_ACCEPT,
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
				throw new SourceFailure(
					response.status === 404 ? 'ref_not_found' : 'internal',
					stage,
					response.status >= 500,
					response.status === 404 ? 404 : 502,
				)
			}
			const bytes = await readBounded(
				response,
				maximumBytes,
				controller,
				callerSignal,
				timeout,
				stage,
			)
			let parsed: unknown
			try {
				parsed = JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(bytes),
				)
			} catch {
				throw rejected(stage)
			}
			if (!isObject(parsed)) throw rejected(stage)
			return parsed
		} finally {
			controller.abort()
		}
	}
}

async function readBounded(
	response: Response,
	maximumBytes: number,
	controller: AbortController,
	callerSignal: AbortSignal,
	timeout: AbortSignal,
	stage: 'resolve' | 'archive',
): Promise<Uint8Array> {
	const contentLength = response.headers.get('content-length')
	if (
		contentLength !== null
		&& /^\d+$/.test(contentLength)
		&& Number(contentLength) > maximumBytes
	) {
		controller.abort()
		throw new SourceFailure('archive_rejected', stage, false, 413)
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
				throw new SourceFailure('archive_rejected', stage, false, 413)
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
	stage: 'resolve' | 'archive',
) {
	try {
		return await reader.read()
	} catch {
		if (callerSignal.aborted) throw cancelled(stage)
		throw new SourceFailure('internal', stage, true, timeout.aborted ? 504 : 502)
	}
}

function parseEntry(
	value: unknown,
	stage: 'resolve' | 'archive',
): GitHubTreeEntry {
	if (!isObject(value)) throw rejected(stage)
	const path = value['path']
	const mode = value['mode']
	const type = value['type']
	const objectId = value['sha']
	if (
		typeof path !== 'string'
		|| !safeRepositoryPath(path)
		|| typeof objectId !== 'string'
		|| !OBJECT_ID_PATTERN.test(objectId)
	) {
		throw rejected(stage)
	}
	if (mode === '040000' && type === 'tree') {
		return { path, mode, type, objectId }
	}
	const size = value['size']
	if (
		(mode !== '100644' && mode !== '100755')
		|| type !== 'blob'
		|| typeof size !== 'number'
		|| !Number.isSafeInteger(size)
		|| size < 0
	) {
		throw rejected(stage)
	}
	return { path, mode, type, objectId, size }
}

function requiredObject(
	value: Record<string, unknown>,
	key: string,
	stage: 'resolve' | 'archive',
): Record<string, unknown> {
	const field = value[key]
	if (!isObject(field)) throw rejected(stage)
	return field
}

function requiredObjectId(
	value: Record<string, unknown>,
	key: string,
	stage: 'resolve' | 'archive',
): string {
	const field = value[key]
	if (typeof field !== 'string' || !OBJECT_ID_PATTERN.test(field)) {
		throw rejected(stage)
	}
	return field
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeRepositoryPath(path: string): boolean {
	if (
		path === ''
		|| path.startsWith('/')
		|| path.includes('\\')
		|| [...path].some(
			(character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
		)
	) {
		return false
	}
	return path
		.split('/')
		.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
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

function rejected(stage: 'resolve' | 'archive'): SourceFailure {
	return new SourceFailure('archive_rejected', stage, false, 422)
}
