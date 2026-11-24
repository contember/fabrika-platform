// AWS's JSON protocol, which ECS, CodeBuild, ECR, SSM and CloudWatch Logs speak (ADR-0081): one signed `POST /` to the
// service's regional endpoint (`transport.ts`), the operation in `X-Amz-Target`, the input as a JSON body, and the answer
// read with the caller's schema.
//
// UNVERIFIED: the services' target prefixes and JSON versions below follow AWS's published API references; none was
// checked against an account.

import type { z } from 'zod'
import { type AwsClientOptions, AwsError, awsExchange, ERROR_CODE, OPERATION, retryable } from './transport'

export { AWS_CALL_TIMEOUT_MS, AWS_MAX_ANSWER_BYTES, type AwsCredentialSource, AwsError, awsServiceOrigin } from './transport'

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

/** How a JSON client reaches its service: the transport's options. */
export type AwsJsonClientOptions = AwsClientOptions

/** A call of one operation; the answer is read with `answer`. */
export interface AwsJsonClient {
	call<T>(operation: string, input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T>
}

/** The string field `name` of a parsed body, if it has one. */
function field(body: unknown, name: string): string | undefined {
	if (typeof body !== 'object' || body === null || !(name in body)) return undefined
	const value: unknown = Reflect.get(body, name)
	return typeof value === 'string' ? value : undefined
}

/**
 * The error code of a JSON-protocol error answer, in the protocol's order: the `x-amzn-ErrorType` header
 * (`ThrottlingException:http://…`), else the body's `code`, else its `__type` (`com.amazonaws.ecs#ClientException`);
 * the part after `#` and before `:`.
 */
function errorCode(body: unknown, header: string | null): string {
	const raw = header ?? field(body, 'code') ?? field(body, '__type') ?? ''
	const code = (raw.split('#').at(-1) ?? '').split(':')[0] ?? ''
	return ERROR_CODE.test(code) ? code : 'unknown'
}

type Parsed = { readonly valid: true; readonly value: unknown } | { readonly valid: false }

/** An empty answer, which the JSON protocol sends for an operation without output. */
const EMPTY_ANSWER: Parsed = { valid: true, value: {} }

/** The parsed JSON of `text`, or `invalid` when it is none. */
function parsed(text: string): Parsed {
	try {
		const value: unknown = JSON.parse(text)
		return { valid: true, value }
	} catch {
		return { valid: false }
	}
}

/** A client of `service` at `options.origin`, signing each call with the credentials current at that moment. */
export function awsJsonClient(service: AwsJsonService, options: AwsJsonClientOptions): AwsJsonClient {
	return {
		async call<T>(operation: string, input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
			if (!OPERATION.test(operation)) throw new AwsError('(operation)', 'invalid_operation', 0, null, false)
			const fail = (code: string, status: number, requestId: string | null, again: boolean): AwsError =>
				new AwsError(operation, code, status, requestId, again)
			if (signal?.aborted === true) throw fail('aborted', 0, null, false)
			// Serialized once: the body sent is the body signed, whatever the caller changes meanwhile. An input JSON cannot
			// write (a BigInt, a cycle) is the caller's mistake, refused like any other request that cannot be signed.
			let body: string
			try {
				body = JSON.stringify(input)
			} catch {
				throw fail('invalid_request', 0, null, false)
			}
			const headers = {
				'content-type': `application/x-amz-json-${service.jsonVersion}`,
				'x-amz-target': `${service.targetPrefix}.${operation}`,
			}
			const { status, ok, text, requestId, headers: answered } = await awsExchange(service.service, options, operation, { headers, body }, signal)
			if (!ok) {
				const errorBody = parsed(text)
				const code = errorCode(errorBody.valid ? errorBody.value : undefined, answered.get('x-amzn-errortype'))
				throw fail(code, status, requestId, retryable(code, status))
			}
			// An empty answer is an empty object; anything else must be JSON before the schema sees it.
			const content = text === '' ? EMPTY_ANSWER : parsed(text)
			if (!content.valid) throw fail('invalid_answer', status, requestId, false)
			const read = answer.safeParse(content.value)
			if (!read.success) throw fail('invalid_answer', status, requestId, false)
			return read.data
		},
	}
}
