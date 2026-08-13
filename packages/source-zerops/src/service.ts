import {
	buildZeropsSourceCancelResponse,
	buildZeropsSourceCredentialStatusResponse,
	buildZeropsSourceErrorEnvelope,
	buildZeropsSourceResolveInstallationResponse,
	buildZeropsSourceResolveResponse,
	buildZeropsSourceUploadResponse,
	decodeZeropsSourceCancelRequest,
	decodeZeropsSourceCredentialActivateRequest,
	decodeZeropsSourceCredentialStatusRequest,
	decodeZeropsSourceResolveInstallationRequest,
	decodeZeropsSourceResolveRequest,
	decodeZeropsSourceUploadRequest,
	ZEROPS_SOURCE_CANCEL_PATH,
	ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH,
	ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH,
	ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH,
	ZEROPS_SOURCE_UPLOAD_PATH,
	type ZeropsSourceErrorStage,
} from '@fabrika/provider-zerops'
import { createHash, timingSafeEqual } from 'node:crypto'
import { cancelled, SourceFailure } from './failure'
import type { SourceGitHubConnection } from './github-connection'
import { GitRepositorySource, type RepositorySource } from './repository'

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_CREDENTIAL_ACTIVATE_REQUEST_BYTES = 128 * 1024
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_CREDENTIAL_OPERATION_TIMEOUT_MS = 30_000
/** These expire before control's 45 s / 5 min / 20 min RPC deadlines, leaving time for the response. */
export const SOURCE_OPERATION_TIMEOUTS_MS = {
	resolveInstallation: 30_000,
	resolve: 4 * 60_000,
	upload: 15 * 60_000,
}
const UPLOAD_HOST = 'proxy.app-prg1.zerops.io'
const UPLOAD_PATH = '/api/rest/object-storage/upload'
const UPLOAD_PREFIX = `https://${UPLOAD_HOST}${UPLOAD_PATH}?`

export interface SourceUploadRequestInit extends RequestInit {
	duplex: 'half'
}

export type SourceUploadFetch = (
	input: string | URL | Request,
	init: SourceUploadRequestInit,
) => Promise<Response>

export interface ZeropsSourceServiceOptions {
	rpcKey: string
	github?: SourceGitHubConnection
	repository?: RepositorySource
	uploadFetch?: SourceUploadFetch
	uploadTimeoutMs?: number
	credentialTimeoutMs?: number
	operationTimeoutsMs?: {
		resolveInstallation?: number
		resolve?: number
		upload?: number
	}
}

interface RunningUpload {
	appVersionId: string
	controller: AbortController
}

/** Authenticated source transport. No option carries a Zerops API token. */
export class ZeropsSourceService {
	private readonly rpcKeyDigest: Buffer
	private readonly repository: RepositorySource
	private readonly uploadFetch: SourceUploadFetch
	private readonly uploadTimeoutMs: number
	private readonly operationTimeoutsMs: typeof SOURCE_OPERATION_TIMEOUTS_MS
	private readonly credentialTimeoutMs: number
	private readonly github: SourceGitHubConnection | undefined
	private readonly running = new Map<string, RunningUpload>()

