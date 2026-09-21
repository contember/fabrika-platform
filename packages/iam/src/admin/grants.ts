import { type CreateGrantRequest, type GrantDto, type OkResponse } from '@fabrika/iam-contract'
import { numberField } from '../json'
import { adminAudit, type AdminContext, fail } from './context'
import { appField, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDto } from './grant-support'

export async function createGrantUseCase(c: AdminContext, input: CreateGrantRequest): Promise<GrantDto> {
	const principalId = input.principalId
	if (principalId.trim() === '') return fail(400, 'principalId required')
	const body: unknown = input
	const appResult = await appField(c, body)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	const roleOrInline = await parseRoleOrInline(c, body, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(body)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const expiresAt = numberField(body, 'expiresAt') ?? null
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const grant = await c.services.repositories.grants.createGrant({
		principalId,
		app,
		roleKey: roleOrInline.roleKey,
		permissions: roleOrInline.permissions,
		scopeType: scope.scopeType,
		scopeValue: scope.scopeValue,
		grantedBy: c.admin.id,
		expiresAt,
	})
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
