// A fake AWS JSON-protocol endpoint for the service clients' tests. A service client builds its own JSON client from the
// options the fake hands out, so the fake checks that each request is what the protocol asks of the service under test:
// a signed `POST /` with that service's content type and target prefix. A client wired to another service fails here.
// It records the full target and the parsed body, and answers what the test's handler returns. No request leaves the
// process.

import { type AwsJsonClientOptions, type AwsJsonService, awsServiceOrigin } from '../../aws/json'

/** One request the fake received: its operation, its full `X-Amz-Target` and its JSON body. */
export interface FakeCall {
	readonly operation: string
	readonly target: string
	readonly body: unknown
}

/** An AWS error answer of the JSON protocol, which the fake writes as `__type` in the body. */
export class FakeAwsError {
	constructor(
		readonly code: string,
		readonly status: number,
	) {}
}

/** What a handler answers: an AWS error, or a JSON body answered with status 200. */
export type FakeAnswer = FakeAwsError | Readonly<Record<string, unknown>>

/** An AWS error answer, as the service would send it. */
export function awsError(code: string, status = 400): FakeAwsError {
	return new FakeAwsError(code, status)
}

/** The error the fake answers a request the protocol does not allow: no handler ever sees it. */
export const FAKE_REFUSAL = 'FakeRequestRefused'

function headerOf(init: RequestInit, name: string): string | undefined {
	const headers = init.headers
	if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return undefined
	return headers[name]
}

/**
 * Client options for `service` against handlers by operation name. A request that is not a signed `POST /` with the
 * service's content type and target prefix answers `FakeRequestRefused`, and an operation without a handler
 * `UnknownOperationException`, so a test sees every call it did not expect.
 */
export function fakeAws(
	service: AwsJsonService,
	handlers: Readonly<Record<string, (body: unknown, calls: readonly FakeCall[]) => FakeAnswer>>,
): { readonly options: AwsJsonClientOptions; readonly calls: FakeCall[] } {
	const calls: FakeCall[] = []
	const origin = awsServiceOrigin(service, 'eu-central-1')
	const contentType = `application/x-amz-json-${service.jsonVersion}`
	const options: AwsJsonClientOptions = {
		origin,
		region: 'eu-central-1',
		credentials: { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) },
		fetch: (url, init) => {
			const target = headerOf(init, 'x-amz-target') ?? ''
			const prefix = `${service.targetPrefix}.`
			const operation = target.startsWith(prefix) ? target.slice(prefix.length) : ''
			const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			calls.push({ operation, target, body })
			const signed = (headerOf(init, 'authorization') ?? '').startsWith(
				`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/`,
			) && (headerOf(init, 'authorization') ?? '').includes(`/eu-central-1/${service.service}/aws4_request`)
			const wellFormed = init.method === 'POST' && url === `${origin}/` && headerOf(init, 'content-type') === contentType && signed
			const handler = handlers[operation]
			const answer = !wellFormed || operation === ''
				? awsError(FAKE_REFUSAL)
				: handler === undefined
				? awsError('UnknownOperationException')
				: handler(body, calls)
			const headers = { 'content-type': contentType }
			if (answer instanceof FakeAwsError) {
				return Promise.resolve(new Response(JSON.stringify({ __type: `com.amazonaws#${answer.code}` }), { status: answer.status, headers }))
			}
			return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers }))
		},
	}
	return { options, calls }
}
