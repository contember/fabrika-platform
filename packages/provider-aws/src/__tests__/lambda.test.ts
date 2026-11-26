// Lambda's `Invoke` against a fake endpoint: a signed `POST` to the function's invocations path, the answer read with the
// caller's schema, a function's own error named by its `errorType` alone (never its message, which can quote the input),
// and a refusal of Lambda itself by its error type.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { LAMBDA, lambdaFunction } from '../aws/lambda'
import { awsServiceOrigin } from '../aws/transport'

const origin = awsServiceOrigin(LAMBDA, 'eu-central-1')
const credentials = { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) }
const schema = z.object({ tasks: z.array(z.object({ taskArn: z.string() })) })

interface Seen {
	readonly url: string
	readonly method: string | undefined
	readonly headers: Headers
	readonly body: unknown
}

/** A Lambda endpoint that answers `answer` and records what it was sent. */
function endpoint(answer: () => Response): { readonly fetch: (input: string, init: RequestInit) => Promise<Response>; readonly seen: Seen[] } {
	const seen: Seen[] = []
	return {
		seen,
		fetch: async (url, init) => {
			seen.push({
				url,
				method: init.method,
				headers: new Headers(init.headers),
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
			})
			return answer()
		},
	}
}

describe("Lambda's Invoke", () => {
	test('posts the input to the function by name, signed, and reads the answer with the schema', async () => {
		const lambda = endpoint(() => Response.json({ tasks: [{ taskArn: 'arn:task', extra: 1 }] }))
		const runner = lambdaFunction({ origin, region: 'eu-central-1', credentials, fetch: lambda.fetch }, 'fabrika-task-runner')
		expect(await runner.invoke({ command: ['sh'] }, schema)).toEqual({ tasks: [{ taskArn: 'arn:task' }] })
		expect(lambda.seen).toHaveLength(1)
		expect(lambda.seen[0]?.url).toBe(`${origin}/2015-03-31/functions/fabrika-task-runner/invocations`)
		expect(lambda.seen[0]?.method).toBe('POST')
		expect(lambda.seen[0]?.headers.get('x-amz-invocation-type')).toBe('RequestResponse')
		expect(lambda.seen[0]?.headers.get('authorization')).toContain('/eu-central-1/lambda/aws4_request')
		expect(lambda.seen[0]?.body).toEqual({ command: ['sh'] })
	})

	test("a function's error is its errorType alone, retryable when the type is AWS's throttling", async () => {
		const failed = (errorType: string) =>
			endpoint(() => Response.json({ errorType, errorMessage: 'refused: sg-secret quoted' }, { headers: { 'x-amz-function-error': 'Unhandled' } }))
		const cases: readonly (readonly [string, string, boolean])[] = [
			['TaskRunnerRefused', 'TaskRunnerRefused', false],
			['ThrottlingException', 'ThrottlingException', true],
			['not a code!', 'function_error', false],
		]
		for (const [type, code, retryable] of cases) {
			const runner = lambdaFunction({ origin, region: 'eu-central-1', credentials, fetch: failed(type).fetch }, 'fabrika-task-runner')
			const failure = await runner.invoke({}, schema).catch((error: unknown) => error)
			expect(failure).toMatchObject({ operation: 'Invoke', code, retryable })
			expect(String(failure)).not.toContain('sg-secret')
		}
	})

	test('a refusal of Lambda itself is its error type; an answer of another form, or a name of another form, is refused', async () => {
		const throttled = endpoint(() => new Response('{}', { status: 429, headers: { 'x-amzn-errortype': 'TooManyRequestsException' } }))
		const options = { origin, region: 'eu-central-1', credentials }
		await expect(lambdaFunction({ ...options, fetch: throttled.fetch }, 'fabrika-task-runner').invoke({}, schema)).rejects.toMatchObject({
			code: 'TooManyRequestsException',
			retryable: true,
		})
		const odd = endpoint(() => Response.json({ tasks: 'none' }))
		await expect(lambdaFunction({ ...options, fetch: odd.fetch }, 'fabrika-task-runner').invoke({}, schema)).rejects.toMatchObject({
			code: 'invalid_answer',
		})
		const unsent = endpoint(() => Response.json({}))
		await expect(lambdaFunction({ ...options, fetch: unsent.fetch }, 'arn:aws:lambda:x').invoke({}, schema)).rejects.toMatchObject({
			code: 'invalid_request',
		})
		expect(unsent.seen).toEqual([])
	})
})
