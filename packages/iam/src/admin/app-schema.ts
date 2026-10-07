import { type AppSchema, isActionAllowed, type RoleDef } from '@fabrika/auth-core'

import {
	type AppDto,
	type AppInput,
	type AppSchemaDto,
	type ListRolesInput,
	type ReturnOriginsDto,
	type RoleDto,
	type SetReturnOriginsRequest,
} from '@fabrika/iam-contract'
import { z } from 'zod'
import { normalizeOrigin } from '../handoff'
import { BUILTIN_ROLES } from '../roles'
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

/**
 * Validate that a value is a well-formed `AppSchema` (scopes/actions/roles arrays of
 * the right shape) and return it normalized, or an error message. Each role's
 * permission patterns are validated against the body's OWN action catalog via
 * `isActionAllowed` — an unknown action is a 400.
 */
const vocabularyEnvelopeSchema = z.object({ scopes: z.array(z.unknown()), actions: z.array(z.unknown()), roles: z.record(z.unknown()) })
const scopesSchema = z.array(
	z.object({ type: z.string(), label: z.string().optional().catch(undefined) }).transform(({ type, label }) => ({
		type,
		...(label === undefined ? {} : { label }),
	})),
)
const actionsSchema = z.array(
	z.object({ action: z.string(), description: z.string().optional().catch(undefined) }).transform(({ action, description }) => ({
		action,
		...(description === undefined ? {} : { description }),
	})),
)
const roleSchema = z.object({ name: z.string(), permissions: z.array(z.string()), description: z.string().optional().catch(undefined) })

function parseAppSchema(body: unknown): { ok: true; schema: AppSchema } | { ok: false; message: string } {
	const envelope = vocabularyEnvelopeSchema.safeParse(body)
	if (!envelope.success) {
		return {
			ok: false,
			message: envelope.error.issues[0]?.path[0] === 'roles' ? 'roles must be an object (role_key -> def)' : 'scopes and actions must be arrays',
		}
	}
	const scopes = scopesSchema.safeParse(envelope.data.scopes)
	if (!scopes.success) return { ok: false, message: 'each scope needs a string `type`' }
	const actions = actionsSchema.safeParse(envelope.data.actions)
	if (!actions.success) return { ok: false, message: 'each action needs a string `action`' }
	const catalog = actions.data.map(({ action }) => action)
	const roles: AppSchema['roles'] = {}
	for (const [key, defRaw] of Object.entries(envelope.data.roles)) {
		const parsed = roleSchema.safeParse(defRaw)
		if (!parsed.success) {
			return { ok: false, message: `role '${key}' needs a string name and a permissions array` }
		}
		const { name, permissions, description } = parsed.data
		for (const pattern of permissions) {
			if (!isActionAllowed(pattern, catalog)) {
				return { ok: false, message: `role '${key}' references unknown action: ${pattern}` }
			}
		}
		roles[key] = { name, permissions, ...(description !== undefined ? { description } : {}) }
	}

	return { ok: true, schema: { scopes: scopes.data, actions: actions.data, roles } }
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
	const parsed = parseAppSchema(body)
	if (!parsed.ok) {
		return error(400, parsed.message)
	}
	const { schema } = parsed
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
	await c.services.repositories.appSchema.reconcileAppSchema({
		app,
		scopes: schema.scopes.map((s) => ({ scopeType: s.type, label: s.label ?? null })),
		actions: schema.actions.map((a) => ({ action: a.action, description: a.description ?? null })),
		roles: Object.entries(schema.roles).map(([roleKey, def]) => ({
			roleKey,
			name: def.name,
			description: def.description ?? null,
			permissions: def.permissions,
		})),
	})
	await adminAudit(c, {
		action: 'iam.app.schema.reconcile',
		resourceType: 'app',
		resourceId: app,
		metadata: {
			scopes: schema.scopes.length,
			actions: schema.actions.length,
			roles: Object.keys(schema.roles),
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
	return {
		app,
		scopes: scopeRows.map((r) => ({ type: r.scope_type, ...(r.label !== null ? { label: r.label } : {}) })),
		actions: actionRows.map((r) => ({ action: r.action, ...(r.description !== null ? { description: r.description } : {}) })),
		roles,
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

/**
 * Read an app's registered return origins. The registry was writable but never readable, so an
 * operator could only find out what a cross-host sign-in would accept by attempting one (COMP-4).
 */
export async function getReturnOriginsUseCase(c: AdminContext, input: AppInput): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	return { app: input.app, origins: await c.services.repositories.handoff.listReturnOrigins(input.app) }
}

/**
 * Un-register every return origin for an app — an OPERATION, not an empty array.
 *
 * `setReturnOrigins` refuses an empty set (SEC-12) because an empty set is what an app that never
 * registered looks like, and reaching that state by accident strands every cross-host sign-in. But
 * refusing it also left an operator with no way back out through the API at all: clearing was
 * possible only by deleting rows. So clearing is its own named call, which cannot be arrived at by a
 * caller that meant to send one origin and sent none.
 */
export async function clearReturnOriginsUseCase(c: AdminContext, input: AppInput): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	await c.services.repositories.handoff.setReturnOrigins(input.app, [])
	await adminAudit(c, {
		action: 'iam.app.return-origins.clear',
		resourceType: 'app',
		resourceId: input.app,
	})
	return { app: input.app, origins: [] }
}

export async function getAppSchemaUseCase(c: AdminContext, input: AppInput): Promise<AppSchemaDto> {
	const app = input.app
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	return readAppSchemaDto(c, app)
}
