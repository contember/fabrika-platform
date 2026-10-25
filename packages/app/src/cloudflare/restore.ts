// One step of the original object's point-in-time restore (ADR-0070): the ops operation `restore`, served before the application boots.

import type { OpsRestoreRequest } from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'
import type { MaintenanceBarrier } from './maintenance.js'
import type { OpsTarget } from './ops.js'

/** One step of the original object's point-in-time restore (ADR-0070). Answers 501 until the handler is built (work unit 6.1). */
export async function serveRestore(_target: OpsTarget, _barrier: MaintenanceBarrier, _step: OpsRestoreRequest): Promise<Response> {
	return jsonResponse({ refused: 'not_implemented' }, 501)
}
