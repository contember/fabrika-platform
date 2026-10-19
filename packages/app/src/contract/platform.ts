// What a contract compiles to for IAM (ADR-0012 §4): the vocabulary the deploy reconciles. The proxy reads the
// endpoint table itself (`contractProxyTable` in `@fabrika/proxy-core/manifest`).

import {
	APP_CALLER_PREFIX,
	type AppDelegationDef,
	type AppLinkMountDef,
	type AppSchema,
	type AppScopeDef,
	type AppWorkloadDef,
	type ContractArtifact,
	contractWorkloads,
	type DimensionArtifact,
	directoryLookups,
	endpointDelegation,
	type EndpointRow,
	JOB_SITE_PREFIX,
	type LinkMountArtifact,
	type RoleArtifact,
	type RoleDef,
} from '@fabrika/auth-core'

/**
 * The IAM vocabulary of a contract application, marked `contract` so IAM refuses every wildcard written for it: the
 * dimensions as scopes with their container, creator role and members actions; the actions; the roles, a membership
 * role with its scope and the roles that may assign it; the link mounts; the delegations; the workloads; and the locale,
 * display name and e-mail wording IAM names the application with. Every artifact
 * dimension is a scope, a file collection's `file:<name>` included, because access to a file is checked there.
 */
export function schemaFromContract(artifact: ContractArtifact): AppSchema {
	return {
		scopes: Object.entries(artifact.dimensions).sort(([a], [b]) => byCodeUnit(a, b)).map(([type, dimension]) =>
			scopeDef(type, dimension, directoryLookups(artifact, type))
		),
		actions: Object.entries(artifact.actions).sort(([a], [b]) => byCodeUnit(a, b)).map(([action, description]) => ({ action, description })),
		roles: Object.fromEntries(Object.entries(artifact.roles).map(([key, role]) => [key, roleDef(key, role)])),
		contract: true,
		links: Object.fromEntries(Object.entries(artifact.mounts).flatMap(([name, mount]) => (mount.kind === 'link' ? [[name, linkDef(mount)]] : []))),
		delegations: Object.fromEntries(artifact.endpoints.flatMap((row) => {
			const delegation = delegationOf(artifact, row)
			return delegation === null ? [] : [[row.id, delegation]]
		})),
		workloads: workloadsOf(artifact),
		...(artifact.locale === undefined ? {} : { locale: artifact.locale }),
		...(artifact.displayName === undefined ? {} : { displayName: artifact.displayName }),
		...(artifact.mail === undefined ? {} : { mail: artifact.mail }),
		...(artifact.members === undefined ? {} : { members: { manage: artifact.members.manage, list: artifact.members.list } }),
		...(artifact.directory === 'labels' ? { directory: 'labels' } : {}),
	}
}

/**
 * Every job, webhook and public procedure with its exact actions, a job with the link mount it declares it `issues`, and
 * every consumer of an export with the actions of the export rows it may call: what each workload key carries (ADR-0022
 * "Principal kinds").
 */
function workloadsOf(artifact: ContractArtifact): AppWorkloadDef[] {
	const own = contractWorkloads(artifact).map((workload): AppWorkloadDef => {
		const issues = workload.kind === 'job' ? (artifact.declared?.[`${JOB_SITE_PREFIX}${workload.name}`]?.issues ?? null) : null
		return { kind: workload.kind, name: workload.name, actions: [...workload.actions], ...(issues === null ? {} : { issues }) }
	})
	const consumers = new Map<string, Set<string>>()
	for (const row of artifact.endpoints) {
		if (row.source.kind !== 'export' || row.requirement?.kind !== 'action') continue
		for (const caller of row.callers) {
			if (!caller.startsWith(APP_CALLER_PREFIX)) continue
			const consumer = caller.slice(APP_CALLER_PREFIX.length)
			consumers.set(consumer, (consumers.get(consumer) ?? new Set<string>()).add(row.requirement.action))
		}
	}
	const apps = [...consumers].map(([name, actions]): AppWorkloadDef => ({ kind: 'app', name, actions: [...actions].sort(byCodeUnit) }))
	return [...own, ...apps].sort((a, b) => byCodeUnit(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`))
}

/** Key order differs between the two producers of an artifact; the schema must not. */
function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function scopeDef(type: string, dimension: DimensionArtifact, lookups: readonly string[]): AppScopeDef {
	return {
		type,
		...(dimension.in === null ? {} : { in: dimension.in }),
		...(dimension.creator === null ? {} : { creator: dimension.creator }),
		...(dimension.members === null ? {} : { members: { manage: dimension.members.manage, list: dimension.members.list } }),
		...(dimension.directory === 'labels' ? { directory: 'labels' } : {}),
		...(lookups.length === 0 ? {} : { lookups: [...lookups] }),
	}
}

function roleDef(key: string, role: RoleArtifact): RoleDef {
	// `external` is carried on every role, so IAM refuses one on a role that is not a membership role instead of never seeing it.
	return {
		name: key,
		permissions: [...role.grants],
		...(role.member === null ? {} : { member: { scope: role.member.scope, assignableBy: [...role.member.assignableBy] } }),
		...(role.external === true ? { external: true } : {}),
	}
}

function linkDef(mount: LinkMountArtifact): AppLinkMountDef {
	return { dimension: mount.dimension, grants: [...mount.grants], issuedBy: mount.issuedBy, maxDays: mount.maxDays }
}

/** The grant IAM issues for an endpoint that spends membership authority; `endpointDelegation` decides which do. */
function delegationOf(artifact: ContractArtifact, row: EndpointRow): AppDelegationDef | null {
	const purpose = endpointDelegation(artifact, row)
	if (purpose === null || row.requirement?.kind !== 'action' || row.requirement.access.form === 'app') {
		return null
	}
	return { action: row.requirement.action, dimension: row.requirement.access.dimension, purpose }
}
