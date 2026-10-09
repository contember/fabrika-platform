import { type AppSchema, BUILTIN_ROLE_KEYS, isActionAllowed } from '@fabrika/auth-core'
import { z } from 'zod'

/** Quote an untrusted fragment for an error message a run log may carry. */
const quote = (value: string): string => `\`${value.slice(0, 80)}\``

// `record[key] = …` would reach the prototype setter, so `__proto__` is refused rather than assigned.
const keySchema = z.string().min(1).refine((key) => key !== '__proto__')

const scopeSchema = z.object({
	type: z.string().min(1),
	label: z.string().min(1).optional(),
	in: z.string().min(1).optional(),
	creator: z.string().min(1).optional(),
	members: z.object({ manage: z.string().min(1), list: z.string().min(1) }).optional(),
})
const actionSchema = z.object({ action: z.string().min(1), description: z.string().min(1).optional() })
const roleSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1).optional(),
	permissions: z.array(z.string().min(1)),
	member: z.object({ scope: z.string().min(1), assignableBy: z.array(z.string().min(1)).optional() }).optional(),
})
/** A link lives at most a year; the mount's `maxDays` is the bound a contract states below that. */
const MAX_LINK_DAYS = 365
const linkSchema = z.object({
	dimension: z.string().min(1),
	grants: z.array(z.string().min(1)).min(1),
	issuedBy: z.string().min(1),
	maxDays: z.number().int().min(1).max(MAX_LINK_DAYS),
})
const delegationSchema = z.object({
	action: z.string().min(1),
	dimension: z.string().min(1),
	purpose: z.enum(['members', 'creates']),
})

/** A job or webhook name of a contract; an `app` workload is named by the consuming application's id. */
const WORKLOAD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const workloadSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.enum(['job', 'webhook']), name: z.string().regex(WORKLOAD_NAME), actions: z.array(z.string().min(1)) }),
	z.object({ kind: z.literal('app'), name: z.string().regex(APP_ID), actions: z.array(z.string().min(1)) }),
])

type Issue = { path: (string | number)[]; message: string }

