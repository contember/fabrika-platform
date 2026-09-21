import { Link } from '@buzola/router'
import type { RunDto } from '../../lib/api'
import { fmtAgo, fmtDate, shortRef, shortSha } from '../../lib/format'
import { Icon } from '../Icon'
import { RunStatus } from '../Status'
import { EmptyState, Table } from '../Table'

export function RecentRunsSection({ runs }: { runs: RunDto[] }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="runs" size={15} />
				<h2>Recent runs</h2>
				<span className="spacer" />
				<Link to="runs" className="card-link">
					All runs
					<Icon name="chevron-right" size={13} />
				</Link>
			</div>
			<Table
				colSpan={5}
				isEmpty={runs.length === 0}
				empty={<EmptyState icon="runs" title="No runs for this app yet" body="Deploy an environment above, or push to its trigger ref." />}
				head={
					<tr>
						<th>Status</th>
						<th>Env</th>
						<th className="grow">Ref</th>
						<th>Commit</th>
						<th>Started</th>
					</tr>
				}
			>
				{runs.map((run) => (
					<tr key={run.id}>
						<td>
							<Link to="runs/detail" params={{ id: run.id }}>
								<RunStatus status={run.status} />
							</Link>
						</td>
						<td>{run.env}</td>
						<td>
							<code>{shortRef(run.ref)}</code>
						</td>
						<td>
							<code>{shortSha(run.commitSha)}</code>
						</td>
						<td className="muted small nowrap" title={fmtDate(run.createdAt)}>{fmtAgo(run.createdAt)}</td>
					</tr>
				))}
			</Table>
		</section>
	)
}