	constructor(options: ZeropsSourceServiceOptions) {
		if (options.rpcKey.length < 32 || options.rpcKey.length > 4096) {
			throw new Error(
				'FABRIKA_SOURCE_RPC_KEY must contain 32 to 4096 characters',
			)
		}
		const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
		if (
			!Number.isSafeInteger(uploadTimeoutMs)
			|| uploadTimeoutMs <= 0
			|| uploadTimeoutMs > DEFAULT_UPLOAD_TIMEOUT_MS
		) {
			throw new Error('source upload timeout is invalid')
		}
		this.rpcKeyDigest = digest(options.rpcKey)
		this.repository = options.repository
			?? new GitRepositorySource(
				options.github === undefined ? {} : { github: options.github },
			)
		this.uploadFetch = options.uploadFetch ?? ((input, init) => fetch(input, init))
		this.uploadTimeoutMs = uploadTimeoutMs
		this.credentialTimeoutMs = options.credentialTimeoutMs ?? DEFAULT_CREDENTIAL_OPERATION_TIMEOUT_MS
		validateOperationTimeout(this.credentialTimeoutMs, DEFAULT_CREDENTIAL_OPERATION_TIMEOUT_MS)
		this.operationTimeoutsMs = {
			resolveInstallation: options.operationTimeoutsMs?.resolveInstallation ?? SOURCE_OPERATION_TIMEOUTS_MS.resolveInstallation,
			resolve: options.operationTimeoutsMs?.resolve ?? SOURCE_OPERATION_TIMEOUTS_MS.resolve,
			upload: options.operationTimeoutsMs?.upload ?? SOURCE_OPERATION_TIMEOUTS_MS.upload,
		}
		validateOperationTimeout(this.operationTimeoutsMs.resolveInstallation, SOURCE_OPERATION_TIMEOUTS_MS.resolveInstallation)
		validateOperationTimeout(this.operationTimeoutsMs.resolve, SOURCE_OPERATION_TIMEOUTS_MS.resolve)
		validateOperationTimeout(this.operationTimeoutsMs.upload, SOURCE_OPERATION_TIMEOUTS_MS.upload)
		this.github = options.github
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname
		if (request.method === 'GET' && path === '/healthz') {
			return jsonResponse({ status: 'ok' })
		}
		if (!this.authenticated(request.headers.get('authorization'))) {
			return failureResponse(
				new SourceFailure('unauthorized', 'authenticate', false, 401),
			)
		}
		if (request.method !== 'POST') {
			return failureResponse(
				new SourceFailure('invalid_request', 'validate', false, 405),
			)
		}
		const stage = stageForPath(path)
		if (stage === 'validate') {
			return failureResponse(
				new SourceFailure('invalid_request', 'validate', false, 404),
			)
		}
		const credentialDeadline = stage === 'credentials' ? operationDeadline(request.signal, this.credentialTimeoutMs) : undefined
		const requestSignal = credentialDeadline?.signal ?? request.signal
		try {
			const body = await readRequestJson(
				request,
				path === ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH ? MAX_CREDENTIAL_ACTIVATE_REQUEST_BYTES : MAX_REQUEST_BYTES,
				stage,
				requestSignal,
			)
			switch (path) {
				case ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceCredentialStatusRequest(body))
					if (this.github === undefined) {
						return jsonResponse(buildZeropsSourceCredentialStatusResponse({ connectionId: input.connectionId, state: 'anonymous' }))
					}
					return jsonResponse(await this.github.status(input.connectionId, requestSignal))
				}
				case ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceCredentialActivateRequest(body))
					if (this.github === undefined) throw new SourceFailure('credentials_invalid', 'credentials', false, 503)
					return jsonResponse(
						await this.github.activate(
							input.connectionId,
							input.credentialBundle,
							input.credentialSha256,
							requestSignal,
						),
					)
				}
				case ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceResolveInstallationRequest(body))
					const deadline = operationDeadline(request.signal, this.operationTimeoutsMs.resolveInstallation)
					let githubInstallationId: number | null
					try {
						githubInstallationId = await this.resolveInstallation(
							input.repository.owner,
							input.repository.name,
							deadline.signal,
						)
						if (request.signal.aborted) throw cancelled('resolve-installation')
						if (deadline.timedOut()) throw operationTimedOut('resolve-installation', true)
					} catch (error) {
						if (request.signal.aborted) throw cancelled('resolve-installation')
						if (deadline.timedOut()) throw operationTimedOut('resolve-installation', true)
						throw error
					} finally {
						deadline.dispose()
					}
					return jsonResponse(
						buildZeropsSourceResolveInstallationResponse(githubInstallationId),
					)
				}
				case ZEROPS_SOURCE_RESOLVE_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceResolveRequest(body))
					const deadline = operationDeadline(request.signal, this.operationTimeoutsMs.resolve)
					let result: Awaited<ReturnType<RepositorySource['resolve']>>
					try {
						result = await this.repository.resolve({
							repository: input.repository,
							requestedRef: input.requestedRef,
							...(input.expectedCommitSha === undefined
								? {}
								: { expectedCommitSha: input.expectedCommitSha }),
							...(input.githubInstallationId === undefined
								? {}
								: { githubInstallationId: input.githubInstallationId }),
							descriptorSha256: input.descriptorSha256,
							signal: deadline.signal,
						})
						if (request.signal.aborted) throw cancelled('resolve')
						if (deadline.timedOut()) throw operationTimedOut('resolve', true)
					} catch (error) {
						if (request.signal.aborted) throw cancelled('resolve')
						if (deadline.timedOut()) throw operationTimedOut('resolve', true)
						throw error
					} finally {
						deadline.dispose()
					}
					return jsonResponse(
						buildZeropsSourceResolveResponse({ runId: input.runId, ...result }),
					)
				}
				case ZEROPS_SOURCE_UPLOAD_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceUploadRequest(body))
					validateUploadUrl(input.uploadUrl)
					if (this.running.has(input.runId)) {
						throw new SourceFailure('invalid_request', 'upload', false, 409)
					}
					const controller = linkedController(request.signal)
					const deadline = operationDeadline(controller.signal, this.operationTimeoutsMs.upload)
					this.running.set(input.runId, {
						appVersionId: input.appVersionId,
						controller,
					})
					let putStarted = false
					try {
						const archive = await this.repository.prepareArchive({
							repository: input.repository,
							commitSha: input.commitSha,
							...(input.githubInstallationId === undefined
								? {}
								: { githubInstallationId: input.githubInstallationId }),
							descriptorSha256: input.descriptor.sha256,
							signal: deadline.signal,
						})
						if (controller.signal.aborted || deadline.timedOut()) {
							await archive.cleanup().catch(() => {})
							if (controller.signal.aborted) throw cancelled('upload')
							throw operationTimedOut('archive', true)
						}
						let putFailure: unknown
						try {
							putStarted = true
							await this.upload(
								input.uploadUrl,
								archive.tarPath,
								deadline.signal,
							)
						} catch (error) {
							putFailure = error
						}
						try {
							await archive.cleanup()
						} catch (error) {
							putFailure ??= error
						}
						if (controller.signal.aborted) throw cancelled('upload')
						if (deadline.timedOut()) throw operationTimedOut('upload', false)
						if (putFailure !== undefined) {
							if (
								controller.signal.aborted
								|| (putFailure instanceof Error
									&& putFailure.name === 'AbortError')
							) {
								throw cancelled('upload')
							}
							throw new SourceFailure('upload_failed', 'upload', false, 502)
						}
						return jsonResponse(
							buildZeropsSourceUploadResponse({
								runId: input.runId,
								appVersionId: input.appVersionId,
								commitSha: archive.commitSha,
								descriptorSha256: archive.descriptorSha256,
							}),
						)
					} catch (error) {
						if (controller.signal.aborted) throw cancelled('upload')
						if (deadline.timedOut()) {
							throw operationTimedOut(putStarted ? 'upload' : 'archive', !putStarted)
						}
						throw error
					} finally {
						deadline.dispose()
						this.running.delete(input.runId)
					}
				}
				case ZEROPS_SOURCE_CANCEL_PATH: {
					const input = decodeRequest(() => decodeZeropsSourceCancelRequest(body))
					const running = this.running.get(input.runId)
					if (
						running !== undefined
						&& running.appVersionId === input.appVersionId
					) {
						running.controller.abort()
					}
					return jsonResponse(
						buildZeropsSourceCancelResponse({
							runId: input.runId,
							appVersionId: input.appVersionId,
						}),
					)
				}
			}
		} catch (error) {
			if (request.signal.aborted) return failureResponse(cancelled(stage))
			if (credentialDeadline?.timedOut() === true) {
				return failureResponse(new SourceFailure('internal', 'credentials', true, 504))
			}
			return failureResponse(toFailure(error, stage))
		} finally {
			credentialDeadline?.dispose()
		}
		return failureResponse(
			new SourceFailure('invalid_request', 'validate', false, 404),
		)
	}

	private authenticated(authorization: string | null): boolean {
		const prefix = 'Bearer '
		const presented = authorization?.startsWith(prefix) === true
			? authorization.slice(prefix.length)
			: ''
		return timingSafeEqual(this.rpcKeyDigest, digest(presented))
	}

	private async resolveInstallation(
		owner: string,
		repository: string,
		signal: AbortSignal,
	): Promise<number | null> {
		const github = this.github?.snapshot()?.client
		if (github === undefined) return null
		try {
			return await github.resolveInstallationId(owner, repository, signal)
		} catch (error) {
			if (
				signal.aborted
				|| (error instanceof Error && error.name === 'AbortError')
			) {
				throw cancelled('resolve-installation')
			}
			throw new SourceFailure('internal', 'resolve-installation', true, 502)
		}
	}

	private async upload(
		uploadUrl: string,
		tarPath: string,
		signal: AbortSignal,
	): Promise<void> {
		const timeout = AbortSignal.timeout(this.uploadTimeoutMs)
		const combined = linkedController(signal, timeout)
		try {
			const body = gzipStream(tarPath)
			let response: Response
			try {
				response = await this.uploadFetch(uploadUrl, {
					method: 'PUT',
					body,
					duplex: 'half',
					redirect: 'error',
					signal: combined.signal,
				})
			} catch {
				if (signal.aborted) throw cancelled('upload')
				throw new SourceFailure('upload_failed', 'upload', false, 502)
			}
			if (signal.aborted) throw cancelled('upload')
			if (combined.signal.aborted) {
				throw new SourceFailure('upload_failed', 'upload', false, 502)
			}
			try {
				await response.body?.cancel()
			} catch {
				if (signal.aborted) throw cancelled('upload')
				throw new SourceFailure('upload_failed', 'upload', false, 502)
			}
			if (signal.aborted) throw cancelled('upload')
			if (combined.signal.aborted || !response.ok) {
				throw new SourceFailure('upload_failed', 'upload', false, 502)
			}
		} finally {
			combined.abort()
		}
	}
}