/** The membership and link declarations IAM acts on. Every name must resolve inside the same body. */
function membershipIssues(schema: z.infer<typeof appSchemaShape>): Issue[] {
	const issues: Issue[] = []
	const catalog = new Set(schema.actions.map((action) => action.action))
	const dimensions = new Map(schema.scopes.map((scope) => [scope.type, scope]))
	const exactAction = (path: (string | number)[], action: string): void => {
		if (!catalog.has(action)) issues.push({ path, message: `${quote(action)} is not an exact action of the catalog` })
	}
	const membershipRoleOf = (key: string, dimension: string): boolean => {
		const role = Object.hasOwn(schema.roles, key) ? schema.roles[key] : undefined
		return role?.member?.scope === dimension
	}

	for (const [index, scope] of schema.scopes.entries()) {
		if (scope.in !== undefined && (scope.in === scope.type || !dimensions.has(scope.in))) {
			issues.push({ path: ['scopes', index, 'in'], message: `scope ${quote(scope.type)} is in an undeclared scope: ${quote(scope.in)}` })
		}
		if (scope.creator !== undefined && !membershipRoleOf(scope.creator, scope.type)) {
			issues.push({
				path: ['scopes', index, 'creator'],
				message: `the creator of scope ${quote(scope.type)} must be a membership role of that scope: ${quote(scope.creator)}`,
			})
		}
		if (scope.members !== undefined) {
			exactAction(['scopes', index, 'members', 'manage'], scope.members.manage)
			exactAction(['scopes', index, 'members', 'list'], scope.members.list)
		}
	}
	for (const scope of schema.scopes) {
		const seen = new Set<string>([scope.type])
		for (let next = scope.in; next !== undefined; next = dimensions.get(next)?.in) {
			if (seen.has(next)) {
				issues.push({ path: ['scopes'], message: `scope ${quote(scope.type)} contains itself` })
				break
			}
			seen.add(next)
		}
	}
	for (const [key, role] of Object.entries(schema.roles)) {
		if (BUILTIN_ROLE_KEYS.includes(key) && (role.member !== undefined || schema.contract === true)) {
			issues.push({
				path: ['roles', key, 'name'],
				message: `role ${quote(key)} is a built-in IAM role; a membership role or a contract application role needs another key`,
			})
		}
		for (const [index, assigner] of (role.member?.assignableBy ?? []).entries()) {
			if (role.member !== undefined && !membershipRoleOf(assigner, role.member.scope)) {
				issues.push({
					path: ['roles', key, 'member', 'assignableBy', index],
					message: `role ${quote(key)} is assignable only by a membership role of its scope, not ${quote(assigner)}`,
				})
			}
		}
	}
	for (const [mount, link] of Object.entries(schema.links ?? {})) {
		if (!dimensions.has(link.dimension)) {
			issues.push({ path: ['links', mount, 'dimension'], message: `link mount ${quote(mount)} names an undeclared scope: ${quote(link.dimension)}` })
		}
		for (const [index, grant] of link.grants.entries()) exactAction(['links', mount, 'grants', index], grant)
		exactAction(['links', mount, 'issuedBy'], link.issuedBy)
	}
	const workloads = new Set<string>()
	for (const [index, workload] of (schema.workloads ?? []).entries()) {
		if (schema.contract !== true) {
			issues.push({ path: ['workloads', index, 'kind'], message: 'only a contract application declares workloads' })
		}
		const key = `${workload.kind}:${workload.name}`
		if (workloads.has(key)) issues.push({ path: ['workloads', index, 'name'], message: `workload ${quote(key)} is declared twice` })
		workloads.add(key)
		for (const [position, action] of workload.actions.entries()) exactAction(['workloads', index, 'actions', position], action)
	}
	for (const [endpoint, delegation] of Object.entries(schema.delegations ?? {})) {
		const dimension = dimensions.get(delegation.dimension)
		exactAction(['delegations', endpoint, 'action'], delegation.action)
		if (dimension === undefined) {
			issues.push({
				path: ['delegations', endpoint, 'dimension'],
				message: `endpoint ${quote(endpoint)} names an undeclared scope: ${quote(delegation.dimension)}`,
			})
		} else if (delegation.purpose === 'members' && dimension.members?.manage !== delegation.action) {
			issues.push({
				path: ['delegations', endpoint, 'action'],
				message: `endpoint ${quote(endpoint)} manages members only with the members.manage action of ${quote(delegation.dimension)}`,
			})
		} else if (delegation.purpose === 'creates' && (dimension.creator === undefined || dimension.in !== undefined)) {
			issues.push({
				path: ['delegations', endpoint, 'dimension'],
				message: `endpoint ${quote(endpoint)} creates ${quote(delegation.dimension)}, which needs a creator role and no containing scope`,
			})
		}
	}
	return issues
}

const appSchemaShape = z.object({
	scopes: z.array(scopeSchema),
	actions: z.array(actionSchema),
	roles: z.record(keySchema, roleSchema),
	contract: z.boolean().optional(),
	links: z.record(keySchema, linkSchema).optional(),
	delegations: z.record(keySchema, delegationSchema).optional(),
	workloads: z.array(workloadSchema).optional(),
})

/**
 * An app's authz vocabulary, as an app declares it and IAM reconciles it. Every role permission must
 * name an action the same body declares — IAM's own rule, checked wherever the vocabulary is read. A
 * contract application's roles list exact actions, and a membership role names a declared scope. The
 * membership and link declarations name only scopes, roles and exact actions of the same body.
 */
export const appSchemaSchema = appSchemaShape.superRefine((schema, ctx) => {
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
	for (const issue of membershipIssues(schema)) {
		ctx.addIssue({ code: 'custom', ...issue })
	}
}) satisfies z.ZodType<AppSchema, z.ZodTypeDef, unknown>
