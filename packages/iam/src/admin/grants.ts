import { type CreateGrantRequest, type GrantDto, type OkResponse, type UpdateGrantInput } from '@fabrika/iam-contract'
import { contractGrantProblem, externalGrantProblem } from '../contract-rules'
import { ExternalGrantError, type GrantRow } from '../db'
import { type AdminContext, adminEvent, fail } from './context'
import { appField, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDto } from './grant-support'
import { requireGrantablePrincipal, requireManagedApp } from './user-admin'

export async function createGrantUseCase(c: AdminContext, input: CreateGrantRequest): Promise<GrantDto> {
	const principalId = input.principalId
	if (principalId.trim() === '') return fail(400, 'principalId required')
	if (await c.services.repositories.grants.isWorkloadPrincipal(principalId)) {
		return fail(409, 'a job, a webhook or a connector holds no grant: its actions come from the application schema')
	}
	const appResult = await appField(c, input)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	requireManagedApp(c, app)
	const roleOrInline = await parseRoleOrInline(c, input, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(input)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const contractProblem = await contractGrantProblem(c.services.repositories.appSchema, app, { ...roleOrInline, scopeType: scope.scopeType })
	if (contractProblem !== null) {
		return fail(400, contractProblem)
	}
	const expiresAt = Number.isFinite(input.expiresAt) ? input.expiresAt ?? null : null
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	requireGrantablePrincipal(c, principal)
	const external = await externalGrantProblem(c.services.repositories.appSchema, principal, app, roleOrInline)
	if (external !== null) {
		return fail(409, external)
	}
	const values = { principalId, app, scopeType: scope.scopeType, scopeValue: scope.scopeValue, grantedBy: c.admin.id, expiresAt }
	const roleKey = roleOrInline.roleKey
	const record = (grantId: string) =>
		adminEvent(c, {
			action: 'iam.grant.create',
			resourceType: 'grant',
			resourceId: grantId,
			metadata: {
				principalId,
				roleKey: roleOrInline.roleKey,
				permissions: roleOrInline.permissions,
				scopeType: scope.scopeType,
				scopeValue: scope.scopeValue,
				app,
			},
		})
	let grant: GrantRow
	try {
		if (roleKey === null) {
			grant = await c.services.repositories.grants.createGrant({ ...values, permissions: roleOrInline.permissions }, record)
		} else {
			const created = await c.services.repositories.grants.createRoleGrantUnlessHeld({ ...values, roleKey }, record)
			if (created === null) {
				const held = await findHeldRoleGrant(c, { ...values, roleKey }).catch(() => undefined)
				const naming = held === undefined ? '' : `: ${held.id}`
				return fail(409, `principal ${principalId} already holds this grant${naming}`)
			}
			grant = created
		}
	} catch (cause) {
		// A reconcile narrowed the role between the check above and the write, which carries the condition itself.
		if (cause instanceof ExternalGrantError) return fail(409, cause.message)
		throw cause
	}
	const cache = new RoleKnownCache(c.services)
	return toGrantDto(grant, cache)
}

export async function deleteGrantUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const id = input.id
	const grant = await c.services.repositories.grants.getGrantById(id)
	if (!grant) {
		return fail(404, 'grant not found')
	}
	requireManagedApp(c, grant.app)
	const principal = await c.services.repositories.principals.getPrincipalById(grant.principal_id)
	if (!principal) {
		return fail(404, 'grant not found')
	}
	requireGrantablePrincipal(c, principal)
	await c.services.repositories.grants.deleteGrant(
		id,
		adminEvent(c, {
			action: 'iam.grant.revoke',
			resourceType: 'grant',
			resourceId: id,
			metadata: {
				principalId: grant.principal_id,
				roleKey: grant.role_key,
				scopeType: grant.scope_type,
				scopeValue: grant.scope_value,
			},
		}),
	)
	return { ok: true }
}

/** Edit a grant in place within its original application. Both paths use the same role, scope and external-person rules. */
export async function updateGrantUseCase(c: AdminContext, input: UpdateGrantInput): Promise<GrantDto> {
	const grant = await c.services.repositories.grants.getGrantById(input.id)
	if (grant === null) return fail(404, 'grant not found')
	requireManagedApp(c, grant.app)
	const principal = await c.services.repositories.principals.getPrincipalById(grant.principal_id)
	if (principal === null) return fail(404, 'principal not found')
	requireGrantablePrincipal(c, principal)
	const authorization = await parseRoleOrInline(c, input, grant.app)
	if (!authorization.ok) return fail(400, authorization.message)
	const scope = parseScope(input)
	if (!scope.ok) return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	const problem = await contractGrantProblem(c.services.repositories.appSchema, grant.app, { ...authorization, scopeType: scope.scopeType })
		?? await externalGrantProblem(c.services.repositories.appSchema, principal, grant.app, authorization)
	if (problem !== null) return fail(409, problem)
	const expiresAt = input.expiresAt ?? null
	if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) return fail(400, 'Choose an expiration in the future, or no expiration.')
	const values = { principalId: principal.id, app: grant.app, ...authorization, ...scope, expiresAt }
	if (
		grant.role_key === authorization.roleKey
		&& grant.permissions === (authorization.permissions === null ? null : JSON.stringify(authorization.permissions))
		&& grant.scope_type === scope.scopeType && grant.scope_value === scope.scopeValue && grant.expires_at === expiresAt
	) {
		return toGrantDto(grant, new RoleKnownCache(c.services))
	}
	const duplicate = async () =>
		authorization.roleKey !== null
		&& (await c.services.repositories.grants.listGrants(principal.id)).some((other) =>
			other.id !== grant.id && other.app === grant.app && other.role_key === authorization.roleKey
			&& other.scope_type === scope.scopeType && other.scope_value === scope.scopeValue
		)
	if (await duplicate()) return fail(409, 'This user already has that role in this scope. Edit the existing access instead.')
	let updated: GrantRow | null
	try {
		updated = await c.services.repositories.grants.updateGrant(
			grant,
			values,
			adminEvent(c, {
				action: 'iam.grant.update',
				resourceType: 'grant',
				resourceId: grant.id,
				metadata: { principalId: principal.id, app: grant.app },
				diff: {
					before: {
						roleKey: grant.role_key,
						permissions: grant.permissions === null ? null : JSON.parse(grant.permissions),
						scopeType: grant.scope_type,
						scopeValue: grant.scope_value,
						expiresAt: grant.expires_at,
					},
					after: {
						roleKey: authorization.roleKey,
						permissions: authorization.permissions,
						scopeType: scope.scopeType,
						scopeValue: scope.scopeValue,
						expiresAt,
					},
				},
			}),
		)
	} catch (cause) {
		if (await duplicate()) return fail(409, 'This user already has that role in this scope. Edit the existing access instead.')
		throw cause
	}
	if (updated === null) return fail(409, 'The access changed or is no longer allowed. Refresh and try again.')
	return toGrantDto(updated, new RoleKnownCache(c.services))
}

/** The held grant a refused role grant duplicates, to name it in the 409; it may be gone by the time this reads. */
async function findHeldRoleGrant(
	c: AdminContext,
	candidate: { principalId: string; app: string | null; roleKey: string; scopeType: string | null; scopeValue: string | null },
): Promise<GrantRow | undefined> {
	const held = await c.services.repositories.grants.listGrants(candidate.principalId)
	return held.find((row) =>
		row.role_key === candidate.roleKey
		&& row.app === candidate.app
		&& row.scope_type === candidate.scopeType
		&& row.scope_value === candidate.scopeValue
	)
}
