// The transport both of AWS's protocols the provider speaks share (ADR-0081): the JSON protocol (`json.ts`: ECS,
// CodeBuild, ECR, SSM, CloudWatch Logs) and the query protocol (`query.ts`: CloudFormation, RDS). One signed `POST /` to
// the service's regional endpoint under one deadline, credentials read per call, no redirect followed (a credentialed
// request: a 3xx is not ok), the answer read up to a bound. An error carries the service's error code, the HTTP status
// and AWS's request id, never the request, the answer's message or a credential: AWS's messages can quote the input.

import { type SigningCredentials, signRequest } from './sigv4'

/** Where the credentials of the next request come from; `@fabrika/platform-node`'s `CredentialProvider` is one. */
export interface AwsCredentialSource {
	current(): Promise<SigningCredentials>
}

/** How a client reaches one service: its endpoint, its region, its credentials, and the bounds of a call. */
export interface AwsClientOptions {
	/** The endpoint's origin; `awsServiceOrigin` gives the commercial partition's. */
	readonly origin: string
	readonly region: string
	readonly credentials: AwsCredentialSource
	/** Sign for an `http:` origin: a local emulator only. */
	readonly allowInsecureOrigin?: boolean
	readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
	readonly now?: () => Date
	/** The deadline of one call, its answer read included. */
	readonly timeoutMs?: number
	/** The largest answer read; a longer one is `answer_too_large`. */
	readonly maxAnswerBytes?: number
}

export const AWS_CALL_TIMEOUT_MS = 30_000
export const AWS_MAX_ANSWER_BYTES = 1024 * 1024

/** The commercial partition's endpoint of `service` in `region`: `https://ecs.eu-central-1.amazonaws.com`. */
export function awsServiceOrigin(service: { readonly service: string }, region: string): string {
	return `https://${service.service}.${region}.amazonaws.com`
}

/**
 * A failed call. `code` is the service's error code (`ClusterNotFoundException`), or the client's own:
 * `invalid_operation` and `invalid_request` (refused before anything is sent), `credentials` (the source failed),
 * `aborted` (the caller's signal), `timeout`, `unreachable`, `redirect`, `answer_too_large`, `invalid_answer`,
 * `unknown` (an error answer without a code of the expected form).
 *
 * `retryable` means a repeat may succeed, not that this attempt had no effect: after `timeout`, `unreachable` or a 5xx
 * a submitting call (`StartBuild`, `UpdateService`) may have taken effect, which is why its caller records a marker
 * first (ADR-0044). Clock skew is not corrected: a host whose clock is off gets `InvalidSignatureException`,
 * `RequestExpired` or `SignatureDoesNotMatch`, not retryable. Fargate keeps its clock.
 */
export class AwsError extends Error {
	override readonly name = 'AwsError'
	constructor(
		readonly operation: string,
		readonly code: string,
		readonly status: number,
		readonly requestId: string | null,
		readonly retryable: boolean,
	) {
		super(`AWS ${operation} failed: ${code}${status === 0 ? '' : ` (HTTP ${status})`}${requestId === null ? '' : `, request ${requestId}`}`)
	}
}

/** An error code as AWS writes it, and the only form a client repeats. */
export const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/
/** An operation's name. */
export const OPERATION = /^[A-Z][A-Za-z0-9]{0,127}$/
/** AWS's request id, repeated only in this form. */
export const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/
/** The codes AWS answers when a repeat may succeed. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	'Throttling',
	'ThrottlingException',
	'ThrottledException',
	'TooManyRequestsException',
	'RequestLimitExceeded',
	'RequestThrottled',
	'RequestThrottledException',
	'ProvisionedThroughputExceededException',
	'ServiceUnavailable',
	'ServiceUnavailableException',
	'InternalFailure',
	'InternalServerError',
	'ServerException',
	'RequestTimeout',
	'RequestTimeoutException',
	'PriorRequestNotComplete',
	'TransactionInProgressException',
	'SlowDown',
	'BandwidthLimitExceeded',
	'EC2ThrottledException',
	// The credential source refreshes before a set expires, so a repeat signs with a fresh one.
	'ExpiredTokenException',
])
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

/** Whether an error answer with `code` and `status` may succeed when repeated. */
export function retryable(code: string, status: number): boolean {
	return RETRYABLE_CODES.has(code) || RETRYABLE_STATUS.has(status)
}

