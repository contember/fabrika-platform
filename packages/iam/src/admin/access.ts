import { auditLabelOf } from '../db'
import { prop } from '../json'
import type { Services } from '../services'
import type { ResolvedAdmin } from './router'

/** The audit action of one privileged request: an installation admin used `/admin/*`, a read as much as a change. */
export const ADMIN_ACCESS_ACTION = 'iam.admin.access'

/** One `/admin/*` operation as it is recorded: the method, the route template, and for `/admin/rpc` the procedure. */
export interface AdminAccess {
	readonly method: string
	readonly route: string
	/** The procedure an `/admin/rpc` body names, when it is a well-formed name; null otherwise. */
	readonly procedure?: string | null
}

const PROCEDURE_NAME = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,3}$/

/**
 * Write the access row before the operation runs, so a request is recorded whatever it then does. The row's `app` is
 * the audience the admin's credential was verified for — the console gateway, or IAM itself for a `px_` key. A request
 * whose access cannot be recorded does not run.
 */
export async function recordAdminAccess(services: Services, admin: ResolvedAdmin, requestId: string, access: AdminAccess): Promise<void> {
	await services.repositories.audit.writeAuditEvent({
		requestId,
		principalId: admin.id,
		principalLabel: auditLabelOf(admin),
		app: admin.audience,
		action: ADMIN_ACCESS_ACTION,
		resourceType: 'admin_route',
		resourceId: access.procedure == null ? access.route : `${access.route}#${access.procedure}`,
		metadata: { method: access.method, route: access.route, ...(access.procedure === undefined ? {} : { procedure: access.procedure }) },
	})
}

/** The procedure an `/admin/rpc` request names, read from a copy of its body; null when the body names none it may. */
export async function rpcProcedureOf(request: Request): Promise<string | null> {
	let body: unknown
	try {
		body = await request.clone().json()
	} catch {
		return null
	}
	const method = prop(body, 'method')
	return typeof method === 'string' && method.length <= 64 && PROCEDURE_NAME.test(method) ? method : null
}
