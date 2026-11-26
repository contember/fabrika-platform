import {
	type AccessForm,
	type CapabilityAccessForm,
	type ContractArtifact,
	type EndpointRow,
	type FileCollectionArtifact,
	tableActions,
	type TablePolicyArtifact,
} from '@fabrika/auth-core'
import type { AccessMapActionDto, AccessMapDto, AccessMapEndpointDto, AccessMapRoleDto } from '@fabrika/control-contract'
import { type AccessSnapshot, compareText } from './snapshot'

/** A snapshot's access by role: what each role holds, and what each of those actions reaches. Empty without a contract. */
export function snapshotAccessMap(snapshot: AccessSnapshot): AccessMapDto {
	const contract = snapshot.contract
	return contract === null ? { roles: [], actions: [], memberEndpoints: [] } : accessMap(contract)
}

export function accessMap(contract: ContractArtifact): AccessMapDto {
	const roles = Object.entries(contract.roles)
		.sort(([left], [right]) => compareText(left, right))
		.map(([role, artifact]): AccessMapRoleDto => ({
			role,
			scope: artifact.member?.scope ?? null,
			assignableBy: [...(artifact.member?.assignableBy ?? [])].sort(compareText),
			creatorOf: Object.entries(contract.dimensions)
				.filter(([, dimension]) => dimension.creator === role)
				.map(([dimension]) => dimension)
				.sort(compareText),
			external: artifact.external === true,
			actions: [...artifact.grants].sort(compareText),
			via: Object.entries(artifact.via ?? {})
				.sort(([left], [right]) => compareText(left, right))
				.flatMap(([relation, actions]) => {
					const declared = contract.relations?.[relation]
					return declared === undefined ? [] : [{
						relation,
						dimension: declared.dimension,
						actions: [...actions].sort(compareText),
						conferredBy: conferredBy(contract, relation),
					}]
				}),
		}))
	const held = new Set(roles.flatMap((role) => [...role.actions, ...role.via.flatMap((via) => via.actions)]))
	const relationsOf = (action: string): ReadonlySet<string> =>
		new Set(roles.flatMap((role) => role.via.filter((via) => via.actions.includes(action)).map((via) => via.relation)))
	const actions = [...held].sort(compareText).map((action): AccessMapActionDto => ({
		action,
		description: contract.actions[action] ?? '',
		endpoints: byPath(contract.endpoints.flatMap((row) => requiredAccess(row, action))),
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
				const also = otherReach(policy, action, relationsOf(action), operations.length > 0)
				return operations.length === 0 && also.length === 0 ? [] : [{ table, lies: whereRowsLie(policy), operations, also }]
			}),
		files: Object.entries(contract.files)
			.sort(([left], [right]) => compareText(left, right))
			.flatMap(([name, files]) => fileReach(name, files, action)),
	}))
	const memberEndpoints = byPath(
		contract.endpoints.flatMap((row) => {
			const callers = roleCallers(row)
			return row.requirement?.kind === 'member' && callers.length > 0
				? [{ id: row.id, method: row.method, path: row.path, access: 'any member', callers }]
				: []
		}),
	)
	return { roles, actions, memberEndpoints }
}

function byPath(endpoints: AccessMapEndpointDto[]): AccessMapEndpointDto[] {
	return endpoints.sort((left, right) => compareText(left.path, right.path) || compareText(left.method, right.method))
}

/**
 * The callers of `row` that hold roles: a person, a person's agent (with the person's roles, ADR-0090) and a script's key.
 * A share link and another application hold none.
 */
function roleCallers(row: EndpointRow): string[] {
	return row.callers.filter((caller) => caller === 'human' || caller === 'agent' || caller === 'machine')
}

