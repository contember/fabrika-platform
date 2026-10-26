import type { ArchiveSummary, SourceBytes } from './archive'
import { cancelled, SourceFailure, type SourceFailureStage } from './failure'
import type { RepositoryArchive, RepositoryArchiveInput } from './repository'
import { pullThrough } from './streams'
import type { SourceResolution, SourceResolveInput, SourceUploadInput, SourceUploadResult } from './types'

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

export interface SourceRepositoryReader {
	resolve(input: SourceResolveInput): Promise<SourceResolution>
	archive(input: RepositoryArchiveInput): Promise<RepositoryArchive>
}

export interface SourceTransportOptions {
	readonly repository: SourceRepositoryReader
	readonly isUploadDestination: (url: string) => boolean
	readonly uploadFetch?: SourceUploadFetch
	readonly maxConcurrentUploads?: number
	/** Tests shorten the bounds; none may exceed the production value. */
	readonly timeoutsMs?: Partial<typeof SOURCE_TIMEOUTS_MS>
}

/** Resolves sources and streams `gunzip → tar rewrite → gzip → PUT` with nothing staged on disk or in memory. */
export class SourceTransport {
	private readonly repository: SourceRepositoryReader
	private readonly isUploadDestination: (url: string) => boolean
	private readonly uploadFetch: SourceUploadFetch
	private readonly timeouts: typeof SOURCE_TIMEOUTS_MS
	private readonly uploads: ConcurrencyLimit

	constructor(options: SourceTransportOptions) {
		this.repository = options.repository
		this.isUploadDestination = options.isUploadDestination
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
		if (!this.isUploadDestination(input.uploadUrl)) throw new SourceFailure('upload_rejected', 'upload')
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
				await this.put(input.uploadUrl, archive.body, deadline.signal)
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
			// A rejected repository aborts the PUT it is already inside, so the archive verdict is the reason.
			if (archiveFailure instanceof SourceFailure) throw archiveFailure
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

	private async put(uploadUrl: string, source: ReadableStream<SourceBytes>, signal: AbortSignal): Promise<void> {
		const combined = linkedController(signal, AbortSignal.timeout(this.timeouts.pipe))
		try {
			let response: Response
			try {
				response = await this.uploadFetch(uploadUrl, {
					method: 'PUT',
					body: gzipStream(source),
					duplex: 'half',
					// Workers refuse `redirect: 'error'`; a redirect is a response that is not `ok` and fails below.
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
			if (combined.signal.aborted || !response.ok) throw new SourceFailure('upload_failed', 'upload')
		} finally {
			combined.abort()
		}
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