/** `promise`, or a rejection once `signal` aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

/** The body, read as text up to `max` bytes; `null` past it, the rest of the stream cancelled. */
async function boundedText(response: Response, max: number): Promise<string | null> {
	if (response.body === null) return ''
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > max) {
			await reader.cancel().catch(() => {})
			return null
		}
		chunks.push(value)
	}
	const joined = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		joined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(joined)
}

/** An answer AWS sent: its status, its text within the bound, its headers and its request id when it has the form. */
export interface AwsExchange {
	readonly status: number
	readonly ok: boolean
	readonly text: string
	readonly headers: Headers
	readonly requestId: string | null
}

/**
 * One request to send: by default a `POST /`, as the JSON and query protocols send. S3 names its object in the path and
 * its operation in the method and the query, and signs its payload's digest as a header (`bodyDigestHeader`).
 */
export interface AwsExchangeRequest {
	readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
	readonly path?: string
	readonly query?: readonly (readonly [string, string])[]
	readonly headers: Readonly<Record<string, string>>
	readonly body: string | Uint8Array<ArrayBuffer>
	readonly bodyDigestHeader?: boolean
}

/**
 * One signed request of `request` to `service` at `options.origin`, for `operation` (already checked by the caller, which
 * names it in every error). Answers whatever AWS answered, error statuses included, for the protocol to read; throws
 * `AwsError` for everything that is no answer: `aborted`, `credentials`, `invalid_request` (it cannot be signed),
 * `unreachable`, `timeout`, `redirect`, `answer_too_large`.
 */
export async function awsExchange(
	service: string,
	options: AwsClientOptions,
	operation: string,
	request: AwsExchangeRequest,
	signal: AbortSignal | undefined,
): Promise<AwsExchange> {
	const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
	const fail = (code: string, status: number, requestId: string | null, again: boolean): AwsError =>
		new AwsError(operation, code, status, requestId, again)
	if (signal?.aborted === true) throw fail('aborted', 0, null, false)
	const deadline = AbortSignal.timeout(options.timeoutMs ?? AWS_CALL_TIMEOUT_MS)
	const aborted = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
	/** What a failure in flight was: the caller's abort, the deadline, or else `otherwise`. */
	const interrupted = (status: number, requestId: string | null, otherwise: AwsError): AwsError => {
		if (signal?.aborted === true) return fail('aborted', status, requestId, false)
		if (deadline.aborted) return fail('timeout', status, requestId, true)
		return otherwise
	}
	let credentials: SigningCredentials
	try {
		credentials = await untilAborted(options.credentials.current(), aborted)
	} catch {
		throw interrupted(0, null, fail('credentials', 0, null, true))
	}
	let signed: Awaited<ReturnType<typeof signRequest>>
	try {
		signed = await signRequest(
			{
				method: request.method ?? 'POST',
				origin: options.origin,
				path: request.path ?? '/',
				query: request.query ?? [],
				headers: request.headers,
				body: request.body,
			},
			credentials,
			{ region: options.region, service },
			(options.now ?? (() => new Date()))(),
			{ allowInsecureOrigin: options.allowInsecureOrigin === true, bodyDigestHeader: request.bodyDigestHeader === true },
		)
	} catch {
		throw fail('invalid_request', 0, null, false)
	}
	let response: Response
	try {
		response = await send(signed.url, {
			method: request.method ?? 'POST',
			headers: signed.headers,
			body: request.body,
			redirect: 'manual',
			signal: aborted,
		})
	} catch {
		throw interrupted(0, null, fail('unreachable', 0, null, true))
	}
	// The JSON and query protocols name it `x-amzn-RequestId`; S3 names it `x-amz-request-id`.
	const id = response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-request-id')
	const requestId = id !== null && REQUEST_ID.test(id) ? id : null
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {})
		throw fail('redirect', response.status, requestId, false)
	}
	let text: string | null
	try {
		text = await boundedText(response, options.maxAnswerBytes ?? AWS_MAX_ANSWER_BYTES)
	} catch {
		throw interrupted(response.status, requestId, fail('unreachable', response.status, requestId, true))
	}
	if (text === null) throw fail('answer_too_large', response.status, requestId, false)
	return { status: response.status, ok: response.ok, text, headers: response.headers, requestId }
}
