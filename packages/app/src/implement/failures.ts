// A request that answered 5xx: one server log line and, with an Operations DSN, one error event. The log line carries
// fixed codes and bounded identifiers only, never an error's name or message: application code, drivers and even the
// framework's own refusals can put request data there. The event adds what was thrown as its cause chain, scrubbed of
// the environment's secrets and of credential patterns, a framework failure's message replaced by its catalog text
// (ADR-0059).

import { CAPABILITY_ERRORS, CapabilityError, QUERY_REFUSALS, QueryRefusedError } from '@fabrika/db/framework'
import { isStructuralError } from '../errors'
import type { OperationsReporter } from '../jobs/report'
import { CAPABILITY_REFUSALS, CapabilityRefusedError } from './capability'
import { SERVER_FAULTS, ServerFault } from './faults'

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
	if (error instanceof CapabilityRefusedError || error instanceof CapabilityError) {
		return 'capability_refused'
	}
	if (error instanceof QueryRefusedError) {
		return 'query_refused'
	}
	return isStructuralError(error) ? 'handler_status' : 'handler_failed'
}

/** What a log may say of a framework failure: the reason its catalog keys it by, and that reason's fixed text. */
export interface FailureReason {
	readonly reason: string
	readonly text: string
}

/** A framework failure's reason and the fixed text its catalog gives it; `null` for any other thrown value. */
export function failureReason(error: unknown): FailureReason | null {
	if (error instanceof ServerFault) {
		return { reason: error.reason, text: SERVER_FAULTS[error.reason] }
	}
	if (error instanceof CapabilityRefusedError) {
		return { reason: error.reason, text: CAPABILITY_REFUSALS[error.reason] }
	}
	if (error instanceof CapabilityError) {
		return { reason: error.reason, text: CAPABILITY_ERRORS[error.reason] }
	}
	if (error instanceof QueryRefusedError) {
		return { reason: error.reason, text: QUERY_REFUSALS[error.reason] }
	}
	return null
}

export interface RequestFailure {
	/** The endpoint id the request selected, or `request` before one was selected. */
	readonly endpoint: string
	/** The proxy's `X-Request-Id`. */
	readonly requestId: string | null
	readonly status: number
	readonly error: unknown
}

/** At most `limit` admissions per minute of `now`; the next minute starts again. */
export class MinuteBudget {
	readonly #limit: number
	readonly #now: () => number
	#window = -1
	#admitted = 0

	constructor(limit: number, now: () => number = Date.now) {
		this.#limit = limit
		this.#now = now
	}

	admit(): boolean {
		const window = Math.floor(this.#now() / MINUTE_MS)
		if (window !== this.#window) {
			this.#window = window
			this.#admitted = 0
		}
		this.#admitted++
		return this.#admitted <= this.#limit
	}
}

export class FailureReports {
	readonly #reporter: OperationsReporter | null
	readonly #budget: MinuteBudget

	/** `reporter` is `null` without an Operations DSN: the log line is then the only record. */
	constructor(reporter: OperationsReporter | null, now: () => number = Date.now) {
		this.#reporter = reporter
		this.#budget = new MinuteBudget(MAX_FAILURE_REPORTS_PER_MINUTE, now)
	}

	/** Never rejects. The returned delivery may outlive the response; a runtime with `waitUntil` keeps it alive. */
	record(failure: RequestFailure): Promise<void> {
		const code = failureCode(failure.error)
		const why = failureReason(failure.error)
		console.error(`fabrika: ${failure.endpoint}: ${code}${why === null ? '' : `: ${why.reason}: ${why.text}`}`)
		if (this.#reporter === null || !this.#budget.admit()) {
			return Promise.resolve()
		}
		const tags: Record<string, string> = { endpoint: failure.endpoint, code, status: String(failure.status) }
		if (why !== null) {
			tags['reason'] = why.reason
		}
		if (failure.requestId !== null && REQUEST_ID.test(failure.requestId)) {
			tags['request'] = failure.requestId
		}
		return this.#reporter.report({
			fingerprint: ['fabrika-request-failed', failure.endpoint, code],
			type: 'RequestFailed',
			message: `endpoint '${failure.endpoint}' answered ${failure.status}: ${code}`,
			tags,
			error: failure.error,
		})
	}
}
