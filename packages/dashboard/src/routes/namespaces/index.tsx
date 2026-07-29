import { createPage, Link } from '@buzola/router'
import { NamespaceStateBadge } from '../../components/Badge'
import { Table } from '../../components/Table'
import { api, type DeploymentNamespaceListResponse } from '../../lib/api'
import { fmtDate } from '../../lib/format'

export default createPage()
	.loader(async () => ({ namespaces: await api.get<DeploymentNamespaceListResponse>('/namespaces') }))
	.route('/namespaces')
	.render(({ data }) => {
		const { namespaces } = data
		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Deployment namespaces</h1>
							<p className="hint">Placement boundaries provisioned by the selected provider.</p>
						</div>
						{namespaces.operator !== null && namespaces.operator.presets.length > 0 && (
							<Link to="namespaces/create" className="nav-cta">+ Provision namespace</Link>
						)}
					</div>
				</div>

				{namespaces.operator === null && (
					<div className="panel muted">
						The selected provider does not expose operator-managed deployment namespaces.
					</div>
				)}

				<Table
					colSpan={6}
					isEmpty={namespaces.items.length === 0}
					empty={namespaces.operator === null ? 'No deployment namespaces.' : 'No deployment namespaces. Provision the first placement.'}
					head={
						<tr>
							<th>Namespace</th>
							<th>Environment</th>
							<th>Provider</th>
							<th>Ownership</th>
							<th>State</th>
							<th>Created</th>
						</tr>
					}
				>
					{namespaces.items.map((namespace) => (
						<tr key={namespace.id}>
							<td>
								<Link to="namespaces/detail" params={{ id: namespace.id }}>
									<strong>{namespace.id}</strong>
								</Link>
							</td>
							<td>
								<code>{namespace.env}</code>
							</td>
							<td>
								<code>{namespace.provider}</code>
							</td>
							<td>{namespace.exclusiveAppId === null ? <span className="muted">shared</span> : <code>{namespace.exclusiveAppId}</code>}</td>
							<td>
								<NamespaceStateBadge state={namespace.state} />
							</td>
							<td>{fmtDate(namespace.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
