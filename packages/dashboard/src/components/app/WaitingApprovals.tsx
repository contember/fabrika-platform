import { Link } from '@buzola/router'
import { waitingDeploySummary } from '../../lib/access-changes'
import { type ApprovalDto } from '../../lib/api'
import { fmtAgo, fmtDate } from '../../lib/format'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'

/** The deploys of one application that wait for a person, each linked to its approval page. */
export function WaitingApprovals({ waiting }: { waiting: readonly ApprovalDto[] }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Waiting for a decision</h2>
			</div>
			<Table
				colSpan={4}
				isEmpty={waiting.length === 0}
				empty={<EmptyState icon="shield" title="Nothing waits" body="No deploy of this application waits for a person." />}
				head={
					<tr>
						<th>Environment</th>
						<th className="grow">Change</th>
						<th>Waiting since</th>
						<th aria-label="Actions" />
					</tr>
				}
			>
				{waiting.map((approval) => (
					<tr key={approval.run.id}>
						<td>{approval.run.env}</td>
						<td>
							{waitingDeploySummary(approval)}
						</td>
						<td className="muted small nowrap" title={fmtDate(approval.run.createdAt)}>{fmtAgo(approval.run.createdAt)}</td>
						<td>
							<Link to="approvals/detail" params={{ id: approval.run.id }} className="card-link">
								Review
								<Icon name="chevron-right" size={13} />
							</Link>
						</td>
					</tr>
				))}
			</Table>
		</section>
	)
}
