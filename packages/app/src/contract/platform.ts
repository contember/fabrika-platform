// What a contract compiles to for today's proxy and IAM (ADR-0012 §4): the gates `fabrika.config.ts` hands its
// provider, and the IAM vocabulary the deploy reconciles. B2 replaces the gates with the endpoint table itself.

import {
	type AppDelegationDef,
	type AppGates,
	type AppLinkMountDef,
	type AppSchema,
	type AppScopeDef,
	type ContractArtifact,
	type DimensionArtifact,
	type EndpointMethod,
	type EndpointRow,
	type GateRule,
	type LinkMountArtifact,
	orderBySpecificity,
	type RoleArtifact,
	type RoleDef,
	selectableRows,
} from '@fabrika/auth-core'

type GeneratedKind = 'service' | 'human' | 'public'

/** `service` first: a present key is terminal, an absent one falls through to the session. `public` is terminal. */
const KIND_ORDER: readonly GeneratedKind[] = ['service', 'human', 'public']

const METHODS: readonly EndpointMethod[] = ['GET', 'POST']

/**
 * The gates of a contract application: one rule per endpoint path and kind, most specific path first, so the first
 * matching path is the row `planEndpoint` selects. A path with no endpoint gets no rule, so the proxy denies it.
 * A gate knows no method: a path also admits the kinds of the rows another method may select through it, so that
 * `GET /contact` still reaches the SPA when a form owns `POST /contact`. Under a reserved prefix the gates stay
 * coarser than the table (`@fabrika/auth-core`'s CLAUDE.md), and the framework refuses what the table does not serve.
 */
export function gatesFromContract(artifact: ContractArtifact): AppGates {
	const rules: GateRule[] = []
	const seen = new Set<string>()
	for (const { path } of orderBySpecificity(artifact.endpoints)) {
		if (seen.has(path)) {
			continue
		}
		seen.add(path)
		const kinds = new Set<GeneratedKind>()
		for (const method of METHODS) {
			for (const row of selectableRows(artifact, path, method)) {
				for (const kind of gateKindsOf(row)) {
					kinds.add(kind)
				}
			}
		}
		for (const kind of KIND_ORDER) {
			if (kinds.has(kind)) {
				rules.push(gateRule(path, kind))
			}
		}
	}
	return { rules }
}

/** `human` admits a session; every other caller presents a `px_` key; an anonymous kind needs no credential. */
function gateKindsOf(row: EndpointRow): GeneratedKind[] {
	if (row.callers.length === 0) {
		return ['public']
	}
	return row.callers.map((caller) => (caller === 'human' ? 'human' : 'service'))
}

function gateRule(path: string, kind: GeneratedKind): GateRule {
	switch (kind) {
		case 'service':
			return { path, kind: 'service' }
		case 'human':
			return { path, kind: 'human' }
		case 'public':
			return { path, kind: 'public' }
	}
}

/**
 * The IAM vocabulary of a contract application, marked `contract` so IAM refuses every wildcard written for it: the
 * dimensions as scopes with their container, creator role and members actions; the actions; the roles, a membership
 * role with its scope and the roles that may assign it; the link mounts; and the delegations. Every artifact
 * dimension is a scope, a file collection's `file:<name>` included, because access to a file is checked there.
 */
export function schemaFromContract(artifact: ContractArtifact): AppSchema {
	return {
		scopes: Object.entries(artifact.dimensions).sort(([a], [b]) => byCodeUnit(a, b)).map(([type, dimension]) => scopeDef(type, dimension)),
		actions: Object.entries(artifact.actions).sort(([a], [b]) => byCodeUnit(a, b)).map(([action, description]) => ({ action, description })),
		roles: Object.fromEntries(Object.entries(artifact.roles).map(([key, role]) => [key, roleDef(key, role)])),
		contract: true,
		links: Object.fromEntries(Object.entries(artifact.mounts).flatMap(([name, mount]) => (mount.kind === 'link' ? [[name, linkDef(mount)]] : []))),
		delegations: Object.fromEntries(artifact.endpoints.flatMap((row) => {
			const delegation = delegationOf(artifact, row)
			return delegation === null ? [] : [[row.id, delegation]]
		})),
	}
}

/** Key order differs between the two producers of an artifact; the schema must not. */
function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function scopeDef(type: string, dimension: DimensionArtifact): AppScopeDef {
	return {
		type,
		...(dimension.in === null ? {} : { in: dimension.in }),
		...(dimension.creator === null ? {} : { creator: dimension.creator }),
		...(dimension.members === null ? {} : { members: { manage: dimension.members.manage, list: dimension.members.list } }),
	}
}

function roleDef(key: string, role: RoleArtifact): RoleDef {
	const permissions = [...role.grants]
	return role.member === null
		? { name: key, permissions }
		: { name: key, permissions, member: { scope: role.member.scope, assignableBy: [...role.member.assignableBy] } }
}

function linkDef(mount: LinkMountArtifact): AppLinkMountDef {
	return { dimension: mount.dimension, grants: [...mount.grants], issuedBy: mount.issuedBy, maxDays: mount.maxDays }
}

/**
 * An endpoint spends membership authority when it creates a value of a dimension, or when its action is the
 * `members.manage` action of the dimension its access form names. IAM issues a delegation grant only for these.
 */
function delegationOf(artifact: ContractArtifact, row: EndpointRow): AppDelegationDef | null {
	if (row.requirement?.kind !== 'action') {
		return null
	}
	const { action, access } = row.requirement
	if (access.form === 'creates') {
		return { action, dimension: access.dimension, purpose: 'creates' }
	}
	const managed = Object.hasOwn(artifact.dimensions, access.dimension) ? artifact.dimensions[access.dimension]?.members : null
	return managed?.manage === action ? { action, dimension: access.dimension, purpose: 'members' } : null
}
