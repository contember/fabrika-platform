// What a contract compiles to for IAM (ADR-0012 §4): the vocabulary the deploy reconciles. The proxy reads the
// endpoint table itself (`contractProxyTable` in `@fabrika/proxy-core/manifest`); a contract generates no gates.

import {
	type AppDelegationDef,
	type AppLinkMountDef,
	type AppSchema,
	type AppScopeDef,
	type AppWorkloadDef,
	type ContractArtifact,
	type DimensionArtifact,
	endpointDelegation,
	type EndpointRow,
	type LinkMountArtifact,
	type RoleArtifact,
	type RoleDef,
} from '@fabrika/auth-core'

/**
 * The IAM vocabulary of a contract application, marked `contract` so IAM refuses every wildcard written for it: the
 * dimensions as scopes with their container, creator role and members actions; the actions; the roles, a membership
 * role with its scope and the roles that may assign it; the link mounts; the delegations; and the workloads. Every artifact
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
		workloads: workloadsOf(artifact),
	}
}

/** Every job and webhook with its exact actions: what its workload key carries (ADR-0022 "Principal kinds"). */
function workloadsOf(artifact: ContractArtifact): AppWorkloadDef[] {
	const jobs = Object.entries(artifact.jobs).map(([name, job]): AppWorkloadDef => ({ kind: 'job', name, actions: [...job.actions].sort(byCodeUnit) }))
	const webhooks = Object.entries(artifact.mounts).flatMap(([name, mount]): AppWorkloadDef[] =>
		mount.kind === 'webhook' ? [{ kind: 'webhook', name, actions: [...mount.actions].sort(byCodeUnit) }] : []
	)
	return [...jobs, ...webhooks].sort((a, b) => byCodeUnit(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`))
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

/** The grant IAM issues for an endpoint that spends membership authority; `endpointDelegation` decides which do. */
function delegationOf(artifact: ContractArtifact, row: EndpointRow): AppDelegationDef | null {
	const purpose = endpointDelegation(artifact, row)
	if (purpose === null || row.requirement?.kind !== 'action') {
		return null
	}
	return { action: row.requirement.action, dimension: row.requirement.access.dimension, purpose }
}
