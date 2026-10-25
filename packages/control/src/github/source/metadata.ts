import { z } from 'zod'
import { cancelled, rateLimitFailure, SourceFailure } from './failure'
import { safeRepositoryPath, SOURCE_MAX_TREE_ENTRIES } from './tree'
import type { SourceRepository } from './types'

const GITHUB_COMMIT_MAX_RESPONSE_BYTES = 1024 * 1024
const GITHUB_TREE_MAX_RESPONSE_BYTES = 7 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_API_ORIGIN = 'https://api.github.com'
const GITHUB_USER_AGENT = 'fabrika-control'

const objectIdSchema = z.string().regex(OBJECT_ID_PATTERN)
const commitSchema = z.object({
	sha: objectIdSchema,
	// Ref resolution needs only the commit; platform archive admission separately requires its tree.
	commit: z.object({ tree: z.object({ sha: objectIdSchema }) }).optional().catch(undefined),
})
const treeResponseSchema = z.object({ sha: z.string(), truncated: z.literal(false), tree: z.array(z.unknown()) })
const treeEntrySchema = z.object({
	path: z.string(),
	sha: objectIdSchema,
	size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).and(z.discriminatedUnion('type', [
	z.object({ type: z.literal('tree'), mode: z.literal('040000') }),
	z.object({ type: z.literal('blob'), mode: z.enum(['100644', '100755', '120000']) }),
]))

type TreeEntry = z.infer<typeof treeEntrySchema>

export type GitHubMetadataFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type GitHubMetadataStage = 'resolve' | 'archive'

export interface GitHubMetadataClientOptions {
	/** Tests and the local stack inject the transport; the origin stays fixed. */
	fetch?: GitHubMetadataFetch
	timeoutMs?: number
}

export class GitHubMetadataClient {
	private readonly fetchImplementation: GitHubMetadataFetch
	private readonly timeoutMs: number
	/** Platform commits whose tree passed; a commit's tree never changes, and pins are few. */
	private readonly validatedPlatformTrees = new Set<string>()

	constructor(options: GitHubMetadataClientOptions) {
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
		repository: SourceRepository,
		ref: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<string> {
		return (await this.readCommit(repository, ref, token, signal, stage)).sha
	}

	/**
	 * Git trees retain gitlinks even when export attributes hide .gitmodules from the tarball. The check costs two
	 * rate-limited requests, so a commit that passed is not read again in this process.
	 */
	async validatePlatformTree(repository: SourceRepository, commitSha: string, token: string | undefined, signal: AbortSignal): Promise<void> {
		const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}@${commitSha}`
		if (this.validatedPlatformTrees.has(key)) return
		const paths = await this.readTree(repository, commitSha, token, signal, 'archive')
		for (const path of paths.keys()) {
			const separator = path.lastIndexOf('/')
			if (separator !== -1 && paths.get(path.slice(0, separator))?.type !== 'tree') throw rejected('archive')
		}
		this.validatedPlatformTrees.add(key)
	}

	/** Every regular file of an exact commit (a symbolic link is not one), repository-relative. */
	async commitFiles(
		repository: SourceRepository,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<ReadonlySet<string>> {
		const entries = await this.readTree(repository, commitSha, token, signal, stage)
		return new Set([...entries].filter(([, entry]) => entry.type === 'blob' && entry.mode !== '120000').map(([path]) => path))
	}

	/** The whole recursive tree of an exact commit; a truncated, oversized or malformed one is refused. */
	private async readTree(
		repository: SourceRepository,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<Map<string, TreeEntry>> {
		if (!OBJECT_ID_PATTERN.test(commitSha)) throw rejected(stage)
		const commit = await this.readCommit(repository, commitSha, token, signal, stage)
		if (commit.sha !== commitSha) throw new SourceFailure('commit_mismatch', stage)
		if (commit.treeSha === undefined) throw rejected(stage)
		const parsed = await this.requestJson(
			`${prefix(repository)}/git/trees/${commit.treeSha}?recursive=1`,
			token,
			signal,
			stage,
			GITHUB_TREE_MAX_RESPONSE_BYTES,
		)
		const result = treeResponseSchema.safeParse(parsed)
		if (!result.success || result.data.sha !== commit.treeSha) {
			throw rejected(stage)
		}
		const entries = result.data.tree
		if (entries.length > SOURCE_MAX_TREE_ENTRIES) throw new SourceFailure('archive_rejected', stage)
		const paths = new Map<string, TreeEntry>()
		for (const entry of entries) {
			const result = treeEntrySchema.safeParse(entry)
			if (!result.success) throw rejected(stage)
			const { path } = result.data
			if (!safeRepositoryPath(path) || paths.has(path)) throw rejected(stage)
			paths.set(path, result.data)
		}
		return paths
	}

	private async readCommit(
		repository: SourceRepository,
		ref: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<{ sha: string; treeSha: string | undefined }> {
		const parsed = await this.requestJson(
			`${prefix(repository)}/commits/${encodeURIComponent(ref)}`,
			token,
			signal,
			stage,
			GITHUB_COMMIT_MAX_RESPONSE_BYTES,
		)
		const result = commitSchema.safeParse(parsed)
		if (!result.success) throw rejected(stage)
		return { sha: result.data.sha, treeSha: result.data.commit?.tree.sha }
	}

	private async requestJson(
		path: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
		maximumBytes: number,
	): Promise<unknown> {
		const body = await this.request(
			path,
			GITHUB_ACCEPT,
			token,
			signal,
			stage,
			maximumBytes,
			() => new SourceFailure('archive_rejected', stage),
		)
		try {
			return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
		} catch {
			throw rejected(stage)
		}
	}

	/** Read one file at an exact commit, bounded; a missing file is `descriptor_missing`. */
	async readFileAtCommit(
		repository: SourceRepository,
		path: string,
		maxBytes: number,
		commitSha: string,
		token: string | undefined,
		signal: AbortSignal,
		stage: GitHubMetadataStage,
	): Promise<Uint8Array> {
		if (!safeRepositoryPath(path) || !OBJECT_ID_PATTERN.test(commitSha)) throw rejected(stage)
		return await this.request(
			`${prefix(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commitSha)}`,
			GITHUB_RAW_ACCEPT,
			token,
			signal,
			stage,
			maxBytes,
			() => new SourceFailure('archive_rejected', stage),
			() => new SourceFailure('descriptor_missing', stage),
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
		notFound: () => SourceFailure = () => new SourceFailure('ref_not_found', stage),
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
				response = await this.fetchImplementation(`${GITHUB_API_ORIGIN}${path}`, {
					headers,
					// Workers' fetch rejects `redirect: 'error'`; a 3xx is not `ok` and fails below.
					redirect: 'manual',
					signal: controller.signal,
				})
			} catch {
				if (callerSignal.aborted) throw cancelled(stage)
				throw new SourceFailure('internal', stage)
			}
			if (callerSignal.aborted) throw cancelled(stage)
			if (timeout.aborted) {
				throw new SourceFailure('internal', stage)
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {})
				if (response.status === 404) throw notFound()
				throw rateLimitFailure(response, stage, token === undefined) ?? new SourceFailure('internal', stage)
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

function prefix(repository: SourceRepository): string {
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
	if (timeout.aborted) throw new SourceFailure('internal', stage)
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
		throw new SourceFailure('internal', stage)
	}
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
	return new SourceFailure('archive_rejected', stage)
}
