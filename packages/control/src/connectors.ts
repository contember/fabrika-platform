// Connector edges between applications (ADR-0022 "Principal kinds"): an edge is a consumer environment's import of an
// owner's export in the environment of the same name, `(shop, prod) → (catalog, prod, products@1)`. Control computes
// the edges from both approved snapshots and refuses a publication that would break one, on either side.

import { exportDescription, incompatibleChanges } from '@fabrika/app/contract'
import { connectVariables, type ContractArtifact, type ExportDescription, type ImportArtifact } from '@fabrika/auth-core'
import { approvedSnapshot } from './approval/snapshot'
import type { ControlRegistryRepository } from './db'

/** One import of a consumer environment and the owner environment it reaches. */
export interface ConnectorEdge {
	readonly consumer: string
	readonly owner: string
	readonly env: string
	readonly name: string
	readonly imported: ImportArtifact
}

type Registry = Pick<ControlRegistryRepository, 'getAppEnv' | 'listPublishedAppEnvsNamed'>

async function approvedContract(registry: Pick<Registry, 'getAppEnv'>, appId: string, env: string): Promise<ContractArtifact | null> {
	const row = await registry.getAppEnv(appId, env)
	return row === null ? null : approvedSnapshot(row).snapshot.contract
}

/**
 * Why the consumer's candidate cannot publish: an import whose owner environment does not export that version to it,
 * whose vendored snapshot is not the owner's approved export, or that names a procedure the export does not have. A
 * consumer imports exactly what the owner serves.
 */
export async function consumerEdgeProblems(registry: Registry, appId: string, env: string, candidate: ContractArtifact): Promise<string[]> {
	const problems: string[] = []
	for (const [name, imported] of Object.entries(candidate.imports)) {
		const named = `import '${name}' (${imported.app}/${imported.export}@${imported.version})`
		const owner = await approvedContract(registry, imported.app, env)
		const declared = owner === null || !Object.hasOwn(owner.exports, imported.export) ? undefined : owner.exports[imported.export]
		if (owner === null || declared === undefined || declared.version !== imported.version || !declared.consumers.includes(appId)) {
			problems.push(`${named}: ${imported.app}@${env} has approved no export ${imported.export}@${imported.version} for ${appId}`)
			continue
		}
		const served = exportDescription(owner, imported.export)
		if (served?.digest !== imported.digest) {
			problems.push(`${named}: the vendored snapshot is not what ${imported.app}@${env} serves; run fabrika connect pull`)
			continue
		}
		const missing = imported.procedures.filter((path) => !Object.hasOwn(served.procedures, path))
		if (missing.length > 0) {
			problems.push(`${named}: imports ${missing.map((path) => `'${path}'`).join(', ')}, which ${imported.app}@${env} does not export`)
		}
	}
	return problems
}

/**
 * Why the owner's candidate cannot publish: it removes or breaks an export version an approved consumer of the same
 * environment imports, or stops naming that consumer. A breaking change is a new version, served beside the old one.
 * `active` is the owner's own approved contract, which each consumer's import was checked against.
 */
export async function ownerEdgeProblems(
	registry: Registry,
	appId: string,
	env: string,
	candidate: ContractArtifact | null,
	active: ContractArtifact | null,
): Promise<string[]> {
	const problems: string[] = []
	for (const edge of await edgesInto(registry, appId, env)) {
		const { imported } = edge
		const named = `${edge.consumer}@${env} imports ${imported.export}@${imported.version} (import '${edge.name}')`
		const declared = candidate === null || !Object.hasOwn(candidate.exports, imported.export) ? undefined : candidate.exports[imported.export]
		const after = candidate === null ? null : exportDescription(candidate, imported.export)
		if (declared === undefined || after === null || declared.version !== imported.version) {
			problems.push(`${named}, which this deploy removes; keep that version until ${edge.consumer} no longer imports it`)
			continue
		}
		if (!declared.consumers.includes(edge.consumer)) {
			problems.push(`${named}, and this deploy no longer names ${edge.consumer} as a consumer`)
			continue
		}
		const before = active === null ? null : exportDescription(active, imported.export)
		const changes = before === null || before.version !== imported.version
			? (after.digest === imported.digest ? [] : ['changes it'])
			: incompatibleChanges(before, after, imported.procedures)
		for (const change of changes) {
			problems.push(`${named}, and this deploy ${change}; bump the export's version instead`)
		}
	}
	return problems
}

/** Every approved import of an owner's exports, by the consumer environments of the same name. */
async function edgesInto(registry: Registry, owner: string, env: string): Promise<ConnectorEdge[]> {
	const edges: ConnectorEdge[] = []
	for (const row of await registry.listPublishedAppEnvsNamed(env)) {
		if (row.app_id === owner) continue
		const contract = approvedSnapshot(row).snapshot.contract
		for (const [name, imported] of Object.entries(contract?.imports ?? {})) {
			if (imported.app === owner) edges.push({ consumer: row.app_id, owner, env, name, imported })
		}
	}
	return edges
}

/**
 * The owner origin of each import of the approved contract, as `FABRIKA_CONNECT_<IMPORT>_URL`: the owner environment's
 * domain of the same name. An owner without one cannot be reached, so the deploy fails rather than guess.
 */
export async function connectorAddresses(
	registry: Pick<ControlRegistryRepository, 'getAppEnv'>,
	env: string,
	contract: ContractArtifact | null,
): Promise<Readonly<Record<string, string>>> {
	const addresses: Record<string, string> = {}
	for (const [name, imported] of Object.entries(contract?.imports ?? {})) {
		const owner = await registry.getAppEnv(imported.app, env)
		const domain = owner?.domain?.trim() ?? ''
		if (domain === '') {
			throw new Error(`import '${name}': ${imported.app}@${env} has no domain, so its proxy cannot be reached`)
		}
		addresses[connectVariables(name).url] = `https://${domain}`
	}
	return addresses
}

/**
 * The export `app@env` approved for `consumer`, as the consumer vendors it. Anything else is the same 404, so a caller
 * learns nothing about an export that is not for it.
 */
export async function describeConnector(
	registry: Pick<ControlRegistryRepository, 'getAppEnv'>,
	input: { readonly consumer: string; readonly env: string; readonly app: string; readonly export: string; readonly version: number },
): Promise<ExportDescription | null> {
	const owner = await approvedContract(registry, input.app, input.env)
	const declared = owner === null || !Object.hasOwn(owner.exports, input.export) ? undefined : owner.exports[input.export]
	if (owner === null || declared === undefined || declared.version !== input.version || !declared.consumers.includes(input.consumer)) {
		return null
	}
	return exportDescription(owner, input.export)
}