/** The tables whose rows confer `relation`, and who writes such a row. */
function conferredBy(contract: ContractArtifact, relation: string): string[] {
	return Object.entries(contract.tables)
		.sort(([left], [right]) => compareText(left, right))
		.flatMap(([table, policy]) => {
			const confers = policy.confers?.[relation]
			if (confers === undefined) return []
			const assign = confers.assign === null
				? 'no handler inserts one'
				: `an insert delegates it${confers.assign.maxDays === null ? '' : ` for at most ${confers.assign.maxDays} days`}${
					confers.assign.self ? ', to its writer too' : ''
				}`
			return [`a row of ${table} naming ${confers.principal} at ${confers.node}; ${assign}`]
		})
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

/** Each capability of `row` that names `action`, with where it is held and every other capability the row also needs. */
function requiredAccess(row: EndpointRow, action: string): AccessMapEndpointDto[] {
	const requirement = row.requirement
	const callers = roleCallers(row)
	if (requirement === null || requirement.kind === 'member' || callers.length === 0) return []
	if (requirement.kind === 'anyOf') {
		// Any one listed action admits the caller, application-wide; the others stand in for it, none is needed beside it.
		if (!requirement.actions.includes(action)) return []
		const others = requirement.actions.filter((other) => other !== action)
		return [{ id: row.id, method: row.method, path: row.path, access: `app-wide, or with ${others.join(' or ')} instead`, callers }]
	}
	const capabilities = requirement.kind === 'action' ? [requirement] : Object.values(requirement.capabilities)
	const phrases = capabilities.flatMap((capability, index) => {
		if (capability.action !== action) return []
		const others = capabilities.filter((_, other) => other !== index).map((other) => `${other.action} ${accessPhrase(other.access)}`)
		return [`${accessPhrase(capability.access)}${others.length === 0 ? '' : `, with also ${others.join(', ')}`}`]
	})
	return [...new Set(phrases)].map((access) => ({ id: row.id, method: row.method, path: row.path, access, callers }))
}

function accessPhrase(access: AccessForm | CapabilityAccessForm): string {
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
			...(tableActions(own.read ?? null).includes(action) ? [`read ${column}`] : []),
			...(tableActions(own.write ?? null).includes(action) ? [`write ${column}`] : []),
		]),
	]
}

/**
 * The table's other terms for `action`: the paths and reveals through which a grant reaches rows outside its own scope,
 * the access views and the conditions that decide which rows a grant or a relation reaches, in `diff.ts`'s words.
 */
function otherReach(policy: TablePolicyArtifact, action: string, relations: ReadonlySet<string>, operates: boolean): string[] {
	const reads = tableActions(policy.actions.read).includes(action)
	const sorted = <T>(record: Readonly<Record<string, T>> | undefined): [string, T][] =>
		Object.entries(record ?? {}).sort(([left], [right]) => compareText(left, right))
	return [
		...sorted(policy.readThrough).flatMap(([dimension, column]) =>
			reads ? [`a read over a ${dimension} also reaches the rows its ${column} names`] : []
		),
		...sorted(policy.writeThrough).flatMap(([dimension, actions]) => {
			const column = policy.readThrough?.[dimension]
			return actions.includes(action)
				? [
					`held on a row by a grant at the ${dimension} its ${column ?? 'path'} names, writes included; whoever inserts ${
						column ?? 'the path'
					} must hold it there`,
				]
				: []
		}),
		...sorted(policy.memberReveals).flatMap(([dimension, reveal]) => {
			const column = policy.readThrough?.[dimension]
			const where = column === undefined ? `its ${dimension}` : `the ${dimension} its ${column} names`
			return reveal.actions.includes(action) ? [`a row reveals its ${reveal.to} to a holder of it at ${where}`] : []
		}),
		...sorted(policy.reveals).flatMap(([relation, reveal]) =>
			reveal.actions.includes(action) ? [`a row relation ${relation} reaches reveals its ${reveal.to} for it`] : []
		),
		...sorted(policy.access).flatMap(([relation, view]) =>
			relations.has(relation) ? [`through relation ${relation}, the rows view ${view.view} lists: its SQL decides`] : []
		),
		...(operates && policy.when?.[action] !== undefined ? ['only a row its condition holds'] : []),
		...sorted(policy.relationWhen).flatMap(([relation, conditions]) =>
			relations.has(relation) && conditions[action] !== undefined ? [`through relation ${relation}, only a row its condition holds`] : []
		),
	]
}

/** What `action` does to a file collection's stored files, and whether share links to their owner reach them. */
function fileReach(name: string, files: FileCollectionArtifact, action: string): string[] {
	const operations = [
		...(files.read === action ? ['read'] : []),
		...(files.write === action ? ['upload'] : []),
		...(files.delete === action ? ['delete'] : []),
	]
	if (operations.length === 0) return []
	const links = files.link === false || files.read !== action
		? ''
		: files.link === true
		? '; share links to a row reach them too'
		: `; share links of ${files.link.join(', ')} reach them too`
	return [`${operations.join(', ')} the files of ${name} (rows of ${files.owner})${links}`]
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
