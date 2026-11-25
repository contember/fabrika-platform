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
import { PROVISIONING_ADMIN_ID } from '../auth'
import { contractGrantProblem, externalGrantProblem } from '../contract-rules'
import { type AuditEventInput, auditLabelOf, type CreateGrantRequestInput, ExternalGrantError, type GrantRequestRow, type GrantSetRead } from '../db'
import { requestScopeValues } from '../repositories/grants'
import { unixNow } from '../repositories/sql'
import type { Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { type AdminContext, adminEvent, fail } from './context'
import { appField, grantIdOf, parseRoleOrInline } from './grant-support'
import type { ResolvedAdmin } from './router'
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
				scopeValue: change.scopeValues?.[0] ?? null,
				...(change.scopeValues !== null && change.scopeValues.length > 1 ? { scopeValues: change.scopeValues } : {}),
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
	const scopeValues = requestScopeValues(request)
	let applied: Awaited<ReturnType<typeof c.services.repositories.grants.applyRequest>>
	try {
		applied = await c.services.repositories.grants.applyRequest(request, current, decision, (grantId) =>
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
					scopeValue: scopeValues?.[0] ?? null,
					...(scopeValues !== null && scopeValues.length > 1 ? { scopeValues } : {}),
					grantRequestId: request.id,
					requestedBy: request.requested_by,
				},
			}))
	} catch (cause) {
		// Both roll the whole batch back, the claim included: the request stays open for a later decision or a rejection.
		if (cause instanceof ExternalGrantError) return fail(409, `${cause.message}; reject the request`)
		if (await heldElsewhere(c, request)) return fail(409, 'the principal already holds this grant; reject the request')
		throw cause
	}
	if (!applied.claimed) return fail(409, 'the grant request is no longer open')
	if (applied.changed === null) {
		return fail(409, 'the change no longer applies: the access changed since the checks; the request is closed as failed')
	}
	const decided = await requests.get(request.id)
	return decided === null ? fail(404, 'grant request not found') : toGrantRequestDto(c.services, decided, now)
}

/** The caller of a grant request procedure who administers no IAM application: an application's own administrator. */
export interface GrantRequester {
	readonly services: Services
	readonly requestId: string
	readonly admin: ResolvedAdmin
}

/** A requester without IAM administration sees only the requests they made (an application administrator's own). */
export async function listOwnGrantRequestsUseCase(c: GrantRequester, input: ListGrantRequestsInput): Promise<{ items: GrantRequestDto[] }> {
	const now = unixNow()
	const rows = (await c.services.repositories.grantRequests.listOpen(now)).filter((row) =>
		(input.app === undefined || row.app === input.app) && row.requested_by === c.admin.id
	)
	return { items: await Promise.all(rows.map((row) => toGrantRequestDto(c.services, row, now))) }
}

/**
 * A requester without IAM administration withdraws a request they made, as a person in a signed-in session; any other
 * request, and approving, is the 404 of an unknown one. The record is filed under the request's application.
 */
export async function withdrawOwnGrantRequestUseCase(c: GrantRequester, input: DecideGrantRequestInput): Promise<GrantRequestDto> {
	const requests = c.services.repositories.grantRequests
	const request = await requests.get(input.id)
	if (request === null || request.requested_by !== c.admin.id || input.decision !== 'reject') return fail(404, 'grant request not found')
	if (c.admin.type !== 'user' || !c.admin.session) return fail(403, 'only a person signed in to the console decides a grant request, never a key')
	const now = unixNow()
	const rejected = await requests.reject(request.id, c.admin.id, now, {
		requestId: c.requestId,
		principalId: c.admin.id,
		principalLabel: auditLabelOf(c.admin),
		app: request.app,
		action: 'iam.grant.request.reject',
		resourceType: 'grant_request',
		resourceId: request.id,
		metadata: { app: request.app, kind: request.kind, principalId: request.principal_id, requestedBy: request.requested_by },
	})
	return rejected === null ? fail(409, 'the grant request is no longer open') : toGrantRequestDto(c.services, rejected, now)
}

/**
 * The checks the original change ran, again, with the approver as the administrator: the approver must be able to make
 * the change now. Answers the grant an `update` or a `revoke` acts on.
 */
