import { createPage, Link } from '@buzola/router'
import { Chip, RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate, shortSha } from '../../lib/format'

// Approvals — deploy runs whose access change waits for a person on a protected environment (ADR-0050). Only runs at
// coordinates where the viewer holds `access.approve` are listed.

export default createPage()
	.loader(async () => ({ approvals: (await api.approvals.list()).items }))
	.route('/approvals')
	.render(({ data }) => (
		<>
			<div className="page-head">
				<h1>Approvals</h1>
				<p className="hint">Deploys that widen access on a protected environment. Each waits until a person reads the change and decides.</p>
			</div>

			<Table
				colSpan={6}
				isEmpty={data.approvals.length === 0}
				empty={<EmptyState icon="shield" title="Nothing waits for approval" body="A deploy that only narrows access, or changes code only, never waits." />}
				head={
					<tr>
						<th>Status</th>
						<th>App</th>
						<th>Env</th>
						<th>Commit</th>
						<th className="grow">Change</th>
						<th>Waiting since</th>
					</tr>
				}
			>
				{data.approvals.map((approval) => (
					<tr key={approval.run.id}>
						<td>
							<Link to="approvals/detail" params={{ id: approval.run.id }}>
								<RunStatus status={approval.run.status} />
							</Link>
						</td>
						<td>
							<Link to="apps/detail" params={{ id: approval.run.appId }}>{approval.run.appId}</Link>
						</td>
						<td>
							<Chip>{approval.run.env}</Chip>
						</td>
						<td>
							<code>{shortSha(approval.run.commitSha)}</code>
						</td>
						<td>
							{approval.changes.filter((change) => change.widens).length} widening, {approval.changes.filter((change) => !change.widens).length}
							{' '}
							narrowing
						</td>
						<td className="muted small" title={fmtDate(approval.run.startedAt ?? approval.run.createdAt)}>
							{fmtAgo(approval.run.startedAt ?? approval.run.createdAt)}
						</td>
					</tr>
				))}
			</Table>
		</>
	))
