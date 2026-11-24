// A fake AWS JSON-protocol endpoint for the service clients' tests: it routes each signed request by its operation
// (`X-Amz-Target`), records the operation and the parsed body, and answers what the test's handler returns. No request
// leaves the process.

import { type AwsJsonClient, awsJsonClient, type AwsJsonService, awsServiceOrigin } from '../../aws/json'

/** One request the fake received: its operation and its JSON body. */
export interface FakeCall {
	readonly operation: string
	readonly body: unknown
}

/** What a handler answers: a JSON body (status 200), or an AWS error answer. */
export type FakeAnswer = { readonly error: string; readonly status?: number } | Readonly<Record<string, unknown>>

/** An AWS error answer of the JSON protocol, as `__type` in the body. */
export function awsError(code: string, status = 400): FakeAnswer {
	return { error: code, status }
}

function isError(answer: FakeAnswer): answer is { readonly error: string; readonly status?: number } {
	return typeof answer['error'] === 'string' && Object.keys(answer).every((key) => key === 'error' || key === 'status')
}

function headerOf(init: RequestInit, name: string): string | undefined {
	const headers = init.headers
	if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return undefined
	return headers[name]
}

/**
 * A client of `service` against handlers by operation name. An operation without a handler answers
 * `UnknownOperationException`, so a test sees every call it did not expect.
 */
export function fakeAws(
	service: AwsJsonService,
	handlers: Readonly<Record<string, (body: unknown, calls: readonly FakeCall[]) => FakeAnswer>>,
): { readonly client: AwsJsonClient; readonly calls: FakeCall[] } {
	const calls: FakeCall[] = []
	const client = awsJsonClient(service, {
		origin: awsServiceOrigin(service, 'eu-central-1'),
		region: 'eu-central-1',
		credentials: { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) },
		fetch: (_url, init) => {
			const operation = (headerOf(init, 'x-amz-target') ?? '').split('.').at(-1) ?? ''
			const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			calls.push({ operation, body })
			const handler = handlers[operation]
			const answer = handler === undefined ? awsError('UnknownOperationException') : handler(body, calls)
			const headers = { 'content-type': `application/x-amz-json-${service.jsonVersion}` }
			if (isError(answer)) {
				return Promise.resolve(new Response(JSON.stringify({ __type: `com.amazonaws#${answer.error}` }), { status: answer.status ?? 400, headers }))
			}
			return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers }))
		},
	})
	return { client, calls }
}
