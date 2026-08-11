import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceResolveInstallationRequest,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceUploadRequest,
	decodeZeropsSourceCancelResponse,
	decodeZeropsSourceErrorEnvelope,
	decodeZeropsSourceResolveInstallationResponse,
	decodeZeropsSourceResolveResponse,
	decodeZeropsSourceUploadResponse,
	ZEROPS_SOURCE_CANCEL_PATH,
	ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH,
	ZEROPS_SOURCE_UPLOAD_PATH,
	type ZeropsSourceCancelInput,
	type ZeropsSourceClient,
	type ZeropsSourceErrorCode,
	type ZeropsSourceErrorStage,
	type ZeropsSourceResolveInput,
	type ZeropsSourceResolveResult,
	type ZeropsSourceUploadInput,
	type ZeropsSourceUploadResult,
} from '@fabrika/provider-zerops'

const MIN_RPC_KEY_LENGTH = 32
const MALFORMED = Symbol('malformed source response')
export const ZEROPS_SOURCE_RESPONSE_MAX_BYTES = 64 * 1024

interface SourceResponse {
	status: number
	value: unknown
}

export type ZeropsSourceClientOperation = 'resolve-installation' | 'resolve' | 'upload' | 'cancel'
export type ZeropsSourceClientErrorCode = ZeropsSourceErrorCode | 'transport_error' | 'invalid_response'
export type ZeropsSourceClientErrorStage = ZeropsSourceErrorStage | 'transport'

export type ZeropsSourceFetch = (input: string, init: RequestInit) => Promise<Response>

export interface HttpZeropsSourceClientOptions {
	origin: string
	rpcKey: string
	fetch?: ZeropsSourceFetch
}

/** A detail-free transport failure. It deliberately carries no cause, request, response body, or URL. */
export class ZeropsSourceClientError extends Error {
	constructor(
		readonly operation: ZeropsSourceClientOperation,
		readonly status: number | null,
		readonly code: ZeropsSourceClientErrorCode,
		readonly stage: ZeropsSourceClientErrorStage,
		readonly retryable: boolean,
	) {
		super(`source ${operation} failed (status=${status ?? 'none'}, code=${code}, stage=${stage}, retryable=${retryable})`)
		this.name = 'ZeropsSourceClientError'
	}
}

export class HttpZeropsSourceClient implements ZeropsSourceClient {
	private readonly origin: string
	private readonly rpcKey: string
	private readonly fetchImpl: ZeropsSourceFetch

	constructor(options: HttpZeropsSourceClientOptions) {
		this.origin = sourceOrigin(options.origin)
		if (options.rpcKey.length < MIN_RPC_KEY_LENGTH) {
			throw new Error(`source RPC key must contain at least ${MIN_RPC_KEY_LENGTH} characters`)
		}
		this.rpcKey = options.rpcKey
		this.fetchImpl = options.fetch ?? globalThis.fetch
	}

	async resolveInstallationId(repoUrl: string, signal: AbortSignal): Promise<number | null> {
		const operation = 'resolve-installation'
		const request = this.build(operation, () => buildZeropsSourceResolveInstallationRequest(repoUrl))
		const result = await this.post(operation, ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH, request, signal)
		try {
			return decodeZeropsSourceResolveInstallationResponse(result.value).githubInstallationId
		} catch {
			throw invalidResponse(operation, result.status)
		}
	}

