import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceCredentialActivateRequest,
	buildZeropsSourceCredentialActivateRequestV2,
	buildZeropsSourceCredentialStatusRequest,
	buildZeropsSourceCredentialStatusRequestV2,
	buildZeropsSourceInstallationsVerifyRequest,
	buildZeropsSourceResolveInstallationRequest,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceResolveRequestV2,
	buildZeropsSourceUploadRequest,
	buildZeropsSourceUploadRequestV2,
	buildZeropsSourceWebhookConfigureRequest,
	decodeZeropsSourceCancelResponse,
	decodeZeropsSourceCredentialActivateResponse,
	decodeZeropsSourceCredentialActivateResponseV2,
	decodeZeropsSourceCredentialStatusResponse,
	decodeZeropsSourceCredentialStatusResponseV2,
	decodeZeropsSourceErrorEnvelope,
	decodeZeropsSourceInstallationsVerifyResponse,
	decodeZeropsSourceResolveInstallationResponse,
	decodeZeropsSourceResolveResponse,
	decodeZeropsSourceResolveResponseV2,
	decodeZeropsSourceUploadResponse,
	decodeZeropsSourceUploadResponseV2,
	decodeZeropsSourceWebhookConfigureResponse,
	ZEROPS_SOURCE_CANCEL_PATH,
	ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH,
	ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
	ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH,
	ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
	ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH,
	ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH_V2,
	ZEROPS_SOURCE_UPLOAD_PATH,
	ZEROPS_SOURCE_UPLOAD_PATH_V2,
	ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH,
	type ZeropsSourceCancelInput,
	type ZeropsSourceClient,
	type ZeropsSourceClientV2,
	type ZeropsSourceCredentialActivateInput,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialActivateResponseV2,
	type ZeropsSourceCredentialManager,
	type ZeropsSourceCredentialManagerV2,
	type ZeropsSourceCredentialStatusInput,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceCredentialStatusResponseV2,
	type ZeropsSourceErrorCode,
	type ZeropsSourceErrorStage,
	type ZeropsSourceInstallationsVerifyInput,
	type ZeropsSourceInstallationsVerifyResponseV1,
	type ZeropsSourceResolveInput,
	type ZeropsSourceResolveInputV2,
	type ZeropsSourceResolveResult,
	type ZeropsSourceUploadInput,
	type ZeropsSourceUploadInputV2,
	type ZeropsSourceUploadResult,
	type ZeropsSourceWebhookConfigureInput,
	type ZeropsSourceWebhookConfigureResponseV1,
} from '@fabrika/provider-zerops'

const MIN_RPC_KEY_LENGTH = 32
const MALFORMED = Symbol('malformed source response')
export const ZEROPS_SOURCE_RESPONSE_MAX_BYTES = 64 * 1024
export const ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS = {
	resolveInstallation: 45_000,
	resolve: 5 * 60_000,
	upload: 20 * 60_000,
	cancel: 30_000,
	activateCredentials: 60_000,
	credentialStatus: 30_000,
	configureWebhook: 30_000,
	verifyInstallations: 30_000,
}

interface SourceResponse {
	status: number
	value: unknown
}

export type ZeropsSourceClientOperation =
	| 'resolve-installation'
	| 'resolve'
	| 'resolve-v2'
	| 'upload'
	| 'upload-v2'
	| 'cancel'
	| 'activate-credentials'
	| 'credential-status'
	| 'activate-credentials-v2'
	| 'credential-status-v2'
	| 'configure-webhook'
	| 'verify-installations'
export type ZeropsSourceClientErrorCode = ZeropsSourceErrorCode | 'transport_error' | 'invalid_response'
export type ZeropsSourceClientErrorStage = ZeropsSourceErrorStage | 'transport'

export type ZeropsSourceFetch = (input: string, init: RequestInit) => Promise<Response>

