import { createPage, Link } from '@buzola/router'
import { GrantRequests } from '../../components/GrantRequests'
import { Chip, RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { effectCounts } from '../../lib/access-changes'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate, shortSha } from '../../lib/format'
import { quietIamClient } from '../../lib/iam'

// Approvals: deploy runs whose access change waits for a person on a protected environment (ADR-0050), and console
// grants that wait for another administrator (ADR-0083). Only runs at coordinates where the viewer holds
// `access.approve` are listed, and only grant requests at applications the viewer administers in IAM; a viewer IAM
// does not answer as an administrator sees no grant section.

export default createPage()
	.loader(async () => {
		const iam = quietIamClient(fetch)
		const [approvals, grantRequests, me] = await Promise.all([
			api.approvals.list().then((list) => list.items),
			iam.grantRequests.list({}).then((list) => list.items, () => null),
			iam.me().then((me) => me.id, () => null),
		])
		return { approvals, grantRequests, me }
	})
	.route('/approvals')
	.render(({ data }) => (
		<>
			<div className="page-head">
				<h1>Approvals</h1>
				<p className="hint">
					Deploys to a protected environment with a change of a kind it approves, and console grants that wait for another administrator. Each waits until
					a person reads the change and decides.
				</p>
			</div>

			<Table
				colSpan={6}
				isEmpty={data.approvals.length === 0}
				empty={
					<EmptyState icon="shield" title="Nothing waits for approval" body="A deploy that only narrows access, or changes code only, never waits." />
				}
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
							{effectCounts(approval.changes)}
						</td>
						<td className="muted small" title={fmtDate(approval.run.startedAt ?? approval.run.createdAt)}>
							{fmtAgo(approval.run.startedAt ?? approval.run.createdAt)}
						</td>
					</tr>
				))}
			</Table>

			{data.grantRequests !== null && <GrantRequests initial={data.grantRequests} viewerId={data.me} />}
		</>
	))
