import { type AccessForm, type ContractArtifact, type EndpointRow, tableActions, type TablePolicyArtifact } from '@fabrika/auth-core'
import type { AccessMapActionDto, AccessMapDto, AccessMapRoleDto } from '@fabrika/control-contract'
import { type AccessSnapshot, compareText } from './snapshot'

/** A snapshot's access by role: what each role holds, and what each of those actions reaches. Empty without a contract. */
export function snapshotAccessMap(snapshot: AccessSnapshot): AccessMapDto {
	const contract = snapshot.contract
	return contract === null ? { roles: [], actions: [] } : accessMap(contract)
}

export function accessMap(contract: ContractArtifact): AccessMapDto {
	const roles = Object.entries(contract.roles)
		.sort(([left], [right]) => compareText(left, right))
		.map(([role, artifact]): AccessMapRoleDto => ({
			role,
			scope: artifact.member?.scope ?? null,
			assignableBy: [...(artifact.member?.assignableBy ?? [])].sort(compareText),
			external: artifact.external === true,
			actions: [...artifact.grants].sort(compareText),
			via: Object.entries(artifact.via ?? {})
				.sort(([left], [right]) => compareText(left, right))
				.map(([relation, actions]) => ({
					relation,
					dimension: contract.relations?.[relation]?.dimension ?? '',
					actions: [...actions].sort(compareText),
				})),
		}))
	const held = new Set(roles.flatMap((role) => [...role.actions, ...role.via.flatMap((via) => via.actions)]))
	const actions = [...held].sort(compareText).map((action): AccessMapActionDto => ({
		action,
		description: contract.actions[action] ?? '',
		endpoints: contract.endpoints
			.flatMap((row) => requiredAccess(row, action).map((access) => ({ id: row.id, method: row.method, path: row.path, access })))
			.sort((left, right) => compareText(left.path, right.path) || compareText(left.method, right.method)),
		members: memberReach(contract, action),
		links: Object.entries(contract.mounts)
			.sort(([left], [right]) => compareText(left, right))
			.flatMap(([mount, artifact]) =>
				artifact.kind === 'link' && artifact.issuedBy === action
					? [`issue share links of ${mount} to a ${artifact.dimension}, which grant ${artifact.grants.join(', ')}`]
					: []
			),
		tables: Object.entries(contract.tables)
			.sort(([left], [right]) => compareText(left, right))
			.flatMap(([table, policy]) => {
				const operations = tableOperations(policy, action)
				return operations.length === 0 ? [] : [{ table, lies: whereRowsLie(policy), operations }]
			}),
	}))
	return { roles, actions }
}

/** What `action` does to people: the members of a dimension's values it manages or lists, or the application's own. */
function memberReach(contract: ContractArtifact, action: string): string[] {
	const dimensions = Object.entries(contract.dimensions).sort(([left], [right]) => compareText(left, right))
	return [
		...(contract.members?.manage === action ? ["manage the application's members"] : []),
		...(contract.members?.list === action ? ["list the application's members"] : []),
		...dimensions.flatMap(([dimension, artifact]) => [
			...(artifact.members?.manage === action ? [`manage the members of each ${dimension}`] : []),
			...(artifact.members?.list === action ? [`list the members of each ${dimension}`] : []),
		]),
	]
}

/** Where each capability of `row` that names `action` must be held: `on deal`, `app-wide`. */
function requiredAccess(row: EndpointRow, action: string): string[] {
	const requirement = row.requirement
	if (requirement === null || requirement.kind === 'member') return []
	const capabilities = requirement.kind === 'action' ? [requirement] : Object.values(requirement.capabilities)
	return capabilities.filter((capability) => capability.action === action).map((capability) => accessPhrase(capability.access))
}

function accessPhrase(access: AccessForm): string {
	return access.form === 'app' ? 'app-wide' : `${access.form} ${access.dimension}`
}

/** What `action` does in the table: its operations, the app-wide reads, and each column it alone reads or writes. */
function tableOperations(policy: TablePolicyArtifact, action: string): string[] {
	const { actions } = policy
	const named = (artifact: TablePolicyArtifact['actions']['read'] | null): boolean => tableActions(artifact).includes(action)
	const columns = Object.entries(policy.columns).sort(([left], [right]) => compareText(left, right))
	return [
		...(named(actions.read) ? ['read'] : []),
		...(named(actions.insert) ? ['insert'] : []),
		...(named(actions.update) ? ['update'] : []),
		...(named(actions.delete) ? ['delete'] : []),
		...(actions.appRead?.includes(action) === true ? ['read every row'] : []),
		...(actions.appCount?.includes(action) === true ? ['count every row'] : []),
		...columns.flatMap(([column, own]) => [
			...(own.read === action ? [`read ${column}`] : []),
			...(own.write === action ? [`write ${column}`] : []),
		]),
	]
}

/** Where a table's rows lie: a dimension's values (in their container), under a parent table, or app-wide. */
function whereRowsLie(policy: TablePolicyArtifact): string {
	const scope = policy.scope
	switch (scope.mode) {
		case 'dimension':
			return scope.container === null ? `one row per ${scope.dimension}` : `one row per ${scope.dimension}, inside its ${scope.container.dimension}`
		case 'child':
			return `child rows of ${scope.parent}`
		case 'app':
			return 'app-wide'
		case 'reference':
			return 'shared by every scope, read-only'
		case 'inbox':
			return `the inbox of ${scope.form}`
	}
}
