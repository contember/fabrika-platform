import type { AppSchema } from '@fabrika/auth'
import { appSchemaSchema, reconcileSchema } from '@fabrika/auth'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import type { z } from 'zod'

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

/** Quote an untrusted fragment for an error message the run log will carry. */
const token = (value: string): string => `\`${value.slice(0, 80)}\``

/** A parsed vocabulary, or the reason the deploy is refused — the message names the offending field. */
export type AppSchemaParse = { readonly ok: true; readonly schema: AppSchema } | { readonly ok: false; readonly message: string }

const refusalMessage = (issues: readonly z.ZodIssue[]): string => {
	// A wrong envelope is the more useful report than the first bad element inside it.
	const issue = issues.find((candidate) => candidate.path.length === 1) ?? issues[0]
	const [field, key] = issue?.path ?? []
	if (field === 'roles') {
		if (typeof key !== 'string') return 'roles must be an object (role_key -> def)'
		if (key === '' || key === '__proto__') return `role ${token(key)} is not usable`
		if (issue?.code === 'custom') return issue.message
		return `role ${token(key)} needs a non-empty name and an array of non-empty permissions`
	}
	if (key === undefined) return 'scopes and actions must be arrays'
	return field === 'scopes'
		? 'each scope needs a non-empty `type` and, when present, a non-empty `label`'
		: 'each action needs a non-empty `action` and, when present, a non-empty `description`'
}

/**
 * Narrow an untrusted authz vocabulary — it arrives as JSON text compiled inside the deploy container —
 * to the `AppSchema` the reconcile sends IAM. IAM validates it again on the way in.
 */
export const parseAppSchema = (value: unknown): AppSchemaParse => {
	const parsed = appSchemaSchema.safeParse(value)
	return parsed.success ? { ok: true, schema: parsed.data } : { ok: false, message: refusalMessage(parsed.error.issues) }
}