	async resolve(input: ZeropsSourceResolveInput): Promise<ZeropsSourceResolveResult> {
		const operation = 'resolve'
		const request = this.build(operation, () => buildZeropsSourceResolveRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_RESOLVE_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceResolveResponse(result.value)
			if (
				response.runId !== input.runId
				|| response.descriptorSha256 !== input.descriptorSha256
				|| (input.expectedCommitSha !== undefined && response.commitSha !== input.expectedCommitSha)
			) {
				throw invalidResponse(operation, result.status)
			}
			return {
				runId: response.runId,
				commitSha: response.commitSha,
				descriptorSha256: response.descriptorSha256,
			}
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async upload(input: ZeropsSourceUploadInput): Promise<ZeropsSourceUploadResult> {
		const operation = 'upload'
		const request = this.build(operation, () => buildZeropsSourceUploadRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_UPLOAD_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceUploadResponse(result.value)
			if (
				response.runId !== input.runId
				|| response.appVersionId !== input.appVersionId
				|| response.commitSha !== input.commitSha
				|| response.descriptorSha256 !== input.descriptor.sha256
			) {
				throw invalidResponse(operation, result.status)
			}
			return {
				runId: response.runId,
				appVersionId: response.appVersionId,
				commitSha: response.commitSha,
				descriptorSha256: response.descriptorSha256,
			}
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async cancel(input: ZeropsSourceCancelInput): Promise<void> {
		const operation = 'cancel'
		const request = this.build(operation, () => buildZeropsSourceCancelRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_CANCEL_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceCancelResponse(result.value)
			if (response.runId !== input.runId || response.appVersionId !== input.appVersionId) {
				throw invalidResponse(operation, result.status)
			}
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	private build<T>(operation: ZeropsSourceClientOperation, builder: () => T): T {
		try {
			return builder()
		} catch {
			throw new ZeropsSourceClientError(operation, null, 'invalid_request', 'validate', false)
		}
	}

	private async post(operation: ZeropsSourceClientOperation, path: string, body: unknown, signal: AbortSignal): Promise<SourceResponse> {
		if (signal.aborted) throw abortError()
		let response: Response
		try {
			response = await this.fetchImpl(`${this.origin}${path}`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${this.rpcKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				redirect: 'error',
				signal,
			})
		} catch {
			if (signal.aborted) throw abortError()
			throw new ZeropsSourceClientError(operation, null, 'transport_error', 'transport', operation !== 'upload')
		}

		const value = await readResponseJson(response)
		if (signal.aborted) throw abortError()
		if (!response.ok) {
			if (value !== MALFORMED) {
				try {
					const envelope = decodeZeropsSourceErrorEnvelope(value)
					throw new ZeropsSourceClientError(
						operation,
						response.status,
						envelope.error.code,
						envelope.error.stage,
						envelope.error.retryable,
					)
				} catch (error) {
					if (error instanceof ZeropsSourceClientError) throw error
				}
			}
			throw invalidResponse(operation, response.status)
		}
		if (value === MALFORMED) throw invalidResponse(operation, response.status)
		return { status: response.status, value }
	}
}

const sourceOrigin = (origin: string): string => {
	let parsed: URL
	try {
		parsed = new URL(origin)
	} catch {
		throw new Error('source RPC origin must be a bare HTTP(S) origin')
	}
	if (
		origin.trim() !== origin
		|| origin.includes('?')
		|| origin.includes('#')
		|| (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		|| parsed.username !== ''
		|| parsed.password !== ''
		|| parsed.pathname !== '/'
		|| parsed.search !== ''
		|| parsed.hash !== ''
	) {
		throw new Error('source RPC origin must be a bare HTTP(S) origin')
	}
	return parsed.origin
}

const invalidResponse = (operation: ZeropsSourceClientOperation, status: number): ZeropsSourceClientError =>
	new ZeropsSourceClientError(operation, status, 'invalid_response', 'transport', operation !== 'upload' && status >= 500)

const abortError = (): DOMException => new DOMException('The source request was aborted', 'AbortError')

const readResponseJson = async (response: Response): Promise<unknown | typeof MALFORMED> => {
	const declaredLength = response.headers.get('content-length')
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength)
		if (Number.isFinite(parsedLength) && parsedLength > ZEROPS_SOURCE_RESPONSE_MAX_BYTES) {
			await response.body?.cancel().catch(() => {})
			return MALFORMED
		}
	}
	if (response.body === null) return MALFORMED
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const result = await reader.read()
			if (result.done) break
			length += result.value.byteLength
			if (length > ZEROPS_SOURCE_RESPONSE_MAX_BYTES) {
				await reader.cancel().catch(() => {})
				return MALFORMED
			}
			chunks.push(result.value)
		}
	} catch {
		return MALFORMED
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		const value: unknown = JSON.parse(text)
		return value
	} catch {
		return MALFORMED
	}
}
