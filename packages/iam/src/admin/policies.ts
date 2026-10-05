import { isActionAllowed } from '@fabrika/auth-core'

import { type AppInput, type CreatePolicyInput, type OkResponse, type PolicyDto, type UpdatePolicyInput } from '@fabrika/iam-contract'
import { type RoleRow } from '../db'
import { BUILTIN_ROLES } from '../roles'
import { adminAudit, type AdminContext, fail } from './context'
import { knownApps, rolePermissions } from './grant-support'

function toPolicyDto(row: RoleRow): PolicyDto {
	return {
		app: row.app,
		key: row.role_key,
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		permissions: rolePermissions(row.permissions),
		createdAt: row.created_at,
	}
}

/** List an app's custom policies (origin='custom' role rows). */
export async function listPoliciesUseCase(c: AdminContext, input: AppInput): Promise<{ items: PolicyDto[] }> {
	const app = input.app
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const rows = await c.services.repositories.appSchema.listRolesByOrigin(app, 'custom')
	return { items: rows.map(toPolicyDto) }
}

/**
 * Validate a policy body's action patterns against the app's catalog (`app_actions`),
 * returning normalized fields or an error message. Shared by create + update.
 */
async function parsePolicyBody(
	c: AdminContext,
	app: string,
	body: UpdatePolicyInput['policy'] & { key?: string },
	requireKey: boolean,
): Promise<{ ok: true; key: string | undefined; name: string; description: string | null; permissions: string[] } | { ok: false; message: string }> {
	const { key, name, permissions } = body
	if (requireKey && key === undefined) {
		return { ok: false, message: 'key required' }
	}
	if (permissions.length === 0) {
		return { ok: false, message: 'permissions must be a non-empty array of action patterns' }
	}
	// A custom policy must not collide with a built-in role key.
	if (key !== undefined && Object.hasOwn(BUILTIN_ROLES, key)) {
		return { ok: false, message: `'${key}' is a reserved built-in role key` }
	}
	const catalog = await c.services.repositories.appSchema.listActionCatalog(app)
	for (const pattern of permissions) {
		if (!isActionAllowed(pattern, catalog)) {
			return { ok: false, message: `unknown action pattern: ${pattern}` }
		}
	}
	const description = body.description ?? null
	return { ok: true, key, name, description, permissions }
}

/** Create a custom policy (origin='custom' role). Rejects a key that already exists. */
export async function createPolicyUseCase(c: AdminContext, input: CreatePolicyInput): Promise<PolicyDto> {
	const { app, policy: body } = input
	if (!(await knownApps(c)).includes(app)) return fail(404, 'unknown app')
	const parsed = await parsePolicyBody(c, app, body, true)
	if (!parsed.ok) {
		return fail(400, parsed.message)
	}
	const key = parsed.key
	if (key === undefined) {
		return fail(400, 'key required')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (existing) {
		return fail(409, `a role with key '${key}' already exists`)
	}
	const row = await c.services.repositories.appSchema.upsertRole({
		app,
		roleKey: key,
		name: parsed.name,
		description: parsed.description,
		permissions: parsed.permissions,
		origin: 'custom',
	})
	await adminAudit(c, {
		action: 'iam.policy.create',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key, permissions: parsed.permissions },
	})
	return toPolicyDto(row)
}

/** Update a custom policy. Rejects if the key is missing or is an origin='app' role. */
export async function updatePolicyUseCase(c: AdminContext, input: UpdatePolicyInput): Promise<PolicyDto> {
	const { app, key, policy: body } = input
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (existing?.origin !== 'custom') {
		return fail(404, 'custom policy not found')
	}
	const parsed = await parsePolicyBody(c, app, body, false)
	if (!parsed.ok) {
		return fail(400, parsed.message)
	}
	const row = await c.services.repositories.appSchema.upsertRole({
		app,
		roleKey: key,
		name: parsed.name,
		description: parsed.description,
		permissions: parsed.permissions,
		origin: 'custom',
	})
	await adminAudit(c, {
		action: 'iam.policy.update',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key, permissions: parsed.permissions },
	})
	return toPolicyDto(row)
}

/** Delete a custom policy. Refuses to delete an origin='app' (reconciled) role. */
export async function deletePolicyUseCase(c: AdminContext, input: { app: string; key: string }): Promise<OkResponse> {
	const { app, key } = input
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (existing?.origin !== 'custom') {
		return fail(404, 'custom policy not found')
	}
	await c.services.repositories.appSchema.deleteRole(app, key)
	await adminAudit(c, {
		action: 'iam.policy.delete',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key },
	})
	return { ok: true }
}
