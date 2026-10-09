import { canonicalJson } from './contract-canonical'
import { sha256Hex } from './sha256'
import type { AppGates, AppSchema, GateRule, RoleDef } from './types'

/**
 * The access of an application without a contract (ADR-0050): the gates its proxy enforces and the IAM schema it
 * reconciles. On a protected environment Control approves it like a contract: by its digest, against the last one
 * a human or an unprotected deploy approved.
 */
export interface ArtifactAccess {
	readonly gates: AppGates | null
	readonly schema: AppSchema | null
}

/** A catalog or a set of the access names one identifier twice; which entry applies would depend on order. */
export class DuplicateAccessIdentifierError extends Error {
	constructor(readonly list: string) {
		super(`the artifact access names one identifier twice in its ${list}`)
		this.name = 'DuplicateAccessIdentifierError'
	}
}

/**
 * The access with every list whose order carries no meaning sorted: catalogs by identifier, sets by value. Gate rules
 * keep their order, which is precedence. Throws `DuplicateAccessIdentifierError` before sorting a list with a repeat.
 */
export function canonicalArtifactAccess(access: ArtifactAccess): ArtifactAccess {
	return {
		gates: access.gates === null ? null : { ...access.gates, rules: access.gates.rules.map(canonicalGateRule) },
		schema: access.schema === null ? null : canonicalSchema(access.schema),
	}
}

/** The digest an approval of artifact access names, over `canonicalArtifactAccess`. */
export function artifactAccessDigest(access: ArtifactAccess): string {
	const canonical = canonicalArtifactAccess(access)
	return `sha256:${sha256Hex(canonicalJson({ gates: canonical.gates, schema: canonical.schema }))}`
}

function canonicalGateRule(rule: GateRule): GateRule {
	return rule.kind === 'oauth' ? { ...rule, scopes: sortedSet('OAuth gate scopes', rule.scopes) } : rule
}

function canonicalSchema(schema: AppSchema): AppSchema {
	const { links, ...rest } = schema
	return {
		...rest,
		scopes: sortedCatalog('IAM scopes', schema.scopes, (scope) => scope.type),
		actions: sortedCatalog('IAM actions', schema.actions, (action) => action.action),
		roles: Object.fromEntries(Object.entries(schema.roles).map(([key, role]) => [key, canonicalRole(role)])),
		...(links === undefined
			? {}
			: { links: Object.fromEntries(Object.entries(links).map(([key, link]) => [key, { ...link, grants: sortedSet('link grants', link.grants) }])) }),
	}
}

function canonicalRole(role: RoleDef): RoleDef {
	const { member, ...rest } = role
	const permissions = sortedSet('role permissions', role.permissions)
	if (member === undefined) return { ...rest, permissions }
	const { assignableBy, ...scope } = member
	return {
		...rest,
		permissions,
		member: assignableBy === undefined ? scope : { ...scope, assignableBy: sortedSet('role assigners', assignableBy) },
	}
}

function sortedSet(list: string, values: readonly string[]): string[] {
	return sortedCatalog(list, values, (value) => value)
}

function sortedCatalog<T>(list: string, entries: readonly T[], identifier: (entry: T) => string): T[] {
	const keyed = entries.map((entry) => ({ id: identifier(entry), entry }))
	if (new Set(keyed.map(({ id }) => id)).size !== keyed.length) throw new DuplicateAccessIdentifierError(list)
	return keyed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ entry }) => entry)
}
