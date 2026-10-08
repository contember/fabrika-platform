import { isActionAllowed, type RoleDef } from '@fabrika/auth-core'
import { type CreateGrantRequest, type GrantDto } from '@fabrika/iam-contract'
import { type GrantRow, type RoleRow } from '../db'
import { BUILTIN_ROLES, isKnownRole } from '../roles'
import { type Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { type AdminContext } from './context'

/** Parse a `roles` row's JSON permissions into a string array (fail-closed on junk, incl. unparseable text). */
export function rolePermissions(json: string): string[] {
	return parseStoredPermissions(json)
}

/**
 * Loads (and memoizes) an app's role_key set on demand so DTO mappers can flag
 * dangling role grants without re-querying per row. A grant/mapping with `app = null`
 * (cross-app) is checked against the built-ins only — there is no per-app row set.
 */
export class RoleKnownCache {
	private readonly perApp = new Map<string, Set<string>>()

	constructor(private readonly services: Services) {}

	private async appRoleKeys(app: string): Promise<Set<string>> {
		const cached = this.perApp.get(app)
		if (cached) {
			return cached
		}
		const rows = await this.services.repositories.appSchema.listRoles(app)
		const keys = new Set(rows.map((r) => r.role_key))
		this.perApp.set(app, keys)
		return keys
	}

	/** True iff `roleKey` resolves for `app` — a built-in, or a row in the app's roles. */
	async isKnown(roleKey: string, app: string | null): Promise<boolean> {
		if (Object.hasOwn(BUILTIN_ROLES, roleKey)) {
			return true
		}
		if (app === null) {
			return false
		}
		return (await this.appRoleKeys(app)).has(roleKey)
	}
}

export async function toGrantDto(row: GrantRow, roleCache: RoleKnownCache): Promise<GrantDto> {
	const dangling = row.role_key !== null && !(await roleCache.isKnown(row.role_key, row.app))
	return {
		id: row.id,
		principalId: row.principal_id,
		roleKey: row.role_key,
		permissions: row.permissions === null ? null : rolePermissions(row.permissions),
		scopeType: row.scope_type,
		scopeValue: row.scope_value,
		app: row.app,
		grantedBy: row.granted_by,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		dangling,
	}
}

/** Map a list of grant rows to DTOs sharing one role-known cache (one query per app). */
export async function toGrantDtos(rows: GrantRow[], services: Services, cache: RoleKnownCache = new RoleKnownCache(services)): Promise<GrantDto[]> {
	const out: GrantDto[] = []
	for (const row of rows) {
		out.push(await toGrantDto(row, cache))
	}
	return out
}

/** The set of app ids propustka knows about — the live registry derived from the schema tables. */
export function knownApps(c: AdminContext): Promise<string[]> {
	return c.services.repositories.appSchema.listKnownApps()
}

/** Validate an admin-supplied `app`: null (all apps) or a known (registered) app. */
export async function appField(c: AdminContext, body: Pick<CreateGrantRequest, 'app'>): Promise<{ ok: true; app: string | null } | { ok: false }> {
	const app = body.app ?? null
	if (app !== null && !(await knownApps(c)).includes(app)) {
		return { ok: false }
	}
	return { ok: true, app }
}

/** A `roles` row → core `RoleDef` for resolution. */
export function dbRoleToDef(row: RoleRow): RoleDef {
	return {
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		permissions: rolePermissions(row.permissions),
		...(row.member_scope !== null ? { member: { scope: row.member_scope } } : {}),
	}
}

/** Load an app's DB roles into a role_key -> RoleDef map (empty for app=null). */
async function loadAppRoleMap(c: AdminContext, app: string | null): Promise<Record<string, RoleDef>> {
	const map: Record<string, RoleDef> = {}
	if (app !== null) {
		for (const row of await c.services.repositories.appSchema.listRoles(app)) {
			map[row.role_key] = dbRoleToDef(row)
		}
	}
	return map
}

/**
 * Validate the scope coordinate on a grant/key request: `scopeType`/`scopeValue` are
 * both-or-neither (both null = global). A half-set pair is a 400.
 */
export function parseScope(
	body: Pick<CreateGrantRequest, 'scopeType' | 'scopeValue'>,
): { ok: true; scopeType: string | null; scopeValue: string | null } | { ok: false } {
	const scopeType = body.scopeType ?? null
	const scopeValue = body.scopeValue ?? null
	if ((scopeType === null) !== (scopeValue === null)) {
		return { ok: false }
	}
	return { ok: true, scopeType, scopeValue }
}

/**
 * Validate the role-or-inline choice for a grant/key against the app: EXACTLY one of
 * `roleKey` / `permissions`. A `roleKey` must be a known role for the app (built-in
 * `admin` OR a `roles` row). Inline `permissions` must each be a pattern the relevant
 * action catalog knows. Returns a normalized result or an error message for a 400.
 */
export async function parseRoleOrInline(
	c: AdminContext,
	body: Pick<CreateGrantRequest, 'roleKey' | 'permissions'>,
	app: string | null,
): Promise<{ ok: true; roleKey: string | null; permissions: string[] | null } | { ok: false; message: string }> {
	const { roleKey, permissions } = body
	if ((roleKey === undefined) === (permissions === undefined)) {
		return { ok: false, message: 'exactly one of roleKey or permissions is required' }
	}
	if (roleKey !== undefined) {
		if (!isKnownRole(roleKey, await loadAppRoleMap(c, app))) {
			return { ok: false, message: `unknown role: ${roleKey}` }
		}
		return { ok: true, roleKey, permissions: null }
	}
	// Inline permissions: validate each pattern against the app's action catalog.
	if (permissions === undefined || permissions.length === 0) {
		return { ok: false, message: 'permissions must be a non-empty array of action patterns' }
	}
	const catalog = await actionCatalog(c, app)
	for (const pattern of permissions) {
		if (!isActionAllowed(pattern, catalog)) {
			return {
				ok: false,
				message: app === null
					? `no registered app declares the action pattern '${pattern}'. This check catches typos, it is not a security boundary — `
						+ 'a cross-app grant is matched by pattern at request time, so it also covers an app registered later.'
					: `unknown action pattern: ${pattern}`,
			}
		}
	}
	return { ok: true, roleKey: null, permissions }
}

/**
 * The catalog an inline pattern is validated against: one app's actions, or — for a CROSS-APP grant —
 * the union of every registered app's catalog.
 *
 * A cross-app grant has no single catalog, and the previous code substituted an empty one, which made
 * `isActionAllowed` refuse everything except `*`. That inverted least privilege: an operator who
 * wanted `deploy.read` everywhere had to grant everything instead (CORR-10). The union is the right
 * comparison and it is honest about what it is — a TYPO CHECK, not a boundary. `permits()` matches
 * patterns at request time and never pre-expands them, so an app registered tomorrow is covered by a
 * cross-app grant written today whatever this function said.
 */
async function actionCatalog(c: AdminContext, app: string | null): Promise<string[]> {
	if (app !== null) {
		return c.services.repositories.appSchema.listActionCatalog(app)
	}
	const catalog = new Set<string>()
	for (const known of await knownApps(c)) {
		for (const action of await c.services.repositories.appSchema.listActionCatalog(known)) {
			catalog.add(action)
		}
	}
	return [...catalog]
}
