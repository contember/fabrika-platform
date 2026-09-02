import type { AppActionDef, AppSchema, AppScopeDef, RoleDef } from '@fabrika/auth'
import { reconcileSchema } from '@fabrika/auth'
import { isActionAllowed } from '@fabrika/auth-core'
import type { SchemaReconciler } from '@fabrika/provider-contract'

/** Default IAM schema reconciler shared by production Cloudflare sessions. */
export const defaultReconcileSchema: SchemaReconciler = (input) =>
	reconcileSchema({
		url: input.url,
		app: input.app,
		schema: input.schema,
		...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		adminKey: input.adminKey,
		signal: input.signal,
	})

const prop = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined

const nonEmptyString = (value: unknown, key: string): string | undefined => {
	const field = prop(value, key)
	return typeof field === 'string' && field !== '' ? field : undefined
}

/** `null` distinguishes "absent" (ok) from "present but malformed" (rejects the whole schema). */
const optionalString = (value: unknown, key: string): string | null | undefined => {
	const field = prop(value, key)
	if (field === undefined) return undefined
	return typeof field === 'string' && field !== '' ? field : null
}

/** Quote an untrusted fragment for an error message the run log will carry. */
const token = (value: string): string => `\`${value.slice(0, 80)}\``

const parseScope = (value: unknown): AppScopeDef | null => {
	const type = nonEmptyString(value, 'type')
	const label = optionalString(value, 'label')
	if (type === undefined || label === null) return null
	return label === undefined ? { type } : { type, label }
}

const parseAction = (value: unknown): AppActionDef | null => {
	const action = nonEmptyString(value, 'action')
	const description = optionalString(value, 'description')
	if (action === undefined || description === null) return null
	return description === undefined ? { action } : { action, description }
}

const parseRole = (value: unknown): RoleDef | null => {
	const name = nonEmptyString(value, 'name')
	const description = optionalString(value, 'description')
	const permissions = prop(value, 'permissions')
	if (name === undefined || description === null || !Array.isArray(permissions)) return null
	const patterns: string[] = []
	for (const entry of permissions) {
		if (typeof entry !== 'string' || entry === '') return null
		patterns.push(entry)
	}
	return description === undefined ? { name, permissions: patterns } : { name, description, permissions: patterns }
}

/** A parsed vocabulary, or the reason the deploy is refused — the message names the offending field. */
export type AppSchemaParse = { readonly ok: true; readonly schema: AppSchema } | { readonly ok: false; readonly message: string }

/**
 * Narrow an untrusted authz vocabulary — it arrives as JSON text compiled inside the deploy container —
 * to the `AppSchema` the reconcile sends IAM, applying IAM's own rule that every role permission must
 * name an action the same body declares. IAM validates it again on the way in.
 */
export const parseAppSchema = (value: unknown): AppSchemaParse => {
	const rawScopes = prop(value, 'scopes')
	const rawActions = prop(value, 'actions')
	const rawRoles = prop(value, 'roles')
	if (!Array.isArray(rawScopes) || !Array.isArray(rawActions)) {
		return { ok: false, message: 'scopes and actions must be arrays' }
	}
	if (typeof rawRoles !== 'object' || rawRoles === null || Array.isArray(rawRoles)) {
		return { ok: false, message: 'roles must be an object (role_key -> def)' }
	}
	const scopes: AppScopeDef[] = []
	for (const raw of rawScopes) {
		const scope = parseScope(raw)
		if (scope === null) return { ok: false, message: 'each scope needs a string `type` and, when present, a string `label`' }
		scopes.push(scope)
	}
	const actions: AppActionDef[] = []
	const catalog: string[] = []
	for (const raw of rawActions) {
		const action = parseAction(raw)
		if (action === null) return { ok: false, message: 'each action needs a string `action` and, when present, a string `description`' }
		actions.push(action)
		catalog.push(action.action)
	}
	const roles: Record<string, RoleDef> = {}
	for (const [key, raw] of Object.entries(rawRoles)) {
		// `roles[key] = …` would reach the prototype setter, so the key is refused rather than assigned.
		if (key === '' || key === '__proto__') return { ok: false, message: `role key ${token(key)} is not usable` }
		const role = parseRole(raw)
		if (role === null) return { ok: false, message: `role ${token(key)} needs a string name and an array of non-empty permissions` }
		for (const pattern of role.permissions) {
			if (!isActionAllowed(pattern, catalog)) {
				return { ok: false, message: `role ${token(key)} references unknown action: ${token(pattern)}` }
			}
		}
		roles[key] = role
	}
	return { ok: true, schema: { scopes, actions, roles } }
}