/** Stream a staged tar through gzip without buffering repository contents in memory. */
export function gzipStream(tarPath: string): ReadableStream<Uint8Array> {
	return Bun.file(tarPath).stream().pipeThrough(new CompressionStream('gzip'))
}

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest()
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

function operationTimedOut(stage: ZeropsSourceErrorStage, retryable: boolean): SourceFailure {
	return new SourceFailure(retryable ? 'internal' : 'upload_failed', stage, retryable, retryable ? 504 : 502)
}

function validateOperationTimeout(timeout: number, maximum: number): void {
	if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximum) {
		throw new Error('source operation timeout is invalid')
	}
}

export function validateUploadUrl(value: string): void {
	if (!value.startsWith(UPLOAD_PREFIX)) {
		throw new SourceFailure('upload_rejected', 'validate', false, 400)
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new SourceFailure('upload_rejected', 'validate', false, 400)
	}
	if (
		url.protocol !== 'https:'
		|| url.hostname !== UPLOAD_HOST
		|| url.port !== ''
		|| url.pathname !== UPLOAD_PATH
		|| url.search === ''
		|| url.username !== ''
		|| url.password !== ''
		|| url.hash !== ''
	) {
		throw new SourceFailure('upload_rejected', 'validate', false, 400)
	}
}

