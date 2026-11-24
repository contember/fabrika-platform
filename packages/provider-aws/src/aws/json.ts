// AWS's JSON protocol, which ECS, CodeBuild, ECR, SSM and CloudWatch Logs speak (ADR-0081): one signed `POST /` to the
// service's regional endpoint, the operation in `X-Amz-Target`, the input as a JSON body, and the answer read with the
// caller's schema. A credentialed request, so it follows no redirect and a 3xx is not ok. An error carries the
// service's error code, the HTTP status and AWS's request id, never the request, the answer's message or a credential:
// AWS's messages can quote the input.
//
// UNVERIFIED: the services' target prefixes and JSON versions below follow AWS's published API references; none was
// checked against an account.

import type { z } from 'zod'
import { type SigningCredentials, signRequest } from './sigv4'

/** One service of the JSON protocol: the name it signs for, the prefix of its operations and its JSON version. */
export interface AwsJsonService {
	/** The signing name and the endpoint's first label: `ecs`, `codebuild`, `ecr`, `ssm`, `logs`. */
	readonly service: string
	/** `X-Amz-Target` is `<targetPrefix>.<operation>`. */
	readonly targetPrefix: string
	readonly jsonVersion: '1.0' | '1.1'
}

export const ECS: AwsJsonService = { service: 'ecs', targetPrefix: 'AmazonEC2ContainerServiceV20141113', jsonVersion: '1.1' }
export const CODEBUILD: AwsJsonService = { service: 'codebuild', targetPrefix: 'CodeBuild_20161006', jsonVersion: '1.1' }
export const ECR: AwsJsonService = { service: 'ecr', targetPrefix: 'AmazonEC2ContainerRegistry_V20150921', jsonVersion: '1.1' }
export const SSM: AwsJsonService = { service: 'ssm', targetPrefix: 'AmazonSSM', jsonVersion: '1.1' }
export const LOGS: AwsJsonService = { service: 'logs', targetPrefix: 'Logs_20140328', jsonVersion: '1.1' }

/** Where the credentials of the next request come from; `@fabrika/platform-node`'s `CredentialProvider` is one. */
export interface AwsCredentialSource {
	current(): Promise<SigningCredentials>
}

export interface AwsJsonClientOptions {
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
export function awsServiceOrigin(service: AwsJsonService, region: string): string {
	return `https://${service.service}.${region}.amazonaws.com`
}

/**
 * A failed call. `code` is the service's error code (`ClusterNotFoundException`), or the client's own: `redirect`,
 * `unreachable`, `timeout`, `answer_too_large`, `invalid_answer`, `unknown`.
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

/** A call of one operation; the answer is read with `answer`. */
export interface AwsJsonClient {
	call<T>(operation: string, input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T>
}

/** An error code as AWS writes it, and the only form this client repeats. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/
/** An operation's name. */
const OPERATION = /^[A-Z][A-Za-z0-9]{0,127}$/
/** AWS's request id, repeated only in this form. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/
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
])
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

/**
 * The error code of a JSON-protocol error answer: the body's `__type` (`com.amazonaws.ecs#ClientException`), else the
 * `x-amzn-ErrorType` header (`ThrottlingException:http://…`); the part after `#` and before `:`.
 */
function errorCode(body: unknown, header: string | null): string {
	const typed = typeof body === 'object' && body !== null && '__type' in body ? body.__type : undefined
	const raw = typeof typed === 'string' ? typed : header ?? ''
	const code = (raw.split('#').at(-1) ?? '').split(':')[0] ?? ''
	return ERROR_CODE.test(code) ? code : 'unknown'
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

function parsed(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** A client of `service` at `options.origin`, signing each call with the credentials current at that moment. */
export function awsJsonClient(service: AwsJsonService, options: AwsJsonClientOptions): AwsJsonClient {
	const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
	const now = options.now ?? (() => new Date())
	const timeoutMs = options.timeoutMs ?? AWS_CALL_TIMEOUT_MS
	const maxAnswerBytes = options.maxAnswerBytes ?? AWS_MAX_ANSWER_BYTES
	const scope = { region: options.region, service: service.service }
	return {
		async call<T>(operation: string, input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
			if (!OPERATION.test(operation)) throw new AwsError('(operation)', 'invalid_operation', 0, null, false)
			const fail = (code: string, status: number, requestId: string | null, retryable: boolean): AwsError =>
				new AwsError(operation, code, status, requestId, retryable)
			const deadline = AbortSignal.timeout(timeoutMs)
			const aborted = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
			const signed = await signRequest(
				{
					method: 'POST',
					origin: options.origin,
					path: '/',
					headers: {
						'content-type': `application/x-amz-json-${service.jsonVersion}`,
						'x-amz-target': `${service.targetPrefix}.${operation}`,
					},
					body: JSON.stringify(input),
				},
				await options.credentials.current(),
				scope,
				now(),
				{ allowInsecureOrigin: options.allowInsecureOrigin === true },
			)
			let response: Response
			try {
				response = await send(signed.url, {
					method: 'POST',
					headers: signed.headers,
					body: JSON.stringify(input),
					redirect: 'manual',
					signal: aborted,
				})
			} catch {
				throw deadline.aborted ? fail('timeout', 0, null, true) : fail('unreachable', 0, null, true)
			}
			const id = response.headers.get('x-amzn-requestid')
			const requestId = id !== null && REQUEST_ID.test(id) ? id : null
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {})
				throw fail('redirect', response.status, requestId, false)
			}
			let text: string | null
			try {
				text = await boundedText(response, maxAnswerBytes)
			} catch {
				throw deadline.aborted ? fail('timeout', response.status, requestId, true) : fail('unreachable', response.status, requestId, true)
			}
			if (text === null) throw fail('answer_too_large', response.status, requestId, false)
			if (!response.ok) {
				const code = errorCode(parsed(text), response.headers.get('x-amzn-errortype'))
				throw fail(code, response.status, requestId, RETRYABLE_CODES.has(code) || RETRYABLE_STATUS.has(response.status))
			}
			const read = answer.safeParse(text === '' ? {} : parsed(text))
			if (!read.success) throw fail('invalid_answer', response.status, requestId, false)
			return read.data
		},
	}
}
