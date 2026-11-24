import type { ArchiveSummary, SourceBytes } from './archive'
import { cancelled, SourceFailure, type SourceFailureStage, uploadTooLarge } from './failure'
import type { RepositoryArchive, RepositoryArchiveInput } from './repository'
import { pullThrough } from './streams'
import type { SourcePartWriter, SourceResolution, SourceResolveInput, SourceUploadInput, SourceUploadResult } from './types'

export interface SourceUploadRequestInit extends RequestInit {
	duplex: 'half'
}

export type SourceUploadFetch = (
	input: string | URL | Request,
	init: SourceUploadRequestInit,
) => Promise<Response>

/** One wall-clock budget per operation; the PUT itself has its own, shorter bound. */
export const SOURCE_TIMEOUTS_MS = {
	resolve: 4 * 60_000,
	upload: 15 * 60_000,
	pipe: 10 * 60_000,
}

const DEFAULT_MAX_CONCURRENT_UPLOADS = 2

/**
 * The bounds of a part writer's part size, which must be a multiple of the minimum. Cloud Storage takes multiples of
 * 256 KiB, S3 at least 5 MiB but for the last part, an Azure block at most 4 MiB at an old service version; the writer
 * picks within these. The transport fills one part per upload; a part it handed over is the writer's to keep or drop.
 */
export const MIN_SOURCE_PART_BYTES = 256 * 1024
export const MAX_SOURCE_PART_BYTES = 64 * 1024 * 1024

/** How long a part writer may take to drop a failed upload. */
const PART_ABORT_MS = 30_000

export interface SourceRepositoryReader {
	resolve(input: SourceResolveInput): Promise<SourceResolution>
	archive(input: RepositoryArchiveInput): Promise<RepositoryArchive>
}

export interface SourceTransportOptions {
	readonly repository: SourceRepositoryReader
	readonly isUploadDestination: (url: string) => boolean
	/** Accepts a dev sandbox host's file endpoint, the only destination a bearer upload may name. Absent, none is accepted. */
	readonly isSandboxUploadDestination?: (url: string) => boolean
	readonly uploadFetch?: SourceUploadFetch
	readonly maxConcurrentUploads?: number
	/** Tests shorten the bounds; none may exceed the production value. */
	readonly timeoutsMs?: Partial<typeof SOURCE_TIMEOUTS_MS>
}

/** Resolves sources and streams `gunzip → tar rewrite → gzip → PUT` with nothing staged on disk or in memory. */
export class SourceTransport {
	private readonly repository: SourceRepositoryReader
	private readonly isUploadDestination: (url: string) => boolean
	private readonly isSandboxUploadDestination: ((url: string) => boolean) | undefined
	private readonly uploadFetch: SourceUploadFetch
	private readonly timeouts: typeof SOURCE_TIMEOUTS_MS
	private readonly uploads: ConcurrencyLimit

	constructor(options: SourceTransportOptions) {
		this.repository = options.repository
		this.isUploadDestination = options.isUploadDestination
		this.isSandboxUploadDestination = options.isSandboxUploadDestination
		this.uploadFetch = options.uploadFetch ?? ((input, init) => fetch(input, init))
		this.timeouts = {
			resolve: boundedTimeout(options.timeoutsMs?.resolve, SOURCE_TIMEOUTS_MS.resolve),
			upload: boundedTimeout(options.timeoutsMs?.upload, SOURCE_TIMEOUTS_MS.upload),
			pipe: boundedTimeout(options.timeoutsMs?.pipe, SOURCE_TIMEOUTS_MS.pipe),
		}
		this.uploads = new ConcurrencyLimit(options.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS)
	}

	async resolve(input: SourceResolveInput): Promise<SourceResolution> {
		const deadline = operationDeadline(input.signal, this.timeouts.resolve)
		try {
			const result = await this.repository.resolve({ ...input, signal: deadline.signal })
			if (input.signal.aborted) throw cancelled('resolve')
			if (deadline.timedOut()) throw operationTimedOut('resolve', true)
			return result
		} catch (error) {
			if (input.signal.aborted) throw cancelled('resolve')
			if (deadline.timedOut()) throw operationTimedOut('resolve', true)
			throw toFailure(error, 'resolve')
		} finally {
			deadline.dispose()
		}
	}

	async upload(input: SourceUploadInput): Promise<SourceUploadResult> {
		if (!this.acceptsDestination(input)) throw new SourceFailure('upload_rejected', 'upload')
		// The deadline starts before the queue, so a waiting upload is bounded like a running one.
		const deadline = operationDeadline(input.signal, this.timeouts.upload)
		try {
			let release: () => void
			try {
				release = await this.uploads.acquire(deadline.signal)
			} catch {
				if (input.signal.aborted) throw cancelled('upload')
				throw operationTimedOut('archive', true)
			}
			try {
				return await this.uploadOne(input, deadline)
			} finally {
				release()
			}
		} finally {
			deadline.dispose()
		}
	}

