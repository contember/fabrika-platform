import type { AccessMapActionDto, AccessMapDto, AccessMapEndpointDto, AccessMapRoleDto } from '../lib/api'
import { holdersLabel, type RoleHolders } from '../lib/role-holders'
import { Chip } from './Status'
import { Table } from './Table'

/** More endpoints than this in one action fold under a count, so a large contract stays readable. */
const SHOWN_ENDPOINTS = 8

const CALLER_LABELS: Readonly<Record<string, string>> = { human: 'people', machine: 'scripts' }

/**
 * A contract's access read by role: each role, then each action it holds with the endpoints and data it reaches. With
 * `holders`, each role also says how many hold it.
 */
export function AccessMapView({ map, holders = null }: { map: AccessMapDto; holders?: RoleHolders | null }) {
	const actions = new Map(map.actions.map((action) => [action.action, action]))
	return (
		<>
			{map.roles.map((role) => <RoleAccess key={role.role} role={role} actions={actions} holders={holders} />)}
			{map.memberEndpoints.length > 0 && (
				<details className="surface">
					<summary>
						<Chip>every member</Chip>
						<span>whatever role it holds · {map.memberEndpoints.length} {map.memberEndpoints.length === 1 ? 'endpoint' : 'endpoints'}</span>
					</summary>
					<EndpointList endpoints={map.memberEndpoints} />
				</details>
			)}
		</>
	)
}

/** `in each workspace, assigned by owner and to the creator of each new workspace · 3 actions`, or `app-wide, granted globally`. */
export function roleSummary(role: AccessMapRoleDto): string {
	const assigned = [
		...(role.assignableBy.length === 0 ? [] : [`assigned by ${role.assignableBy.join(', ')}`]),
		...role.creatorOf.map((dimension) => `to the creator of each new ${dimension}`),
	]
	const where = role.scope === null ? 'app-wide, granted globally' : `in each ${role.scope}`
	const count = new Set([...role.actions, ...role.via.flatMap((via) => via.actions)]).size
	const details = `${assigned.length === 0 ? '' : `, ${assigned.join(' and ')}`}${role.external ? ', external people too' : ''}`
	return `${where}${details} · ${count} ${count === 1 ? 'action' : 'actions'}`
}

interface HeldAction {
	readonly action: string
	readonly through: string | null
	readonly conferredBy: readonly string[]
}

function RoleAccess(
	{ role, actions, holders }: { role: AccessMapRoleDto; actions: ReadonlyMap<string, AccessMapActionDto>; holders: RoleHolders | null },
) {
	const held: HeldAction[] = [
		...role.actions.map((action) => ({ action, through: null, conferredBy: [] })),
		...role.via.flatMap((via) => via.actions.map((action) => ({ action, through: via.relation, conferredBy: via.conferredBy }))),
	]
	return (
		<details className="surface">
			<summary>
				<Chip>{role.role}</Chip>
				<span>{roleSummary(role)}</span>
				{holders !== null && <span className="muted">{holdersLabel(holders, role.role)}</span>}
			</summary>
			<Table
				colSpan={3}
				head={
					<tr>
						<th>Action</th>
						<th>Endpoints</th>
						<th className="grow">Data and people</th>
					</tr>
				}
			>
				{held.map((entry) => <ActionRow key={`${entry.through ?? ''}:${entry.action}`} held={entry} action={actions.get(entry.action)} />)}
			</Table>
		</details>
	)
}

function ActionRow({ held, action }: { held: HeldAction; action: AccessMapActionDto | undefined }) {
	const endpoints = action?.endpoints ?? []
	const tables = action?.tables ?? []
	const lines = [...(action?.files ?? []), ...(action?.members ?? []), ...(action?.links ?? [])]
	return (
		<tr>
			<td>
				<code>{held.action}</code>
				{action !== undefined && action.description !== '' && <div className="muted small">{action.description}</div>}
				{held.through !== null && <div className="muted small">through relation {held.through}, where its row names them</div>}
				{held.conferredBy.map((line) => <div key={line} className="muted small">conferred by {line}</div>)}
			</td>
			<td>
				{endpoints.length === 0 ? <span className="muted">—</span> : (
					<>
						<EndpointList endpoints={endpoints.slice(0, SHOWN_ENDPOINTS)} />
						{endpoints.length > SHOWN_ENDPOINTS && (
							<details>
								<summary className="muted small">{endpoints.length - SHOWN_ENDPOINTS} more</summary>
								<EndpointList endpoints={endpoints.slice(SHOWN_ENDPOINTS)} />
							</details>
						)}
					</>
				)}
			</td>
			<td>
				{tables.length === 0 && lines.length === 0 && <span className="muted">—</span>}
				{tables.map((table) => (
					<div key={`table:${table.table}`}>
						<code>{table.table}</code> {table.operations.join(', ')} <span className="muted small">({table.lies})</span>
						{table.also.map((also) => <div key={also} className="muted small">{also}</div>)}
					</div>
				))}
				{lines.map((line) => <div key={`line:${line}`}>{line}</div>)}
			</td>
		</tr>
	)
}

function EndpointList({ endpoints }: { endpoints: readonly AccessMapEndpointDto[] }) {
	return endpoints.map((endpoint) => (
		<div key={`${endpoint.id}:${endpoint.access}`}>
			<code>
				{endpoint.method} {endpoint.path}
			</code>{' '}
			<span className="muted small">
				{endpoint.access} · {endpoint.callers.map((caller) => CALLER_LABELS[caller] ?? caller).join(', ')}
			</span>
		</div>
	))
}
