// One step of loading a dump into a fresh object (ADR-0070): the ops operation `import`, served before the application boots.

import type { OpsImportRequest } from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'
import type { MaintenanceBarrier } from './maintenance.js'
import type { OpsTarget } from './ops.js'

/** One step of loading a dump into a fresh object (ADR-0070). Answers 501 until the handler is built (work unit 4.2). */
export async function serveImport(_target: OpsTarget, _barrier: MaintenanceBarrier, _step: OpsImportRequest): Promise<Response> {
	return jsonResponse({ refused: 'not_implemented' }, 501)
}
