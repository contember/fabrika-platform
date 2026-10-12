import { appSchemaSchema } from '@fabrika/auth'
import type { AppDelegationDef, AppLinkMountDef, RoleDef } from '@fabrika/auth-core'

import {
	type AppDto,
	type AppInput,
	type AppSchemaDto,
	type ListRolesInput,
	type ReturnOriginsDto,
	type RoleDto,
	type SetReturnOriginsRequest,
} from '@fabrika/iam-contract'
import type { z } from 'zod'
import { normalizeOrigin } from '../handoff'
import { BUILTIN_ROLES } from '../roles'
import { parseStoredPermissions } from '../stored-permissions'
import { adminAudit, type AdminContext, fail } from './context'
import { dbRoleToDef, knownApps, rolePermissions } from './grant-support'
import { error, json, readJson } from './http'

/** The app ids a grant can be scoped to — the apps that have registered a vocabulary. */
export async function listAppsUseCase(c: AdminContext): Promise<{ items: AppDto[] }> {
	const items: AppDto[] = (await knownApps(c)).map((id) => ({ id }))
	return { items }
}

/**
 * The roles available to grant for an app: the built-ins (cross-app, e.g. `admin`)
 * plus the app's DB roles (origin 'app' + 'custom'). Without an app, only built-ins are
 * listed. Built-ins win on a key collision so an app cannot shadow the cross-app `admin`.
 */
export async function listRolesUseCase(c: AdminContext, input: ListRolesInput): Promise<{ items: RoleDto[] }> {
	const items: RoleDto[] = []
	const appParam = input.app ?? null
	const app = appParam !== null && (await knownApps(c)).includes(appParam) ? appParam : null
	const builtinKeys = new Set(Object.keys(BUILTIN_ROLES))
	if (app !== null) {
		for (const row of await c.services.repositories.appSchema.listRoles(app)) {
			if (builtinKeys.has(row.role_key)) {
				continue // a built-in shadows any same-key DB row in the grantable list
			}
			items.push({
				key: row.role_key,
				name: row.name,
				...(row.description !== null ? { description: row.description } : {}),
				permissions: rolePermissions(row.permissions),
				origin: row.origin,
			})
		}
	}
	for (const [key, role] of Object.entries(BUILTIN_ROLES)) {
		items.push({
			key,
			name: role.name,
			...(role.description ? { description: role.description } : {}),
			permissions: role.permissions,
			origin: 'builtin',
		})
	}
	return { items }
}

/** The 400 message for a refused vocabulary, naming the envelope field or the role at fault. */
function appSchemaError(issues: readonly z.ZodIssue[]): string {
	// A wrong envelope is the more useful report than the first bad element inside it.
	const issue = issues.find((candidate) => candidate.path.length === 1) ?? issues[0]
	const [field, key] = issue?.path ?? []
	// A cross-reference refusal names its own problem; only a malformed shape gets the generic message.
	if (issue?.code === 'custom' && issue.path.length > 2) return issue.message
	if (field === 'roles') {
		if (typeof key !== 'string') return 'roles must be an object (role_key -> def)'
		return `role '${key}' needs a non-empty name and a permissions array, and a usable key`
	}
	if (field === 'links') {
		return typeof key === 'string'
			? `link mount '${key}' needs a dimension, exact grants, an issuedBy action and maxDays from 1 to 365, and a usable key`
			: 'links must be an object (mount -> def)'
	}
	if (field === 'delegations') {
		return typeof key === 'string'
			? `endpoint '${key}' needs an action, a dimension and a purpose of 'members' or 'creates', and a usable key`
			: 'delegations must be an object (endpoint -> def)'
	}
	if (field === 'workloads') {
		return typeof key === 'number'
			? "each workload needs a kind of 'job' or 'webhook', a name and an array of exact actions"
			: 'workloads must be an array'
	}
	if (key === undefined) return 'scopes and actions must be arrays'
	return field === 'scopes'
		? 'each scope needs a non-empty `type` and, when present, a non-empty `label`, `in`, `creator` and `members`'
		: 'each action needs a non-empty `action` and, when present, a non-empty `description`'
}

