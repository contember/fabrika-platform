// The part of a deploy's approved IAM schema that only narrows what the running version's schema grants (backlog 226).
// Control writes it before anything publishes the new version, so a narrowing IAM refuses stops the deploy while the old
// version still serves; the whole schema, widenings included, follows once the version is live (`applyApprovedSchema`).

import { appSchemaSchema } from '@fabrika/auth'
import type { AppSchema, AppScopeDef, AppWorkloadDef, RoleDef } from '@fabrika/auth-core'

/**
 * `none`: the new schema narrows nothing the ahead write may take away. `narrowing`: the running schema with those
 * removals applied. `inexpressible`: they do not form a schema IAM accepts on their own, so they reach IAM with the whole
 * schema after the publish, as before.
 */
export type Narrowing =
	| { readonly kind: 'none' }
	| { readonly kind: 'narrowing'; readonly schema: AppSchema }
	| { readonly kind: 'inexpressible' }

/**
 * `before` with what `after` takes away from roles and actions, and nothing added: a role, a role's action or relation,
 * its assigners and external flag, a workload's action, a creator role, a lookup, a directory, a shorter link lifetime,
 * and every action nothing kept still names. A field `after` changes rather than removes keeps `before`'s value, as
 * anything the comparison cannot show to narrow counts as a widening.
 *
 * Every workload, link mount, delegation, member declaration and terminal page of `before` stays, whatever `after` says:
 * IAM revokes a dropped workload's or mount's keys and deletes the membership transport key with the last of them, which
 * no later write restores, so a deploy that fails after this write would leave the running version without them. Each of
 * them grants only actions the roles and keys carry, so the window until the whole write is the one before this change.
 */
export function narrowingOf(before: AppSchema, after: AppSchema): Narrowing {
	const roles: Record<string, RoleDef> = {}
	for (const [key, role] of Object.entries(before.roles)) {
		const next = Object.hasOwn(after.roles, key) ? after.roles[key] : undefined
		if (next !== undefined) roles[key] = narrowRole(role, next)
	}
	const workloads = before.workloads?.map((workload) => narrowWorkload(workload, after.workloads ?? []))
	const scopes = before.scopes.map((scope) =>
		narrowScope(scope, after.scopes.find((candidate) => candidate.type === scope.type) ?? { type: scope.type }, roles)
	)
	const links = before.links === undefined ? undefined : Object.fromEntries(
		Object.entries(before.links).map(([mount, link]) => {
			const next = after.links !== undefined && Object.hasOwn(after.links, mount) ? after.links[mount] : undefined
			return [mount, next === undefined ? link : { ...link, maxDays: Math.min(link.maxDays, next.maxDays) }]
		}),
	)

	// An action stays while the new schema declares it, or while something kept from the running one still names it.
	const named = new Set(after.actions.map((action) => action.action))
	const keep = (action: string | undefined): void => {
		if (action !== undefined) named.add(action)
	}
	for (const link of Object.values(links ?? {})) {
		keep(link.issuedBy)
		link.grants.forEach(keep)
	}
	for (const delegation of Object.values(before.delegations ?? {})) keep(delegation.action)
	for (const workload of workloads ?? []) workload.actions.forEach(keep)
	for (const scope of scopes) {
		keep(scope.members?.manage)
		keep(scope.members?.list)
		keep(scope.valueSource?.action)
	}
	keep(before.members?.manage)
	keep(before.members?.list)

	const narrowed: AppSchema = {
		...before,
		scopes,
		actions: before.actions.filter((action) => named.has(action.action)),
		roles,
		...(links === undefined ? {} : { links }),
		...(workloads === undefined ? {} : { workloads }),
	}
	if (before.directory !== undefined && after.directory === undefined) delete narrowed.directory
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
		...(role.member === undefined ? {} : { member: { scope: role.member.scope, ...(assignableBy === undefined ? {} : { assignableBy }) } }),
		...(role.external === true && next.external === true ? { external: true } : {}),
		...(role.via === undefined ? {} : { via }),
	}
}

/** A workload `after` still declares keeps the actions both name; one whose actions all change keeps its own. */
function narrowWorkload(workload: AppWorkloadDef, after: readonly AppWorkloadDef[]): AppWorkloadDef {
	const next = after.find((candidate) => candidate.kind === workload.kind && candidate.name === workload.name)
	const actions = next === undefined ? [] : intersect(workload.actions, next.actions)
	return actions.length === 0 ? workload : { ...workload, actions }
}

function narrowScope(scope: AppScopeDef, next: AppScopeDef, roles: Readonly<Record<string, RoleDef>>): AppScopeDef {
	const narrowed: AppScopeDef = { ...scope }
	if (scope.creator !== undefined && (next.creator === undefined || !Object.hasOwn(roles, scope.creator))) delete narrowed.creator
	const lookups = intersect(scope.lookups ?? [], next.lookups ?? [])
	if (lookups.length === 0) delete narrowed.lookups
	else if (scope.lookups !== undefined) narrowed.lookups = lookups
	if (scope.directory !== undefined && next.directory === undefined) delete narrowed.directory
	return narrowed
}

const intersect = (values: readonly string[], kept: readonly string[]): string[] => values.filter((value) => kept.includes(value))

/** JSON with object keys sorted, so two schemas built in a different key order compare equal. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
		return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	})
}
