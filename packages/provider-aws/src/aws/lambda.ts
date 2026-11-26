// AWS Lambda's `Invoke`, the one Lambda call Control makes: it asks the installation's task runner
// (`installation/task-runner.ts`) to start a one-off task, which Control's role may not start itself. One signed
// `POST /2015-03-31/functions/<name>/invocations` (`transport.ts`), the input as a JSON body, the answer read with the
// caller's schema. A function that threw answers 200 with `X-Amz-Function-Error`; its error is its `errorType` alone,
// never its `errorMessage`, which can quote the input.
//
// UNVERIFIED: the path, the headers and the function error's form follow Lambda's API reference, and that the Node.js
// runtime reports a thrown error's `name` as `errorType`; none was checked against an account.

import type { z } from 'zod'
import { type AwsClientOptions, AwsError, awsExchange, ERROR_CODE, retryable } from './transport'

/** Lambda's signing name and the endpoint's first label. */
export const LAMBDA = { service: 'lambda' }

/** A function's name: letters, digits, hyphens and underscores. A name, not an ARN, keeps the path free of escapes. */
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** One function of the caller's account and region, invoked and answered synchronously. */
export interface AwsFunction {
	invoke<T>(input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T>
}

/** The parsed JSON of `text`, or `undefined` when it is none. */
function parsed(text: string): { readonly value: unknown } | undefined {
	try {
		const value: unknown = JSON.parse(text)
		return { value }
	} catch {
		return undefined
	}
}

/** The function `name` at `options.origin`, signing each call with the credentials current at that moment. */
export function lambdaFunction(options: AwsClientOptions, name: string): AwsFunction {
	const operation = 'Invoke'
	return {
		async invoke<T>(input: Readonly<Record<string, unknown>>, answer: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
			const fail = (code: string, status: number, requestId: string | null, again: boolean): AwsError =>
				new AwsError(operation, code, status, requestId, again)
			if (!FUNCTION_NAME.test(name)) throw fail('invalid_request', 0, null, false)
			let body: string
			try {
				body = JSON.stringify(input)
			} catch {
				throw fail('invalid_request', 0, null, false)
			}
			const { status, ok, text, requestId, headers } = await awsExchange(
				LAMBDA.service,
				options,
				operation,
				{
					path: `/2015-03-31/functions/${name}/invocations`,
					headers: { 'content-type': 'application/json', 'x-amz-invocation-type': 'RequestResponse' },
					body,
				},
				signal,
			)
			if (!ok) {
				const code = (headers.get('x-amzn-errortype') ?? '').split(':')[0] ?? ''
				const known = ERROR_CODE.test(code) ? code : 'unknown'
				throw fail(known, status, requestId, retryable(known, status))
			}
			const content = text === '' ? undefined : parsed(text)
			if (headers.get('x-amz-function-error') !== null) {
				// The function threw: its `errorType` names why (its own refusal, or the code of the call it made).
				const value = content?.value
				const type = typeof value === 'object' && value !== null && 'errorType' in value ? Reflect.get(value, 'errorType') : undefined
				const code = typeof type === 'string' && ERROR_CODE.test(type) ? type : 'function_error'
				throw fail(code, status, requestId, retryable(code, 0))
			}
			if (content === undefined) throw fail('invalid_answer', status, requestId, false)
			const read = answer.safeParse(content.value)
			if (!read.success) throw fail('invalid_answer', status, requestId, false)
			return read.data
		},
	}
}
