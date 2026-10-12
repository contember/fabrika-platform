import { type CreateGrantRequest, type GrantDto, type OkResponse } from '@fabrika/iam-contract'
import { contractGrantProblem } from '../contract-rules'
import { type GrantRow } from '../db'
import { type AdminContext, adminEvent, fail } from './context'
import { appField, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDto } from './grant-support'

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
	const cache = new RoleKnownCache(c.services)
	return toGrantDto(grant, cache)
}

export async function deleteGrantUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const id = input.id
	const grant = await c.services.repositories.grants.getGrantById(id)
	if (!grant) {
		return fail(404, 'grant not found')
	}
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