async function approvable(c: AdminContext, request: GrantRequestRow): Promise<GrantSetRead | null> {
	const { grants, principals, appSchema } = c.services.repositories
	const principal = await principals.getPrincipalById(request.principal_id)
	if (principal === null) return fail(409, 'the principal no longer exists; reject the request')
	if (await grants.isWorkloadPrincipal(principal.id)) return fail(409, 'a job, a webhook or a connector holds no grant')
	requireGrantablePrincipal(c, principal)
	const current = request.grant_id === null ? null : await grants.getGrantSet(request.grant_id)
	const [held] = current?.rows ?? []
	if (request.kind !== 'create' && (held === undefined || held.app !== request.app || held.principal_id !== principal.id)) {
		return fail(409, 'the grant is gone; reject the request')
	}
	if (request.kind === 'revoke') return current
	if (!(await appField(c, { app: request.app })).ok) return fail(409, 'the application is no longer registered; reject the request')
	const parsed = await parseRoleOrInline(
		c,
		request.role_key === null ? { permissions: parseStoredPermissions(request.permissions ?? '[]') } : { roleKey: request.role_key },
		request.app,
	)
	if (!parsed.ok) return fail(409, `${parsed.message}; reject the request`)
	const authorization = {
		roleKey: request.role_key,
		permissions: request.permissions === null ? null : parseStoredPermissions(request.permissions),
		scopeType: request.scope_type,
	}
	const problem = await contractGrantProblem(appSchema, request.app, authorization, principal.type === 'user')
		?? await externalGrantProblem(appSchema, principal, request.app, authorization)
	if (problem !== null) return fail(409, problem)
	if (await heldElsewhere(c, request)) return fail(409, 'the principal already holds this grant; reject the request')
	return current
}

/**
 * Whether another grant of the principal already holds the requested role in one of the requested values. A scoped one
 * counts expired too: the unique index refuses the value either way; only an expired app-wide grant is renewed in place.
 */
async function heldElsewhere(c: AdminContext, request: GrantRequestRow): Promise<boolean> {
	if (request.role_key === null) return false
	const values = requestScopeValues(request)
	return (await c.services.repositories.grants.listGrants(request.principal_id)).some((grant) =>
		grantIdOf(grant) !== request.grant_id && grant.app === request.app && grant.role_key === request.role_key
		&& grant.scope_type === request.scope_type
		&& (values === null
			? grant.scope_value === null && (grant.expires_at === null || grant.expires_at > unixNow())
			: grant.scope_value !== null && values.includes(grant.scope_value))
	)
}

/**
 * Set an application environment's gates (ADR-0083 §4, §8): whether its grant changes wait, and its `credentials` mode,
 * which IAM's own key issuance to a machine caller meets. Only Control sets them, with the provisioning key, whenever the
 * environment's protection changes and on its maintenance pass: an installation administrator who could switch them off
 * could grant or issue past them. Only an application environment id qualifies.
 */
export async function setGrantApprovalUseCase(c: AdminContext, input: SetGrantApprovalRequest): Promise<SetGrantApprovalRequest> {
	if (c.admin.id !== PROVISIONING_ADMIN_ID) {
		return fail(403, 'only Control sets whether grants wait, with the provisioning key')
	}
	if (parseAppEnvironmentId(input.app) === null || c.services.config.platformAudiences.has(input.app)) {
		return fail(400, 'grant approval applies to an application environment id `<app>@<env>`')
	}
	const stored = await c.services.repositories.grantRequests.setGates(
		input.app,
		{ required: input.required, ...(input.credentials === undefined ? {} : { credentials: input.credentials }) },
		input.revision,
		unixNow(),
		adminEvent(c, {
			action: 'iam.grant_approval.set',
			resourceType: 'app',
			resourceId: input.app,
			metadata: { required: input.required, revision: input.revision, ...(input.credentials === undefined ? {} : { credentials: input.credentials }) },
		}),
	)
	return {
		app: input.app,
		required: stored.required,
		revision: stored.revision,
		...(stored.credentials === null ? {} : { credentials: stored.credentials }),
	}
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
		scopeValues: requestScopeValues(row),
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
