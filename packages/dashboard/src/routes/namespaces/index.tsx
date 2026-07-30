import { createPage, Link } from '@buzola/router'
import { Icon } from '../../components/Icon'
import { Chip, NamespaceState } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, type DeploymentNamespaceListResponse } from '../../lib/api'
import { fmtDate } from '../../lib/format'

export default createPage()
	.loader(async () => ({ namespaces: await api.get<DeploymentNamespaceListResponse>('/namespaces') }))
	.route('/namespaces')
	.render(({ data }) => {
		const { namespaces } = data
		const operable = namespaces.operator !== null && namespaces.operator.presets.length > 0

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Deployment namespaces</h1>
							<p className="hint">The bounded areas the selected provider places apps into. One per environment is the usual shape.</p>
						</div>
						{operable && (
							<Link to="namespaces/create" className="btn primary">
								<Icon name="plus" />
								Provision namespace
							</Link>
						)}
					</div>
				</div>

				{namespaces.operator === null && (
					<div className="notice">
						<Icon name="lock" size={15} />
						<span>The selected provider does not expose operator-managed deployment namespaces.</span>
					</div>
				)}

				<Table
					colSpan={6}
					isEmpty={namespaces.items.length === 0}
					empty={
						<EmptyState
							icon="bay"
							title="No placements yet"
							body={namespaces.operator === null
								? 'This provider manages its own boundaries — nothing to place from here.'
								: 'A namespace has to exist before an app can be onboarded into it.'}
							action={operable ? <Link to="namespaces/create" className="btn small primary">Provision the first one</Link> : undefined}
						/>
					}
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
								<Chip>{namespace.env}</Chip>
							</td>
							<td>
								<Chip>{namespace.provider}</Chip>
							</td>
							<td>{namespace.exclusiveAppId === null ? <span className="muted">shared</span> : <code>{namespace.exclusiveAppId}</code>}</td>
							<td>
								<NamespaceState state={namespace.state} />
							</td>
							<td className="muted small">{fmtDate(namespace.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
