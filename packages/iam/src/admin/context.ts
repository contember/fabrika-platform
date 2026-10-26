import { type PermissionEntry, type PrincipalType } from '@fabrika/auth-core'
import { type AuditEventInput, auditLabelOf } from '../db'
import { type RequestContext } from '../env'
import { type Services } from '../services'
import { type Administration } from './user-admin'

/**
 * Context every admin handler receives: the resolved admin caller (already gated on its administration), the
 * request, parsed URL, and the verified app id for audit labeling.
 */
export interface AdminContext {
	services: Services
	request: Request
	url: URL
	/** The resolved admin caller (already gated on its administration). `label` is null for a label-less key. */
	admin: { id: string; type: PrincipalType; label: string | null; permissions: PermissionEntry[] }
	/** The installation, or the people of some applications (ADR-0058); every user-admin rule reads it. */
	administration: Administration
	/** IAM's own app id — the audience the admin was resolved against; used for audit labeling. */
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

/**
 * The record of a change the admin made. A use case hands it to the repository that makes the change, which writes it
 * in the change's own transaction, so a committed change always has its row and a failed write fails the change.
 */
export function adminEvent(
	c: AdminContext,
	event: { action: string; resourceType: string; resourceId?: string | null; diff?: unknown; metadata?: unknown },
): AuditEventInput {
	return {
		requestId: c.requestId,
		principalId: c.admin.id,
		principalLabel: auditLabelOf(c.admin),
		app: c.app,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		diff: event.diff,
		metadata: event.metadata,
	}
}
