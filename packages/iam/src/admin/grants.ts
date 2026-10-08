import { type CreateGrantRequest, type GrantDto, type OkResponse } from '@fabrika/iam-contract'
import { type GrantRow } from '../db'
import { adminAudit, type AdminContext, fail } from './context'
import { appField, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDto } from './grant-support'

export async function createGrantUseCase(c: AdminContext, input: CreateGrantRequest): Promise<GrantDto> {
	const principalId = input.principalId
	if (principalId.trim() === '') return fail(400, 'principalId required')
	const appResult = await appField(c, input)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	const roleOrInline = await parseRoleOrInline(c, input, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(input)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const expiresAt = Number.isFinite(input.expiresAt) ? input.expiresAt ?? null : null
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const candidate = { principalId, app, roleKey: roleOrInline.roleKey, scopeType: scope.scopeType, scopeValue: scope.scopeValue }
	let grant: GrantRow
	try {
		grant = await c.services.repositories.grants.createGrant({
			...candidate,
			permissions: roleOrInline.permissions,
			grantedBy: c.admin.id,
			expiresAt,
		})
	} catch (err) {
		// The unique indexes are the arbiter, so a concurrent duplicate lands here too; the error itself
		// differs per engine, so the conflict is recognized by the row it collided with.
		const existing = await findHeldRoleGrant(c, candidate).catch(() => undefined)
		if (existing === undefined) {
			throw err
		}
		return fail(409, `principal ${principalId} already holds this grant: ${existing.id}`)
	}
	await adminAudit(c, {
		action: 'iam.grant.create',
		resourceType: 'grant',
		resourceId: grant.id,
		metadata: {
			principalId,
			roleKey: roleOrInline.roleKey,
			permissions: roleOrInline.permissions,
			scopeType: scope.scopeType,
			scopeValue: scope.scopeValue,
			app,
		},
	})
	const cache = new RoleKnownCache(c.services)
	return toGrantDto(grant, cache)
}

export async function deleteGrantUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const id = input.id
	const grant = await c.services.repositories.grants.getGrantById(id)
	if (!grant) {
		return fail(404, 'grant not found')
	}
	await c.services.repositories.grants.deleteGrant(id)
	await adminAudit(c, {
		action: 'iam.grant.revoke',
		resourceType: 'grant',
		resourceId: id,
		metadata: {
			principalId: grant.principal_id,
			roleKey: grant.role_key,
			scopeType: grant.scope_type,
			scopeValue: grant.scope_value,
		},
	})
	return { ok: true }
}

/**
 * The stored grant a role grant would duplicate. Mirrors `idx_grants_uq_scoped` / `idx_grants_uq_global`:
 * only role grants are unique, and expiry is not part of the key.
 */
async function findHeldRoleGrant(
	c: AdminContext,
	candidate: { principalId: string; app: string | null; roleKey: string | null; scopeType: string | null; scopeValue: string | null },
): Promise<GrantRow | undefined> {
	if (candidate.roleKey === null) {
		return undefined
	}
	const held = await c.services.repositories.grants.listGrants(candidate.principalId)
	return held.find((row) =>
		row.role_key === candidate.roleKey
		&& row.app === candidate.app
		&& row.scope_type === candidate.scopeType
		&& row.scope_value === candidate.scopeValue
	)
}