	/**
	 * A part writer brings its own destination and credentials, so only its part size is checked. A bearer goes only to a
	 * sandbox host's file endpoint, and a sandbox file endpoint is reached only with one.
	 */
	private acceptsDestination(input: SourceUploadInput): boolean {
		if (input.parts !== undefined) {
			const size = input.parts.partBytes
			return Number.isSafeInteger(size) && size >= MIN_SOURCE_PART_BYTES && size <= MAX_SOURCE_PART_BYTES && size % MIN_SOURCE_PART_BYTES === 0
		}
		if (input.uploadBearer === undefined) return this.isUploadDestination(input.uploadUrl)
		return input.uploadBearer !== '' && this.isSandboxUploadDestination !== undefined && this.isSandboxUploadDestination(input.uploadUrl)
	}

	private async uploadOne(input: SourceUploadInput, deadline: OperationDeadline): Promise<SourceUploadResult> {
		const caller = input.signal
		let putStarted = false
		try {
			const archive = await this.repository.archive({
				repository: input.repository,
				commitSha: input.commitSha,
				descriptorSha256: input.descriptorSha256,
				archive: input.archive,
				signal: deadline.signal,
			})
			if (caller.aborted || deadline.timedOut()) {
				archive.dispose()
				await archive.completed.catch(() => {})
				if (caller.aborted) throw cancelled('upload')
				throw operationTimedOut('archive', true)
			}
			let putFailure: unknown
			try {
				putStarted = true
				if (input.parts === undefined) await this.put(input.uploadUrl, input.uploadBearer, archive.body, deadline.signal)
				else await writeParts(input.parts, archive, deadline.signal, this.timeouts.pipe)
			} catch (error) {
				putFailure = error
			}
			archive.dispose()
			let summary: ArchiveSummary | undefined
			let archiveFailure: unknown
			try {
				summary = await archive.completed
			} catch (error) {
				archiveFailure = error
			}
			if (caller.aborted) throw cancelled('upload')
			if (deadline.timedOut()) throw operationTimedOut('upload', false)
			const tooLarge = putFailure instanceof SourceFailure && putFailure.code === 'upload_too_large'
			// A rejected repository aborts the PUT it is already inside, so the archive verdict is the reason. Abandoning the
			// archive after a 413 settles its verdict as `upload_failed`, which must not hide the size refusal.
			if (archiveFailure instanceof SourceFailure && !(tooLarge && archiveFailure.code === 'upload_failed')) throw archiveFailure
			if (tooLarge) throw putFailure
			if (putFailure !== undefined) {
				if (putFailure instanceof Error && putFailure.name === 'AbortError') throw cancelled('upload')
				throw new SourceFailure('upload_failed', 'upload')
			}
			if (summary === undefined) throw new SourceFailure('upload_failed', 'upload')
			return {
				commitSha: summary.commitSha,
				descriptorSha256: summary.descriptorSha256,
				...(summary.dataFileSha256 === undefined ? {} : { dataFileSha256: summary.dataFileSha256 }),
				entryCount: summary.entryCount,
				expandedBytes: summary.expandedBytes,
			}
		} catch (error) {
			if (caller.aborted) throw cancelled('upload')
			if (deadline.timedOut()) throw operationTimedOut(putStarted ? 'upload' : 'archive', !putStarted)
			throw toFailure(error, putStarted ? 'upload' : 'archive')
		}
	}

	private async put(uploadUrl: string, bearer: string | undefined, source: ReadableStream<SourceBytes>, signal: AbortSignal): Promise<void> {
		const combined = linkedController(signal, AbortSignal.timeout(this.timeouts.pipe))
		try {
			let response: Response
			try {
				response = await this.uploadFetch(uploadUrl, {
					method: 'PUT',
					...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/octet-stream' } }),
					body: gzipStream(source),
					duplex: 'half',
					// `manual`, like every GitHub request Control makes (a Worker refuses `redirect: 'error'`, though the upload runs
					// in the Bun process only): a redirect is a response that is not `ok` and fails below.
					redirect: 'manual',
					signal: combined.signal,
				})
			} catch {
				if (signal.aborted) throw cancelled('upload')
				throw new SourceFailure('upload_failed', 'upload')
			}
			if (signal.aborted) throw cancelled('upload')
			if (combined.signal.aborted) throw new SourceFailure('upload_failed', 'upload')
			try {
				await response.body?.cancel()
			} catch {
				if (signal.aborted) throw cancelled('upload')
				throw new SourceFailure('upload_failed', 'upload')
			}
			if (signal.aborted) throw cancelled('upload')
			if (combined.signal.aborted) throw new SourceFailure('upload_failed', 'upload')
			// The sandbox host's nginx answers 413 above 50 MiB; its body is never read.
			if (bearer !== undefined && response.status === 413) throw uploadTooLarge()
			if (!response.ok) throw new SourceFailure('upload_failed', 'upload')
		} finally {
			combined.abort()
		}
	}
}

