// A console grant that waits for a second administrator (ADR-0083 §4). At an application whose grants wait, a grant
// change runs every check it runs today and then records a request instead of the change; nothing that resolves
// permissions reads a request. An administrator of the application, a person in a signed-in session other than the
// requester, approves it, and approving makes the change with the approver's own checks, in the transaction that claims
// the request. This is authorization, never an enforcement decision (ADR-0022).

import { parseAppEnvironmentId } from '@fabrika/auth-core'
import {
	type DecideGrantRequestInput,
	GRANT_REQUEST_TTL_SECONDS,
	type GrantRequestDto,
	type ListGrantRequestsInput,
	type SetGrantApprovalRequest,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { contractGrantProblem, externalGrantProblem } from '../contract-rules'
import { type AuditEventInput, type CreateGrantRequestInput, type GrantRequestRow, type GrantRow } from '../db'
import { unixNow } from '../repositories/sql'
import type { Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { type AdminContext, adminEvent, fail } from './context'
import { managesApp, requireGrantablePrincipal } from './user-admin'

/** Whether a grant change at `app` waits; a cross-app grant reaches no application and never does. */
export async function grantsWait(services: Services, app: string | null): Promise<boolean> {
	return app !== null && await services.repositories.grantRequests.grantsWait(app)
}

/** What a grant change asks for, before IAM records it; the request's timestamps are IAM's. */
export type GrantChangeRequest = Omit<CreateGrantRequestInput, 'requestedAt' | 'expiresAt'>

/** Record the change as a request, with its `iam.grant.request` record built by `event`, and answer it. */
export async function requestGrantChange(
	services: Services,
	change: GrantChangeRequest,
	event: (requestId: string, metadata: Record<string, unknown>) => AuditEventInput,
): Promise<GrantRequestDto> {
	const now = unixNow()
	const row = await services.repositories.grantRequests.create(
		{ ...change, requestedAt: now, expiresAt: now + GRANT_REQUEST_TTL_SECONDS },
		(requestId) =>
			event(requestId, {
				kind: change.kind,
				app: change.app,
				principalId: change.principalId,
				grantId: change.grantId,
				roleKey: change.roleKey,
				permissions: change.permissions,
				scopeType: change.scopeType,
				scopeValue: change.scopeValue,
			}),
	)
	return toGrantRequestDto(services, row, now)
}

/** The open requests at the applications the caller administers, the oldest first. */
export async function listGrantRequestsUseCase(c: AdminContext, input: ListGrantRequestsInput): Promise<{ items: GrantRequestDto[] }> {
	const now = unixNow()
	const rows = (await c.services.repositories.grantRequests.listOpen(now)).filter((row) =>
		(input.app === undefined || row.app === input.app) && managesApp(c.services, c.administration, row.app)
	)
	return { items: await Promise.all(rows.map((row) => toGrantRequestDto(c.services, row, now))) }
}

/**
 * Approve or reject one open request. Only a person in a signed-in session decides (`person`), never a `px_` key; an
 * application the caller does not administer and an unknown request are one 404. The requester may reject (withdraw)
 * their own request, never approve it.
 */
export async function decideGrantRequestUseCase(c: AdminContext, person: boolean, input: DecideGrantRequestInput): Promise<GrantRequestDto> {
	const requests = c.services.repositories.grantRequests
	const request = await requests.get(input.id)
	if (request === null || !managesApp(c.services, c.administration, request.app)) return fail(404, 'grant request not found')
	if (!person) return fail(403, 'only a person signed in to the console decides a grant request, never a key')
	const now = unixNow()
	if (request.status !== 'pending' || request.expires_at <= now) return fail(409, 'the grant request is no longer open')
	if (input.decision === 'reject') {
		const rejected = await requests.reject(
			request.id,
			c.admin.id,
			now,
			adminEvent(c, {
				action: 'iam.grant.request.reject',
				resourceType: 'grant_request',
				resourceId: request.id,
				metadata: { app: request.app, kind: request.kind, principalId: request.principal_id, requestedBy: request.requested_by },
			}),
		)
		return rejected === null ? fail(409, 'the grant request is no longer open') : toGrantRequestDto(c.services, rejected, now)
	}
	if (request.requested_by === c.admin.id) {
		return fail(403, 'another administrator of the application approves a grant request; you may reject your own')
	}
	const current = await approvable(c, request)
	const decision = { id: uuidv7(), by: c.admin.id, at: now }
	const action = request.kind === 'create' ? 'iam.grant.create' : request.kind === 'update' ? 'iam.grant.update' : 'iam.grant.revoke'
	const applied = await c.services.repositories.grants.applyRequest(request, current, decision, (grantId) =>
		adminEvent(c, {
			action,
			resourceType: 'grant',
			resourceId: grantId,
			metadata: {
				principalId: request.principal_id,
				app: request.app,
				roleKey: request.role_key,
				permissions: request.permissions === null ? null : parseStoredPermissions(request.permissions),
				scopeType: request.scope_type,
				scopeValue: request.scope_value,
				grantRequestId: request.id,
				requestedBy: request.requested_by,
			},
		}))
	if (!applied.claimed) return fail(409, 'the grant request is no longer open')
	if (applied.changed === null) {
		await requests.markFailed(request.id, decision.id)
		return fail(409, 'the change no longer applies: the access changed since the checks; the request is closed as failed')
	}
	const decided = await requests.get(request.id)
	return decided === null ? fail(404, 'grant request not found') : toGrantRequestDto(c.services, decided, now)
}

/**
 * The checks the original change ran, again, with the approver as the administrator: the approver must be able to make
 * the change now. Answers the grant an `update` or a `revoke` acts on.
 */
async function approvable(c: AdminContext, request: GrantRequestRow): Promise<GrantRow | null> {
	const { grants, principals, appSchema } = c.services.repositories
	const principal = await principals.getPrincipalById(request.principal_id)
	if (principal === null) return fail(409, 'the principal no longer exists; reject the request')
	if (await grants.isWorkloadPrincipal(principal.id)) return fail(409, 'a job, a webhook or a connector holds no grant')
	requireGrantablePrincipal(c, principal)
	const current = request.grant_id === null ? null : await grants.getGrantById(request.grant_id)
	if (request.kind !== 'create' && (current === null || current.app !== request.app || current.principal_id !== principal.id)) {
		return fail(409, 'the grant is gone; reject the request')
	}
	if (request.kind === 'revoke') return current
	const authorization = {
		roleKey: request.role_key,
		permissions: request.permissions === null ? null : parseStoredPermissions(request.permissions),
		scopeType: request.scope_type,
	}
	const problem = await contractGrantProblem(appSchema, request.app, authorization, principal.type === 'user')
		?? await externalGrantProblem(appSchema, principal, request.app, authorization)
	if (problem !== null) return fail(409, problem)
	if (request.role_key !== null) {
		const held = (await grants.listGrants(principal.id)).some((grant) =>
			grant.id !== request.grant_id && grant.app === request.app && grant.role_key === request.role_key
			&& grant.scope_type === request.scope_type && grant.scope_value === request.scope_value
			&& (grant.expires_at === null || grant.expires_at > unixNow())
		)
		if (held) return fail(409, 'the principal already holds this grant; reject the request')
	}
	return current
}

/**
 * Make grant changes at `app` wait, or apply at once again (ADR-0083 §4). Control is the caller, with the provisioning
 * key, when an environment chooses or drops the `grants` category; only an application environment id qualifies.
 */
export async function setGrantApprovalUseCase(c: AdminContext, input: SetGrantApprovalRequest): Promise<SetGrantApprovalRequest> {
	if (parseAppEnvironmentId(input.app) === null || c.services.config.platformAudiences.has(input.app)) {
		return fail(400, 'grant approval applies to an application environment id `<app>@<env>`')
	}
	await c.services.repositories.grantRequests.setGrantsWait(
		input.app,
		input.required,
		unixNow(),
		adminEvent(c, { action: 'iam.grant_approval.set', resourceType: 'app', resourceId: input.app, metadata: { required: input.required } }),
	)
	return { app: input.app, required: input.required }
}

async function toGrantRequestDto(services: Services, row: GrantRequestRow, now: number): Promise<GrantRequestDto> {
	const { principals } = services.repositories
	return {
		id: row.id,
		app: row.app,
		kind: row.kind,
		principalId: row.principal_id,
		principalLabel: (await principals.getPrincipalById(row.principal_id))?.label ?? null,
		grantId: row.grant_id,
		roleKey: row.role_key,
		permissions: row.permissions === null ? null : parseStoredPermissions(row.permissions),
		scopeType: row.scope_type,
		scopeValue: row.scope_value,
		grantExpiresAt: row.grant_expires_at,
		requestedBy: row.requested_by,
		requestedByLabel: (await principals.getPrincipalById(row.requested_by))?.label ?? null,
		requestedAt: row.requested_at,
		expiresAt: row.expires_at,
		status: row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status,
		decidedBy: row.decided_by,
		decidedAt: row.decided_at,
	}
}
