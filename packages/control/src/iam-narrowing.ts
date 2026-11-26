// The part of a deploy's approved IAM schema that only narrows what the running version's schema grants (backlog 226).
// Control writes it before anything publishes the new version, so a narrowing IAM refuses stops the deploy while the old
// version still serves; the whole schema, widenings included, follows once the version is live (`applyApprovedSchema`).

import { appSchemaSchema } from '@fabrika/auth'
import type { AppDelegationDef, AppLinkMountDef, AppSchema, AppScopeDef, AppWorkloadDef, RoleDef } from '@fabrika/auth-core'

/**
 * `none`: the new schema removes nothing the running one grants. `narrowing`: the running schema with only the new
 * schema's removals applied. `inexpressible`: those removals alone do not form a schema IAM accepts, so they reach IAM
 * with the whole schema after the publish, as before.
 */
export type Narrowing =
	| { readonly kind: 'none' }
	| { readonly kind: 'narrowing'; readonly schema: AppSchema }
	| { readonly kind: 'inexpressible' }

/**
 * `before` with what `after` removes taken away, and nothing added: a role, an action, a role's action or relation, a
 * link mount or one of its grants, a delegation, a workload or one of its actions, member management, a creator role, a
 * lookup, a directory, the external flag of a role and the terminal page. A field `after` changes rather than removes keeps
 * `before`'s value, as anything the comparison cannot show to narrow counts as a widening. Presentation (names, locale,
 * mail) stays `before`'s.
 */
export function narrowingOf(before: AppSchema, after: AppSchema): Narrowing {
	const afterActions = new Set(after.actions.map((action) => action.action))
	const actions = before.actions.filter((action) => afterActions.has(action.action))
	const catalog = new Set(actions.map((action) => action.action))
	const inCatalog = (action: string): boolean => catalog.has(action)

	const roles: Record<string, RoleDef> = {}
	for (const [key, role] of Object.entries(before.roles)) {
		const next = Object.hasOwn(after.roles, key) ? after.roles[key] : undefined
		if (next === undefined) continue
		roles[key] = narrowRole(role, next)
	}
	const links: Record<string, AppLinkMountDef> = {}
	for (const [mount, link] of Object.entries(before.links ?? {})) {
		const next = after.links !== undefined && Object.hasOwn(after.links, mount) ? after.links[mount] : undefined
		if (next === undefined || next.dimension !== link.dimension || !inCatalog(link.issuedBy)) continue
		const grants = intersect(link.grants, next.grants)
		if (grants.length === 0) continue
		links[mount] = { dimension: link.dimension, grants, issuedBy: link.issuedBy, maxDays: Math.min(link.maxDays, next.maxDays) }
	}
	const delegations: Record<string, AppDelegationDef> = {}
	for (const [endpoint, delegation] of Object.entries(before.delegations ?? {})) {
		const kept = after.delegations !== undefined && Object.hasOwn(after.delegations, endpoint)
		if (kept && inCatalog(delegation.action)) delegations[endpoint] = delegation
	}
	const workloads: AppWorkloadDef[] = []
	for (const workload of before.workloads ?? []) {
		const next = (after.workloads ?? []).find((candidate) => candidate.kind === workload.kind && candidate.name === workload.name)
		if (next === undefined) continue
		const issues = workload.issues !== undefined && next.issues === workload.issues && Object.hasOwn(links, workload.issues)
			? workload.issues
			: undefined
		workloads.push({
			kind: workload.kind,
			name: workload.name,
			actions: intersect(workload.actions, next.actions),
			...(issues === undefined ? {} : { issues }),
		})
	}
	const scopes = before.scopes.map((scope) =>
		narrowScope(scope, after.scopes.find((candidate) => candidate.type === scope.type) ?? { type: scope.type }, inCatalog, roles)
	)
	const members = keptMembers(before.members, after.members, inCatalog)

	const narrowed: AppSchema = {
		scopes,
		actions,
		roles,
		...(before.contract === undefined ? {} : { contract: before.contract }),
		...(before.links === undefined ? {} : { links }),
		...(before.delegations === undefined ? {} : { delegations }),
		...(before.workloads === undefined ? {} : { workloads }),
		...(before.locale === undefined ? {} : { locale: before.locale }),
		...(before.displayName === undefined ? {} : { displayName: before.displayName }),
		...(before.mail === undefined ? {} : { mail: before.mail }),
		...(members === undefined ? {} : { members }),
		...(members !== undefined && before.directory !== undefined && after.directory !== undefined ? { directory: before.directory } : {}),
		...(before.terminal !== undefined && after.terminal !== undefined ? { terminal: before.terminal } : {}),
	}
	if (canonicalJson(narrowed) === canonicalJson(before)) return { kind: 'none' }
	return appSchemaSchema.safeParse(narrowed).success ? { kind: 'narrowing', schema: narrowed } : { kind: 'inexpressible' }
}