async function readRequestJson(
	request: Request,
	maximumBytes: number,
	stage: ZeropsSourceErrorStage,
	signal: AbortSignal,
): Promise<unknown> {
	if (signal.aborted) throw cancelled(stage)
	const length = request.headers.get('content-length')
	if (
		length !== null
		&& /^[0-9]+$/.test(length)
		&& Number(length) > maximumBytes
	) {
		throw new SourceFailure('invalid_request', 'validate', false, 413)
	}
	const reader = request.body?.getReader()
	if (reader === undefined) {
		throw new SourceFailure('invalid_request', 'validate', false, 400)
	}
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readRequestChunk(reader, signal, stage)
			if (signal.aborted) throw cancelled(stage)
			if (result.done) break
			total += result.value.byteLength
			if (total > maximumBytes) {
				throw new SourceFailure('invalid_request', 'validate', false, 413)
			}
			chunks.push(result.value)
		}
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		const parsed: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		)
		return parsed
	} catch {
		throw new SourceFailure('invalid_request', 'validate', false, 400)
	}
}

function readRequestChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
	stage: ZeropsSourceErrorStage,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) return Promise.reject(cancelled(stage))
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			cleanup()
			void reader.cancel().catch(() => {})
			reject(cancelled(stage))
		}
		const cleanup = (): void => signal.removeEventListener('abort', abort)
		signal.addEventListener('abort', abort, { once: true })
		reader.read().then(
			(result) => {
				cleanup()
				resolve(result.done ? { done: true, value: undefined } : { done: false, value: result.value })
			},
			() => {
				cleanup()
				reject(signal.aborted ? cancelled(stage) : new SourceFailure('invalid_request', 'validate', false, 400))
			},
		)
	})
}

function toFailure(
	error: unknown,
	stage: ZeropsSourceErrorStage,
): SourceFailure {
	if (error instanceof SourceFailure) return error
	if (error instanceof Error && error.name === 'AbortError') {
		return cancelled(stage)
	}
	return new SourceFailure('internal', stage, true, 500)
}

function decodeRequest<T>(decode: () => T): T {
	try {
		return decode()
	} catch {
		throw new SourceFailure('invalid_request', 'validate', false, 400)
	}
}

function stageForPath(path: string): ZeropsSourceErrorStage {
	if (path === ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH) {
		return 'resolve-installation'
	}
	if (path === ZEROPS_SOURCE_RESOLVE_PATH) return 'resolve'
	if (path === ZEROPS_SOURCE_UPLOAD_PATH) return 'upload'
	if (path === ZEROPS_SOURCE_CANCEL_PATH) return 'cancel'
	if (path === ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH || path === ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH) return 'credentials'
	return 'validate'
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

function failureResponse(failure: SourceFailure): Response {
	return jsonResponse(
		buildZeropsSourceErrorEnvelope(
			failure.code,
			failure.stage,
			failure.retryable,
		),
		failure.status,
	)
}