export interface HttpZeropsSourceClientOptions {
	origin: string
	rpcKey: string
	fetch?: ZeropsSourceFetch
	timeoutsMs?: {
		resolveInstallation?: number
		resolve?: number
		upload?: number
		cancel?: number
		activateCredentials?: number
		credentialStatus?: number
		configureWebhook?: number
		verifyInstallations?: number
	}
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

export class HttpZeropsSourceClient
	implements ZeropsSourceClient, ZeropsSourceClientV2, ZeropsSourceCredentialManager, ZeropsSourceCredentialManagerV2
{
	private readonly origin: string
	private readonly rpcKey: string
	private readonly fetchImpl: ZeropsSourceFetch
	private readonly timeoutsMs: typeof ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS

	constructor(options: HttpZeropsSourceClientOptions) {
		this.origin = sourceOrigin(options.origin)
		if (options.rpcKey.length < MIN_RPC_KEY_LENGTH) {
			throw new Error(`source RPC key must contain at least ${MIN_RPC_KEY_LENGTH} characters`)
		}
		this.rpcKey = options.rpcKey
		this.fetchImpl = options.fetch ?? globalThis.fetch
		this.timeoutsMs = {
			resolveInstallation: options.timeoutsMs?.resolveInstallation ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.resolveInstallation,
			resolve: options.timeoutsMs?.resolve ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.resolve,
			upload: options.timeoutsMs?.upload ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.upload,
			cancel: options.timeoutsMs?.cancel ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.cancel,
			activateCredentials: options.timeoutsMs?.activateCredentials ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.activateCredentials,
			credentialStatus: options.timeoutsMs?.credentialStatus ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.credentialStatus,
			configureWebhook: options.timeoutsMs?.configureWebhook ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.configureWebhook,
			verifyInstallations: options.timeoutsMs?.verifyInstallations ?? ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS.verifyInstallations,
		}
		for (const timeout of Object.values(this.timeoutsMs)) {
			if (!Number.isSafeInteger(timeout) || timeout <= 0) {
				throw new Error('source RPC timeouts must be positive integers')
			}
		}
	}

	async resolveInstallationId(repoUrl: string, signal: AbortSignal = new AbortController().signal): Promise<number | null> {
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

	async resolveV2(input: ZeropsSourceResolveInputV2): Promise<ZeropsSourceResolveResult> {
		const operation = 'resolve-v2'
		const request = this.build(operation, () => buildZeropsSourceResolveRequestV2(input))
		const result = await this.post(operation, ZEROPS_SOURCE_RESOLVE_PATH_V2, request, input.signal)
		try {
			const response = decodeZeropsSourceResolveResponseV2(result.value)
			if (
				response.runId !== input.runId
				|| response.descriptorSha256 !== input.descriptorSha256
				|| (input.expectedCommitSha !== undefined && response.commitSha !== input.expectedCommitSha)
			) throw invalidResponse(operation, result.status)
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

	async uploadV2(input: ZeropsSourceUploadInputV2): Promise<ZeropsSourceUploadResult> {
		const operation = 'upload-v2'
		const request = this.build(operation, () => buildZeropsSourceUploadRequestV2(input))
		const result = await this.post(operation, ZEROPS_SOURCE_UPLOAD_PATH_V2, request, input.signal)
		try {
			const response = decodeZeropsSourceUploadResponseV2(result.value)
			if (
				response.runId !== input.runId
				|| response.appVersionId !== input.appVersionId
				|| response.commitSha !== input.commitSha
				|| response.descriptorSha256 !== input.descriptor.sha256
			) throw invalidResponse(operation, result.status)
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

	async activate(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV1> {
		const operation = 'activate-credentials'
		const request = this.build(operation, () => buildZeropsSourceCredentialActivateRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceCredentialActivateResponse(result.value)
			if (response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256) {
				throw invalidResponse(operation, result.status)
			}
			return response
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async activateV2(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV2> {
		const operation = 'activate-credentials-v2'
		const request = this.build(operation, () => buildZeropsSourceCredentialActivateRequestV2(input))
		const result = await this.post(operation, ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2, request, input.signal)
		try {
			const response = decodeZeropsSourceCredentialActivateResponseV2(result.value)
			if (response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256) {
				throw invalidResponse(operation, result.status)
			}
			return response
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async status(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV1> {
		const operation = 'credential-status'
		const request = this.build(operation, () => buildZeropsSourceCredentialStatusRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceCredentialStatusResponse(result.value)
			if (response.connectionId !== input.connectionId) throw invalidResponse(operation, result.status)
			return response
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async statusV2(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV2> {
		const operation = 'credential-status-v2'
		const request = this.build(operation, () => buildZeropsSourceCredentialStatusRequestV2(input))
		const result = await this.post(operation, ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2, request, input.signal)
		try {
			const response = decodeZeropsSourceCredentialStatusResponseV2(result.value)
			if (response.connectionId !== input.connectionId) throw invalidResponse(operation, result.status)
			return response
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async configureWebhook(input: ZeropsSourceWebhookConfigureInput): Promise<ZeropsSourceWebhookConfigureResponseV1> {
		const operation = 'configure-webhook'
		const request = this.build(operation, () => buildZeropsSourceWebhookConfigureRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceWebhookConfigureResponse(result.value)
			if (
				response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256
				|| response.webhook.url !== input.url
			) throw invalidResponse(operation, result.status)
			return response
		} catch (error) {
			if (error instanceof ZeropsSourceClientError) throw error
			throw invalidResponse(operation, result.status)
		}
	}

	async verifyInstallations(input: ZeropsSourceInstallationsVerifyInput): Promise<ZeropsSourceInstallationsVerifyResponseV1> {
		const operation = 'verify-installations'
		const request = this.build(operation, () => buildZeropsSourceInstallationsVerifyRequest(input))
		const result = await this.post(operation, ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH, request, input.signal)
		try {
			const response = decodeZeropsSourceInstallationsVerifyResponse(result.value)
			if (
				response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256
				|| !installationResponseMatchesScope(response, input)
			) {
				throw invalidResponse(operation, result.status)
			}
			return response
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
		const deadline = linkedDeadline(signal, timeoutFor(operation, this.timeoutsMs))
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
				signal: deadline.signal,
			})
		} catch {
			deadline.dispose()
			if (signal.aborted) throw abortError()
			if (deadline.timedOut()) throw transportError(operation)
			throw new ZeropsSourceClientError(operation, null, 'transport_error', 'transport', transportRetryable(operation))
		}

		try {
			const value = await readResponseJson(response, deadline.signal)
			if (signal.aborted) throw abortError()
			if (deadline.timedOut()) throw transportError(operation)
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
		} finally {
			deadline.dispose()
		}
	}
}

const timeoutFor = (operation: ZeropsSourceClientOperation, timeouts: typeof ZEROPS_SOURCE_REQUEST_TIMEOUTS_MS): number => {
	if (operation === 'resolve-installation') return timeouts.resolveInstallation
	if (operation === 'activate-credentials' || operation === 'activate-credentials-v2') return timeouts.activateCredentials
	if (operation === 'credential-status' || operation === 'credential-status-v2') return timeouts.credentialStatus
	if (operation === 'configure-webhook') return timeouts.configureWebhook
	if (operation === 'verify-installations') return timeouts.verifyInstallations
	if (operation === 'resolve-v2') return timeouts.resolve
	if (operation === 'upload-v2') return timeouts.upload
	return timeouts[operation]
}

interface LinkedDeadline {
	readonly signal: AbortSignal
	timedOut(): boolean
	dispose(): void
}

const linkedDeadline = (caller: AbortSignal, timeoutMs: number): LinkedDeadline => {
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
	new ZeropsSourceClientError(operation, status, 'invalid_response', 'transport', transportRetryable(operation) && status >= 500)

const transportError = (operation: ZeropsSourceClientOperation): ZeropsSourceClientError =>
	new ZeropsSourceClientError(operation, null, 'transport_error', 'transport', transportRetryable(operation))

const transportRetryable = (operation: ZeropsSourceClientOperation): boolean =>
	operation !== 'upload'
	&& operation !== 'upload-v2'
	&& operation !== 'activate-credentials'
	&& operation !== 'activate-credentials-v2'
	&& operation !== 'configure-webhook'

const installationResponseMatchesScope = (
	response: ZeropsSourceInstallationsVerifyResponseV1,
	input: ZeropsSourceInstallationsVerifyInput,
): boolean => {
	if (response.installation.status === 'missing') return true
	const account = response.installation.accountLogin.toLowerCase()
	if (input.scope.kind === 'organization') return account === input.scope.organization.toLowerCase()
	return input.scope.repositories.every((repository) => repository.owner.toLowerCase() === account)
}

const abortError = (): DOMException => new DOMException('The source request was aborted', 'AbortError')

const readResponseJson = async (response: Response, signal: AbortSignal): Promise<unknown | typeof MALFORMED> => {
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
	const abortRead = (): void => {
		void reader.cancel().catch(() => {})
	}
	signal.addEventListener('abort', abortRead, { once: true })
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			if (signal.aborted) {
				await reader.cancel().catch(() => {})
				return MALFORMED
			}
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
	} finally {
		signal.removeEventListener('abort', abortRead)
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
