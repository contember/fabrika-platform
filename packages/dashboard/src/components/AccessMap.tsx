import type { AccessMapActionDto, AccessMapDto, AccessMapRoleDto } from '../lib/api'
import { Chip } from './Status'
import { Table } from './Table'

/** More endpoints than this in one action fold under a count, so a large contract stays readable. */
const SHOWN_ENDPOINTS = 8

/** A contract's access read by role: each role, then each action it holds with the endpoints and data it reaches. */
export function AccessMapView({ map }: { map: AccessMapDto }) {
	const actions = new Map(map.actions.map((action) => [action.action, action]))
	return <>{map.roles.map((role) => <RoleAccess key={role.role} role={role} actions={actions} />)}</>
}

/** `in each workspace, assigned by owner`, or `app-wide, granted globally`; `external people too` when it admits them. */
export function roleSummary(role: AccessMapRoleDto): string {
	const where = role.scope === null
		? 'app-wide, granted globally'
		: `in each ${role.scope}${role.assignableBy.length === 0 ? '' : `, assigned by ${role.assignableBy.join(', ')}`}`
	const count = role.actions.length + role.via.reduce((sum, via) => sum + via.actions.length, 0)
	return `${where}${role.external ? ', external people too' : ''} · ${count} ${count === 1 ? 'action' : 'actions'}`
}

function RoleAccess({ role, actions }: { role: AccessMapRoleDto; actions: ReadonlyMap<string, AccessMapActionDto> }) {
	const held = [
		...role.actions.map((action) => ({ action, through: null })),
		...role.via.flatMap((via) => via.actions.map((action) => ({ action, through: `through ${via.relation}, where its row names them` }))),
	]
	return (
		<details className="surface">
			<summary>
				<Chip>{role.role}</Chip>
				<span>{roleSummary(role)}</span>
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
				{held.map(({ action, through }) => <ActionRow key={`${through ?? ''}:${action}`} name={action} action={actions.get(action)} through={through} />)}
			</Table>
		</details>
	)
}

function ActionRow({ name, action, through }: { name: string; action: AccessMapActionDto | undefined; through: string | null }) {
	const endpoints = action?.endpoints ?? []
	const reach = [
		...(action?.tables ?? []).map((table) => (
			<span key={`table:${table.table}`}>
				<code>{table.table}</code> {table.operations.join(', ')} <span className="muted small">({table.lies})</span>
			</span>
		)),
		...[...(action?.members ?? []), ...(action?.links ?? [])].map((line) => <span key={`line:${line}`}>{line}</span>),
	]
	return (
		<tr>
			<td>
				<code>{name}</code>
				{action !== undefined && action.description !== '' && <div className="muted small">{action.description}</div>}
				{through !== null && <div className="muted small">{through}</div>}
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
			<td>{reach.length === 0 ? <span className="muted">—</span> : reach.map((line, index) => <div key={index}>{line}</div>)}</td>
		</tr>
	)
}

function EndpointList({ endpoints }: { endpoints: readonly AccessMapActionDto['endpoints'][number][] }) {
	return endpoints.map((endpoint) => (
		<div key={`${endpoint.id}:${endpoint.access}`}>
			<code>
				{endpoint.method} {endpoint.path}
			</code>{' '}
			<span className="muted small">{endpoint.access}</span>
		</div>
	))
}
