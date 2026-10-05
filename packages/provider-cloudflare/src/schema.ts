import type { AppSchema, RoleDef } from '@fabrika/auth'
import { reconcileSchema } from '@fabrika/auth'
import { isActionAllowed } from '@fabrika/auth-core'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { z } from 'zod'

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

/** Quote an untrusted fragment for an error message the run log will carry. */
const token = (value: string): string => `\`${value.slice(0, 80)}\``

const scopeSchema = z.preprocess(
	(value) => ({ type: prop(value, 'type'), label: prop(value, 'label') }),
	z.object({ type: z.string().min(1), label: z.string().min(1).optional() })
		.transform(({ type, label }) => label === undefined ? { type } : { type, label }),
)
const actionSchema = z.preprocess(
	(value) => ({ action: prop(value, 'action'), description: prop(value, 'description') }),
	z.object({ action: z.string().min(1), description: z.string().min(1).optional() })
		.transform(({ action, description }) => description === undefined ? { action } : { action, description }),
)
const roleSchema = z.preprocess(
	(value) => ({ name: prop(value, 'name'), description: prop(value, 'description'), permissions: prop(value, 'permissions') }),
	z.object({ name: z.string().min(1), description: z.string().min(1).optional(), permissions: z.array(z.string().min(1)) })
		.transform(({ name, description, permissions }) => description === undefined ? { name, permissions } : { name, description, permissions }),
)
const vocabularySchema = z.object({
	scopes: z.array(z.unknown()),
	actions: z.array(z.unknown()),
	roles: z.preprocess(
		(value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : undefined,
		z.array(z.tuple([z.string(), z.unknown()])),
	),
})
const scopesSchema = z.array(scopeSchema)
const actionsSchema = z.array(actionSchema)

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
	const vocabulary = vocabularySchema.safeParse({ scopes: rawScopes, actions: rawActions, roles: rawRoles })
	if (!vocabulary.success) {
		return {
			ok: false,
			message: vocabulary.error.issues.some((issue) => issue.path[0] !== 'roles')
				? 'scopes and actions must be arrays'
				: 'roles must be an object (role_key -> def)',
		}
	}
	const scopes = scopesSchema.safeParse(vocabulary.data.scopes)
	if (!scopes.success) return { ok: false, message: 'each scope needs a string `type` and, when present, a string `label`' }
	const actions = actionsSchema.safeParse(vocabulary.data.actions)
	if (!actions.success) return { ok: false, message: 'each action needs a string `action` and, when present, a string `description`' }
	const catalog = actions.data.map((action) => action.action)
	const roles: Record<string, RoleDef> = {}
	for (const [key, raw] of vocabulary.data.roles) {
		// `roles[key] = …` would reach the prototype setter, so the key is refused rather than assigned.
		if (key === '' || key === '__proto__') return { ok: false, message: `role key ${token(key)} is not usable` }
		const role = roleSchema.safeParse(raw)
		if (!role.success) return { ok: false, message: `role ${token(key)} needs a string name and an array of non-empty permissions` }
		for (const pattern of role.data.permissions) {
			if (!isActionAllowed(pattern, catalog)) {
				return { ok: false, message: `role ${token(key)} references unknown action: ${token(pattern)}` }
			}
		}
		roles[key] = role.data
	}
	return { ok: true, schema: { scopes: scopes.data, actions: actions.data, roles } }
}
