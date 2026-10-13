import type { AppSchemaRepository } from './repositories/app-schema'
import type { PrincipalRow } from './repositories/principals'
import { BUILTIN_ROLES } from './roles'
import { parseStoredPermissions } from './stored-permissions'

// ADR-0022 rule 6: what IAM refuses to write, on every write path. A CONTRACT application (its schema
// carried `contract: true`) lists exact actions; any other app keeps the pattern rule of policies and grants.

type ContractSchema = Pick<AppSchemaRepository, 'isContractApp' | 'getRole'>

/** The first wildcard among `patterns`, or undefined. */
function firstWildcard(patterns: readonly string[]): string | undefined {
	return patterns.find((pattern) => pattern.includes('*'))
}

/** Why these action patterns may not be written for `app`, or null. */
export async function contractPatternsProblem(appSchema: ContractSchema, app: string, patterns: readonly string[]): Promise<string | null> {
	const wildcard = firstWildcard(patterns)
	if (wildcard === undefined || !(await appSchema.isContractApp(app))) {
		return null
	}
	return `a contract application lists exact actions, not the wildcard: ${wildcard}`
}

/**
 * Why this grant may not be written at `app`, or null. A membership role is granted only in a value of its
 * own scope dimension, never globally. For a contract application a grant also carries no wildcard,
 * inline or through its role, the built-in `admin` included. A cross-app grant (`app` null) is not
 * checked: it never reaches an application token.
 */
export async function contractGrantProblem(
	appSchema: ContractSchema,
	app: string | null,
	grant: { roleKey: string | null; permissions: readonly string[] | null; scopeType: string | null },
): Promise<string | null> {
	if (app === null) {
		return null
	}
	const role = grant.roleKey === null || Object.hasOwn(BUILTIN_ROLES, grant.roleKey) ? null : await appSchema.getRole(app, grant.roleKey)
	if (role !== null && role.member_scope !== null && grant.scopeType !== role.member_scope) {
		return `membership role '${role.role_key}' is granted only in a value of scope '${role.member_scope}'`
	}
	if (!(await appSchema.isContractApp(app))) {
		return null
	}
	if (grant.roleKey === null) {
		const wildcard = firstWildcard(grant.permissions ?? [])
		return wildcard === undefined ? null : `a contract application lists exact actions, not the wildcard: ${wildcard}`
	}
	const permissions = role === null ? BUILTIN_ROLES[grant.roleKey]?.permissions ?? [] : parseStoredPermissions(role.permissions)
	const wildcard = firstWildcard(permissions)
	return wildcard === undefined ? null : `role '${grant.roleKey}' lists the wildcard ${wildcard} and cannot be granted in a contract application`
}

/**
 * Why `principal` may not hold this grant, or null (ADR-0051). An external principal holds only a role of one
 * application that the role's schema declares external: no inline permissions, no cross-app grant, no built-in role and
 * no custom policy. The write carries the same condition (`ELIGIBLE_GRANT_SQL`); this check names the reason first.
 */
export async function externalGrantProblem(
	appSchema: Pick<AppSchemaRepository, 'getRole'>,
	principal: Pick<PrincipalRow, 'affiliation'>,
	app: string | null,
	grant: { roleKey: string | null },
): Promise<string | null> {
	if (principal.affiliation !== 'external') {
		return null
	}
	if (app === null) {
		return 'an external principal holds no cross-app grant'
	}
	if (grant.roleKey === null) {
		return 'an external principal holds no inline permissions, only a role its application declares external'
	}
	const role = Object.hasOwn(BUILTIN_ROLES, grant.roleKey) ? null : await appSchema.getRole(app, grant.roleKey)
	if (role === null || role.external !== 1) {
		return `an external principal holds only a role its application declares external, and '${grant.roleKey}' is not one`
	}
	return null
}