/**
 * Reconcile an app's declared vocabulary (idempotent): upsert its scopes/actions and
 * origin='app' roles, delete app-origin rows absent from the body, and NEVER touch
 * origin='custom' roles. Every role's patterns are validated against the body's own
 * action catalog. The `:app` path segment is the app id this vocabulary belongs to.
 */
export async function putAppSchema(c: AdminContext, app: string): Promise<Response> {
	// No knownApps gate: an app's FIRST schema reconcile is how it REGISTERS itself (this endpoint is
	// admin-gated). After this, `db.listKnownApps()` surfaces the app id across the schema tables.
	const body = await readJson(c.request)
	const parsed = appSchemaSchema.safeParse(body)
	if (!parsed.success) {
		return error(400, appSchemaError(parsed.error.issues))
	}
	const schema = parsed.data
	// A role key an admin already owns as a custom policy is a CONFLICT, not something to overwrite.
	// The rule was one-directional: `createPolicyUseCase` 409s on an existing key so an admin can never
	// clobber an app role, but a deploy silently flipped a custom policy to origin='app' — after which
	// update and delete both 404 and the policy is unmanageable (SEC-3). Refused here, loudly, so the
	// deploy fails with the collision named rather than quietly rewriting somebody's policy.
	const collisions: string[] = []
	for (const row of await c.services.repositories.appSchema.listRoles(app)) {
		if (row.origin === 'custom' && Object.hasOwn(schema.roles, row.role_key)) {
			collisions.push(row.role_key)
		}
	}
	if (collisions.length > 0) {
		return error(
			409,
			`the app declares role ${collisions.map((key) => `'${key}'`).join(', ')}, which already exists as an admin-composed custom policy. `
				+ 'Rename the declared role or delete the policy; a deploy never overwrites one.',
		)
	}
	// A role newly declared a membership role would turn its existing global grants into global
	// membership grants. Resolution ignores such a grant anyway; refusing names the grants to fix.
	const outside: string[] = []
	for (const [roleKey, def] of Object.entries(schema.roles)) {
		if (def.member === undefined) continue
		for (const grant of await c.services.repositories.grants.listRoleGrantsOutsideScope(app, roleKey, def.member.scope)) {
			outside.push(`${grant.id} (role '${roleKey}')`)
		}
	}
	if (outside.length > 0) {
		return error(
			409,
			`the app declares a membership role whose existing grants are not in a value of its scope: ${outside.join(', ')}. `
				+ 'Delete or re-scope those grants first.',
		)
	}
	await c.services.repositories.appSchema.reconcileAppSchema({
		app,
		scopes: schema.scopes.map((s) => ({
			scopeType: s.type,
			label: s.label ?? null,
			parentScope: s.in ?? null,
			creatorRole: s.creator ?? null,
			members: s.members ?? null,
			directory: s.directory ?? null,
		})),
		actions: schema.actions.map((a) => ({ action: a.action, description: a.description ?? null })),
		roles: Object.entries(schema.roles).map(([roleKey, def]) => ({
			roleKey,
			name: def.name,
			description: def.description ?? null,
			permissions: def.permissions,
			memberScope: def.member?.scope ?? null,
			assignableBy: def.member?.assignableBy ?? null,
		})),
		contract: schema.contract === true,
		links: Object.entries(schema.links ?? {}).map(([mount, link]) => ({ mount, ...link })),
		delegations: Object.entries(schema.delegations ?? {}).map(([endpoint, delegation]) => ({ endpoint, ...delegation })),
		workloads: schema.workloads ?? [],
	})
	await adminAudit(c, {
		action: 'iam.app.schema.reconcile',
		resourceType: 'app',
		resourceId: app,
		metadata: {
			scopes: schema.scopes.length,
			actions: schema.actions.length,
			roles: Object.keys(schema.roles),
			contract: schema.contract === true,
			links: Object.keys(schema.links ?? {}),
			delegations: Object.keys(schema.delegations ?? {}),
			workloads: (schema.workloads ?? []).map((workload) => `${workload.kind}:${workload.name}`),
		},
	})
	return json(await readAppSchemaDto(c, app))
}

