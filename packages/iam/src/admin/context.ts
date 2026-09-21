import { type PermissionEntry, type PrincipalType } from '@fabrika/auth-core'
import { type RequestContext } from '../env'
import { type Services } from '../services'

/**
 * Context every admin handler receives: the resolved admin caller (already gated
 * on `iam.admin` by the router), the request, parsed URL, and the verified app id
 * for audit labeling.
 */
export interface AdminContext {
	services: Services
	request: Request
	url: URL
	/** The resolved admin caller (already gated on `iam.admin`). `label` is null for a label-less key. */
	admin: { id: string; type: PrincipalType; label: string | null; permissions: PermissionEntry[] }
	/** propustka's own app id — the audience the admin was resolved against; used for audit labeling. */
	app: string
	/** Correlation id supplied by the proxy/edge or generated at IAM. */
	requestId: string
	ctx: RequestContext
}

/** Structural domain failure shared by REST adapters and the RPC dispatcher. */
export class AdminUseCaseError extends Error {
	readonly httpStatus: number
	readonly type: string

	constructor(httpStatus: number, message: string) {
		super(message)
		this.name = 'AdminUseCaseError'
		this.httpStatus = httpStatus
		this.type = httpStatus === 400
			? 'bad_request'
			: httpStatus === 404
			? 'not_found'
			: httpStatus === 409
			? 'conflict'
			: httpStatus === 403
			? 'forbidden'
			: 'error'
	}
}

export function fail(status: number, message: string): never {
	throw new AdminUseCaseError(status, message)
}

// Audit-event writes from admin actions happen on the request critical path so the
// admin sees a consistent state, but the write itself is small; we await it.
export function adminAudit(
	c: AdminContext,
	event: { action: string; resourceType: string; resourceId?: string | null; diff?: unknown; metadata?: unknown },
): Promise<void> {
	return c.services.repositories.audit.writeAuditEvent({
		requestId: c.requestId,
		principalId: c.admin.id,
		principalLabel: c.admin.label ?? c.admin.id,
		app: c.app,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		diff: event.diff,
		metadata: event.metadata,
	})
}
