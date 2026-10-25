// The object's live timers with the stacks that created them (ADR-0070): the ops operation `timers`, diagnostics only.

import type { OpsTimersRequest } from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'

/** The object's live timers. Answers 501 until the tracker is built (work unit 3.5). */
export function serveTimers(_request: OpsTimersRequest): Response {
	return jsonResponse({ refused: 'not_implemented' }, 501)
}
