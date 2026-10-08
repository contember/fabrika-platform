import { type AppSchema, isActionAllowed } from '@fabrika/auth-core'
import { z } from 'zod'

/** Quote an untrusted fragment for an error message a run log may carry. */
const quote = (value: string): string => `\`${value.slice(0, 80)}\``

const scopeSchema = z.object({ type: z.string().min(1), label: z.string().min(1).optional() })
const actionSchema = z.object({ action: z.string().min(1), description: z.string().min(1).optional() })
const roleSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1).optional(),
	permissions: z.array(z.string().min(1)),
	member: z.object({ scope: z.string().min(1) }).optional(),
})
// `roles[key] = …` would reach the prototype setter, so `__proto__` is refused rather than assigned.
const roleKeySchema = z.string().min(1).refine((key) => key !== '__proto__')

/**
 * An app's authz vocabulary, as an app declares it and IAM reconciles it. Every role permission must
 * name an action the same body declares — IAM's own rule, checked wherever the vocabulary is read. A
 * contract application's roles list exact actions, and a membership role names a declared scope.
 */
export const appSchemaSchema = z.object({
	scopes: z.array(scopeSchema),
	actions: z.array(actionSchema),
	roles: z.record(roleKeySchema, roleSchema),
	contract: z.boolean().optional(),
}).superRefine((schema, ctx) => {
	const catalog = schema.actions.map((action) => action.action)
	const scopes = schema.scopes.map((scope) => scope.type)
	for (const [key, role] of Object.entries(schema.roles)) {
		for (const [index, pattern] of role.permissions.entries()) {
			if (!isActionAllowed(pattern, catalog)) {
				ctx.addIssue({
					code: 'custom',
					path: ['roles', key, 'permissions', index],
					message: `role ${quote(key)} references unknown action: ${quote(pattern)}`,
				})
			} else if (schema.contract === true && pattern.includes('*')) {
				ctx.addIssue({
					code: 'custom',
					path: ['roles', key, 'permissions', index],
					message: `role ${quote(key)} of a contract application lists the wildcard ${quote(pattern)}; list exact actions`,
				})
			}
		}
		if (role.member !== undefined && !scopes.includes(role.member.scope)) {
			ctx.addIssue({
				code: 'custom',
				path: ['roles', key, 'member', 'scope'],
				message: `membership role ${quote(key)} names an undeclared scope: ${quote(role.member.scope)}`,
			})
		}
	}
}) satisfies z.ZodType<AppSchema, z.ZodTypeDef, unknown>