function narrowRole(role: RoleDef, next: RoleDef): RoleDef {
	const via: Record<string, string[]> = {}
	for (const [relation, actions] of Object.entries(role.via ?? {})) {
		const kept = intersect(actions, next.via !== undefined && Object.hasOwn(next.via, relation) ? next.via[relation] ?? [] : [])
		if (kept.length > 0) via[relation] = kept
	}
	const assignableBy = role.member?.assignableBy === undefined ? undefined : intersect(role.member.assignableBy, next.member?.assignableBy ?? [])
	return {
		name: role.name,
		...(role.description === undefined ? {} : { description: role.description }),
		permissions: intersect(role.permissions, next.permissions),
		...(role.member === undefined
			? {}
			: { member: { scope: role.member.scope, ...(assignableBy === undefined || assignableBy.length === 0 ? {} : { assignableBy }) } }),
		...(role.external === true && next.external === true ? { external: true } : {}),
		...(Object.keys(via).length === 0 ? {} : { via }),
	}
}

function narrowScope(
	scope: AppScopeDef,
	next: AppScopeDef,
	inCatalog: (action: string) => boolean,
	roles: Readonly<Record<string, RoleDef>>,
): AppScopeDef {
	const members = keptMembers(scope.members, next.members, inCatalog)
	const lookups = scope.lookups === undefined ? [] : intersect(scope.lookups, next.lookups ?? []).filter(inCatalog)
	const creator = scope.creator !== undefined && next.creator !== undefined && Object.hasOwn(roles, scope.creator) ? scope.creator : undefined
	return {
		type: scope.type,
		...(scope.label === undefined ? {} : { label: scope.label }),
		...(scope.in === undefined ? {} : { in: scope.in }),
		...(creator === undefined ? {} : { creator }),
		...(members === undefined ? {} : { members }),
		...(members !== undefined && scope.directory !== undefined && next.directory !== undefined ? { directory: scope.directory } : {}),
		...(lookups.length === 0 ? {} : { lookups }),
		...(scope.values === undefined ? {} : { values: scope.values }),
		...(scope.valueSource === undefined || !inCatalog(scope.valueSource.action) ? {} : { valueSource: scope.valueSource }),
	}
}

/** Member management stays while the new schema still declares it and its actions stay in the catalog. */
function keptMembers(
	members: { manage: string; list: string } | undefined,
	next: { manage: string; list: string } | undefined,
	inCatalog: (action: string) => boolean,
): { manage: string; list: string } | undefined {
	if (members === undefined || next === undefined || !inCatalog(members.manage) || !inCatalog(members.list)) return undefined
	return { manage: members.manage, list: members.list }
}

const intersect = (values: readonly string[], kept: readonly string[]): string[] => values.filter((value) => kept.includes(value))

/** JSON with object keys sorted, so two schemas built in a different key order compare equal. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
		return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	})
}