/** Read the app's scopes, actions, and origin='app' roles into a DTO (no auth gate). */
async function readAppSchemaDto(c: AdminContext, app: string): Promise<AppSchemaDto> {
	const scopeRows = await c.services.repositories.appSchema.listAppScopes(app)
	const actionRows = await c.services.repositories.appSchema.listAppActions(app)
	const roleRows = await c.services.repositories.appSchema.listRolesByOrigin(app, 'app')
	const roles: Record<string, RoleDef> = {}
	for (const row of roleRows) {
		roles[row.role_key] = dbRoleToDef(row)
	}
	const links: Record<string, AppLinkMountDef> = {}
	for (const row of await c.services.repositories.appSchema.listLinkMounts(app)) {
		links[row.mount] = { dimension: row.dimension, grants: parseStoredPermissions(row.grants), issuedBy: row.issued_by, maxDays: row.max_days }
	}
	const delegations: Record<string, AppDelegationDef> = {}
	for (const row of await c.services.repositories.appSchema.listDelegatedEndpoints(app)) {
		delegations[row.endpoint] = { action: row.action, dimension: row.dimension, purpose: row.purpose }
	}
	return {
		app,
		scopes: scopeRows.map((r) => ({
			type: r.scope_type,
			...(r.label !== null ? { label: r.label } : {}),
			...(r.parent_scope !== null ? { in: r.parent_scope } : {}),
			...(r.creator_role !== null ? { creator: r.creator_role } : {}),
			...(r.members_manage !== null && r.members_list !== null ? { members: { manage: r.members_manage, list: r.members_list } } : {}),
			...(r.members_directory === 'labels' ? { directory: 'labels' } : {}),
		})),
		actions: actionRows.map((r) => ({ action: r.action, ...(r.description !== null ? { description: r.description } : {}) })),
		roles,
		...(Object.keys(links).length > 0 ? { links } : {}),
		...(Object.keys(delegations).length > 0 ? { delegations } : {}),
	}
}

/**
 * Replace an app's registered return origins (ADR-0022). Every value is canonicalized before it is
 * stored, so the comparison at issue time is against one spelling and an operator cannot register
 * `https://App.Example.com/` and then wonder why `https://app.example.com` is refused.
 *
 * The app is validated FIRST, so a typo in the app id is reported as a typo in the app id rather than
 * as an origin problem. An EMPTY set is refused as a caller error: it is indistinguishable from an
 * app that never registered, and reaching that state through this endpoint is always a mistake.
 */
export async function setReturnOriginsUseCase(c: AdminContext, input: SetReturnOriginsRequest): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	if (input.origins.length === 0) {
		return fail(400, 'at least one origin is required')
	}
	const origins: string[] = []
	for (const raw of input.origins) {
		const normalized = normalizeOrigin(raw)
		if (normalized === null) {
			return fail(400, `not an absolute http(s) origin: ${raw}`)
		}
		if (!origins.includes(normalized)) {
			origins.push(normalized)
		}
	}
	await c.services.repositories.handoff.setReturnOrigins(input.app, origins)
	await adminAudit(c, {
		action: 'iam.app.return-origins.set',
		resourceType: 'app',
		resourceId: input.app,
		metadata: { origins },
	})
	return { app: input.app, origins }
}

export async function getAppSchemaUseCase(c: AdminContext, input: AppInput): Promise<AppSchemaDto> {
	const app = input.app
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	return readAppSchemaDto(c, app)
}
