// AWS's query protocol, which CloudFormation and RDS speak (ADR-0081): one signed `POST /` (`transport.ts`) with a form
// body of `Action`, `Version` and the action's flat parameters, and an XML answer read by the strict reader (`xml.ts`).
// A success is `<{Action}Response>` holding `<{Action}Result>` (absent for an action without output) and the request
// id; an error is `<ErrorResponse><Error><Code>…</Code></Error></ErrorResponse>`, of which the client keeps the code
// alone: `Message` can quote the input, so it never reaches an error.
//
// UNVERIFIED: the API versions, the answer's and the error's element names and where the request id travels follow
// CloudFormation's and RDS's API references; none was checked against an account.

import { type AwsClientOptions, AwsError, awsExchange, ERROR_CODE, OPERATION, REQUEST_ID, retryable } from './transport'
import { parseXml, type XmlElement, xmlOne, xmlOptional, xmlText } from './xml'

/** One service of the query protocol: the name it signs for and the API version every call names. */
export interface AwsQueryService {
	/** The signing name and the endpoint's first label: `cloudformation`, `rds`. */
	readonly service: string
	readonly version: string
}

export const CLOUDFORMATION: AwsQueryService = { service: 'cloudformation', version: '2010-05-15' }
export const RDS: AwsQueryService = { service: 'rds', version: '2014-10-31' }

/**
 * A call of one action with its flat parameters (`Parameters.member.1.ParameterKey`); `read` reads the action's
 * `<{Action}Result>`, or `null` for an action that answers none. Anything `read` throws, or an answer of another form, is
 * `invalid_answer`.
 */
export interface AwsQueryClient {
	call<T>(action: string, parameters: Readonly<Record<string, string>>, read: (result: XmlElement | null) => T, signal?: AbortSignal): Promise<T>
}

/** A parameter's name: segments of letters and digits joined by dots, as the protocol flattens lists and maps. */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){0,15}$/
/** The parameters the client writes itself. */
const RESERVED = new Set(['Action', 'Version'])

/** A request id of the expected form, else `null`. */
function requestIdOf(id: string | null): string | null {
	return id !== null && REQUEST_ID.test(id) ? id : null
}

/**
 * The `Error/Code` of an error answer (`unknown` when it has none of the expected form) and its `RequestId`. `Message`
 * is never read.
 */
function errorOf(text: string): { readonly code: string; readonly requestId: string | null } {
	try {
		const root = parseXml(text)
		// RDS and CloudFormation wrap one `Error` in `ErrorResponse`; some query services list them under `Errors`.
		const error = root.name === 'ErrorResponse' ? xmlOne(root, 'Error') : xmlOne(xmlOne(root, 'Errors'), 'Error')
		const code = xmlText(error, 'Code') ?? ''
		const requestId = (() => {
			try {
				return requestIdOf(xmlText(root, 'RequestId'))
			} catch {
				return null
			}
		})()
		return { code: ERROR_CODE.test(code) ? code : 'unknown', requestId }
	} catch {
		return { code: 'unknown', requestId: null }
	}
}

/** A client of `service` at `options.origin`, signing each call with the credentials current at that moment. */
export function awsQueryClient(service: AwsQueryService, options: AwsClientOptions): AwsQueryClient {
	return {
		async call<T>(
			action: string,
			parameters: Readonly<Record<string, string>>,
			read: (result: XmlElement | null) => T,
			signal?: AbortSignal,
		): Promise<T> {
			if (!OPERATION.test(action)) throw new AwsError('(operation)', 'invalid_operation', 0, null, false)
			const fail = (code: string, status: number, requestId: string | null, again: boolean): AwsError =>
				new AwsError(action, code, status, requestId, again)
			const form = new URLSearchParams({ Action: action, Version: service.version })
			for (const [name, value] of Object.entries(parameters)) {
				// A name the protocol does not read, or one the client writes, is the caller's mistake: nothing is sent.
				if (!PARAMETER_NAME.test(name) || RESERVED.has(name)) throw fail('invalid_request', 0, null, false)
				form.append(name, value)
			}
			const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }
			const { status, ok, text, requestId: headerId } = await awsExchange(service.service, options, action, { headers, body: form.toString() }, signal)
			if (!ok) {
				const error = errorOf(text)
				throw fail(error.code, status, headerId ?? error.requestId, retryable(error.code, status))
			}
			let root: XmlElement
			try {
				root = parseXml(text)
			} catch {
				throw fail('invalid_answer', status, headerId, false)
			}
			const bodyId = (() => {
				try {
					const metadata = xmlOptional(root, 'ResponseMetadata')
					return metadata === null ? null : requestIdOf(xmlText(metadata, 'RequestId'))
				} catch {
					return null
				}
			})()
			const requestId = headerId ?? bodyId
			// An answer for another action is no answer to this call.
			if (root.name !== `${action}Response`) throw fail('invalid_answer', status, requestId, false)
			try {
				return read(xmlOptional(root, `${action}Result`))
			} catch {
				// The XML reader's refusal or the caller's, whatever it threw: the answer is not one this call reads.
				throw fail('invalid_answer', status, requestId, false)
			}
		},
	}
}
