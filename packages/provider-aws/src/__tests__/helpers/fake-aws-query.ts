// A fake AWS query-protocol endpoint for the query clients' tests (CloudFormation, RDS). It checks that each request is
// what the protocol asks of the service under test: a signed `POST /` with a form body naming the action and the
// service's API version. It records the action and the other parameters, and answers the XML the protocol would: the
// handler's result inside `<{Action}Response><{Action}Result>`, an `ErrorResponse`, or a raw body for odd answers. No
// request leaves the process.

import type { AwsQueryService } from '../../aws/query'
import type { AwsClientOptions } from '../../aws/transport'
import { awsServiceOrigin } from '../../aws/transport'
import { FAKE_REFUSAL, FakeAwsError } from './fake-aws'

/** One request the fake received: its action and its parameters other than `Action` and `Version`. */
export interface FakeQueryCall {
	readonly action: string
	readonly parameters: Readonly<Record<string, string>>
}

/** A body answered as it is, with its status: an answer of another form than the protocol's. */
export class FakeRawAnswer {
	constructor(
		readonly body: string,
		readonly status = 200,
		readonly headers: Readonly<Record<string, string>> = {},
	) {}
}

/**
 * What a handler answers: an AWS error, a raw answer, the inner XML of `<{Action}Result>`, or `null` for an action that
 * answers no result.
 */
export type FakeQueryAnswer = FakeAwsError | FakeRawAnswer | string | null

export const FAKE_REQUEST_ID = 'c3d4e5f6-0000-4000-8000-000000000001'

/**
 * Client options for `service` against handlers by action. A request that is not a signed `POST /` with a form body of
 * the service's version answers `FakeRequestRefused`, and an action without a handler `InvalidAction`.
 */
export function fakeAwsQuery(
	service: AwsQueryService,
	handlers: Readonly<Record<string, (parameters: Readonly<Record<string, string>>, calls: readonly FakeQueryCall[]) => FakeQueryAnswer>>,
): { readonly options: AwsClientOptions; readonly calls: FakeQueryCall[] } {
	const calls: FakeQueryCall[] = []
	const origin = awsServiceOrigin(service, 'eu-central-1')
	const options: AwsClientOptions = {
		origin,
		region: 'eu-central-1',
		credentials: { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) },
		fetch: (url, init) => {
			const headers = init.headers !== undefined && !(init.headers instanceof Headers) && !Array.isArray(init.headers) ? init.headers : {}
			const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
			const action = form.get('Action') ?? ''
			const parameters = Object.fromEntries([...form.entries()].filter(([name]) => name !== 'Action' && name !== 'Version'))
			calls.push({ action, parameters })
			const authorization = headers['authorization'] ?? ''
			const signed = authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')
				&& authorization.includes(`/eu-central-1/${service.service}/aws4_request`)
			const wellFormed = init.method === 'POST' && url === `${origin}/` && signed
				&& headers['content-type'] === 'application/x-www-form-urlencoded; charset=utf-8' && form.get('Version') === service.version
			const handler = handlers[action]
			const answer = !wellFormed || action === ''
				? new FakeAwsError(FAKE_REFUSAL, 400)
				: handler === undefined
				? new FakeAwsError('InvalidAction', 400)
				: handler(parameters, calls)
			const xml = { 'content-type': 'text/xml' }
			if (answer instanceof FakeRawAnswer) {
				return Promise.resolve(new Response(answer.body, { status: answer.status, headers: { ...xml, ...answer.headers } }))
			}
			if (answer instanceof FakeAwsError) {
				const error = `<ErrorResponse xmlns="https://${service.service}.amazonaws.com/doc/${service.version}/">`
					+ `<Error><Type>Sender</Type><Code>${answer.code}</Code><Message>Value sk_live_quoted_input is invalid</Message></Error>`
					+ `<RequestId>${FAKE_REQUEST_ID}</RequestId></ErrorResponse>`
				return Promise.resolve(new Response(error, { status: answer.status, headers: xml }))
			}
			const result = answer === null ? '' : `<${action}Result>${answer}</${action}Result>`
			const body = `<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="https://${service.service}.amazonaws.com/doc/${service.version}/">`
				+ `${result}<ResponseMetadata><RequestId>${FAKE_REQUEST_ID}</RequestId></ResponseMetadata></${action}Response>`
			return Promise.resolve(new Response(body, { status: 200, headers: xml }))
		},
	}
	return { options, calls }
}