/**
 * The gzip archive cut into the writer's parts. A full part is handed over only once a further byte shows it is not the
 * last, so the last part always goes to `complete`, which runs only after the archive's verdict passed: a rejected
 * repository never becomes an object, which one streamed PUT cannot promise, and a writer that finalizes with its last
 * part (Cloud Storage's chunk with the total size) cannot finalize early. The part handed over is the writer's, and the
 * transport fills a fresh buffer: one part and one read chunk in memory per upload, besides what the writer keeps.
 *
 * A failure after the writer was first called asks it to drop what may be stored. The pipe's own bound covers the parts
 * and the completion; a failure the caller's signal did not cause is `upload_failed`, as for a PUT, and the archive's
 * own verdict passes through, so the caller still reads it first.
 */
async function writeParts(writer: SourcePartWriter, archive: RepositoryArchive, signal: AbortSignal, pipeMs: number): Promise<void> {
	const combined = linkedController(signal, AbortSignal.timeout(pipeMs))
	const reader = gzipStream(archive.body).getReader()
	// The bound covers the download too: a stalled read ends when it does, as a PUT's body does when its fetch aborts.
	combined.signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true })
	let part = new Uint8Array(writer.partBytes)
	let filled = 0
	let written = 0
	let bytes = 0
	let called = false
	try {
		for (;;) {
			const read = await reader.read()
			if (read.done) {
				// A read the bound cancelled ends as if the archive did; it did not.
				combined.signal.throwIfAborted()
				break
			}
			let offset = 0
			while (offset < read.value.byteLength) {
				if (filled === part.byteLength) {
					// More bytes follow, so this full part is not the last.
					called = true
					await writer.writePart(written, part, combined.signal)
					written += 1
					bytes += filled
					part = new Uint8Array(writer.partBytes)
					filled = 0
				}
				const take = Math.min(read.value.byteLength - offset, part.byteLength - filled)
				part.set(read.value.subarray(offset, offset + take), filled)
				filled += take
				offset += take
			}
		}
		await archive.completed
		called = true
		await writer.complete({ last: part.subarray(0, filled), parts: written + 1, bytes: bytes + filled }, combined.signal)
	} catch (error) {
		await reader.cancel().catch(() => {})
		// Its own short bound: the upload's signal may be the reason it is dropped.
		if (called) await writer.abort(AbortSignal.timeout(PART_ABORT_MS)).catch(() => {})
		if (error instanceof SourceFailure || signal.aborted) throw error
		// The pipe's bound or the writer's own failure: never the caller's cancellation, and never the writer's words.
		throw new SourceFailure('upload_failed', 'upload')
	} finally {
		combined.abort()
	}
}

/** Compress the rewritten tar on the way to the destination; nothing is staged on disk or in memory. */
export function gzipStream(source: ReadableStream<SourceBytes>): ReadableStream<SourceBytes> {
	return pullThrough(source, new CompressionStream('gzip'))
}

/** At most `limit` uploads stream at once; the rest wait in order and leave the queue when their caller aborts. */
export class ConcurrencyLimit {
	private active = 0
	private readonly waiting: { readonly start: () => void }[] = []

	constructor(private readonly limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('source upload concurrency is invalid')
	}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(cancelled('upload'))
		if (this.active < this.limit) {
			this.active++
			return Promise.resolve(this.releaser())
		}
		return new Promise((resolve, reject) => {
			const entry = {
				start: () => {
					signal.removeEventListener('abort', abort)
					this.active++
					resolve(this.releaser())
				},
			}
			const abort = (): void => {
				const index = this.waiting.indexOf(entry)
				if (index !== -1) this.waiting.splice(index, 1)
				reject(cancelled('upload'))
			}
			signal.addEventListener('abort', abort, { once: true })
			this.waiting.push(entry)
		})
	}

	private releaser(): () => void {
		let released = false
		return () => {
			if (released) return
			released = true
			this.active--
			this.waiting.shift()?.start()
		}
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

interface OperationDeadline {
	readonly signal: AbortSignal
	timedOut(): boolean
	dispose(): void
}

/** One wall-clock budget spans every sequential phase while caller cancellation remains authoritative. */
function operationDeadline(caller: AbortSignal, timeoutMs: number): OperationDeadline {
	const controller = new AbortController()
	let timedOut = false
	const callerAborted = (): void => controller.abort()
	caller.addEventListener('abort', callerAborted, { once: true })
	if (caller.aborted) controller.abort()
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose() {
			clearTimeout(timer)
			caller.removeEventListener('abort', callerAborted)
		},
	}
}

function operationTimedOut(stage: SourceFailureStage, beforeUpload: boolean): SourceFailure {
	return new SourceFailure(beforeUpload ? 'internal' : 'upload_failed', stage)
}

function boundedTimeout(value: number | undefined, maximum: number): number {
	const timeout = value ?? maximum
	if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximum) throw new Error('source operation timeout is invalid')
	return timeout
}

/** An unexpected error's message is not ours to forward: it can carry a URL with a token in it. */
function toFailure(error: unknown, stage: SourceFailureStage): SourceFailure {
	if (error instanceof SourceFailure) return error
	if (error instanceof Error && error.name === 'AbortError') return cancelled(stage)
	return new SourceFailure('internal', stage)
}
