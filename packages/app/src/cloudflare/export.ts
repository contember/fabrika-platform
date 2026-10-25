// One step of a dump of the object's database (ADR-0070): the ops operation `export`, served before the application boots.

import type { OpsExportRequest } from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'
import type { MaintenanceBarrier } from './maintenance.js'
import type { OpsTarget } from './ops.js'

/** One step of a dump of the object's database (ADR-0070). Answers 501 until the handler is built (work unit 4.1). */
export async function serveExport(_target: OpsTarget, _barrier: MaintenanceBarrier, _step: OpsExportRequest): Promise<Response> {
	return jsonResponse({ refused: 'not_implemented' }, 501)
}
