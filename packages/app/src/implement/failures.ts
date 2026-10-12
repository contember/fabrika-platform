// A request that answered 5xx: one server log line and, with an Operations DSN, one error event. The event carries a
// fixed failure code and bounded identifiers only, never the error's name or message: application code and drivers
// write those, and either may quote request data or a credential. The log line adds the text of a framework refusal.

import { QueryRefusedError } from '@fabrika/db/framework'
import { isStructuralError } from '../errors'
import type { OperationsReporter } from '../jobs/report'
import { CapabilityRefusedError } from './capability'
import { ServerFault } from './faults'

export type RequestFailureCode =
	| 'framework_fault'
	| 'unavailable'
	| 'capability_refused'
	| 'query_refused'
	| 'handler_status'
	| 'handler_failed'

/** At most this many request failures per process and minute become Operations events; every one is logged. */
export const MAX_FAILURE_REPORTS_PER_MINUTE = 30

const MINUTE_MS = 60_000
/** The proxy's request id is a UUID; anything else is left out of a report rather than echoed. */
const REQUEST_ID = /^[0-9A-Za-z-]{1,64}$/

/** Chosen by `instanceof` against the framework's own classes, never by `name`, which any thrown value can set. */
export function failureCode(error: unknown): RequestFailureCode {
	if (error instanceof ServerFault) {
		return error.status === 503 ? 'unavailable' : 'framework_fault'
	}
	if (error instanceof CapabilityRefusedError) {
		return 'capability_refused'
	}
	if (error instanceof QueryRefusedError) {
		return 'query_refused'
	}
	return isStructuralError(error) ? 'handler_status' : 'handler_failed'
}

/** The framework's own failures, whose text names declarations and refused forms, never a value. */
function isFrameworkRefusal(error: unknown): error is Error {
	return error instanceof ServerFault || error instanceof CapabilityRefusedError || error instanceof QueryRefusedError
}

export interface RequestFailure {
	/** The endpoint id the request selected, or `request` before one was selected. */
	readonly endpoint: string
	/** The proxy's `X-Request-Id`. */
	readonly requestId: string | null
	readonly status: number
	readonly error: unknown
}

export class FailureReports {
	readonly #reporter: OperationsReporter | null
	readonly #now: () => number
	#window = -1
	#reported = 0

	/** `reporter` is `null` without an Operations DSN: the log line is then the only record. */
	constructor(reporter: OperationsReporter | null, now: () => number = Date.now) {
		this.#reporter = reporter
		this.#now = now
	}

	/** Never rejects. The returned delivery may outlive the response; a runtime with `waitUntil` keeps it alive. */
	record(failure: RequestFailure): Promise<void> {
		const code = failureCode(failure.error)
		const detail = isFrameworkRefusal(failure.error) ? `${code}: ${failure.error.message}` : code
		console.error(`fabrika: ${failure.endpoint}: ${detail}`)
		if (this.#reporter === null || !this.#admit()) {
			return Promise.resolve()
		}
		const tags: Record<string, string> = { endpoint: failure.endpoint, code, status: String(failure.status) }
		if (failure.requestId !== null && REQUEST_ID.test(failure.requestId)) {
			tags['request'] = failure.requestId
		}
		return this.#reporter.report({
			fingerprint: ['fabrika-request-failed', failure.endpoint, code],
			type: 'RequestFailed',
			message: `endpoint '${failure.endpoint}' answered ${failure.status}: ${code}`,
			tags,
		})
	}

	#admit(): boolean {
		const window = Math.floor(this.#now() / MINUTE_MS)
		if (window !== this.#window) {
			this.#window = window
			this.#reported = 0
		}
		this.#reported++
		return this.#reported <= MAX_FAILURE_REPORTS_PER_MINUTE
	}
}
