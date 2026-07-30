import { Link } from '@buzola/router'
import type { OperationsSourceSummaryDto } from '@fabrika/operations-contract/operator-api'

export function SourcesView({ sources }: { sources: readonly OperationsSourceSummaryDto[] }) {
	return (
		<div className="table-wrap">
			<table>
				<thead>
					<tr>
						<th className="grow">Source</th>
						<th>Application</th>
						<th>Environment</th>
						<th>Service</th>
						<th>Public origin</th>
					</tr>
				</thead>
				<tbody>
					{sources.length === 0
						? (
							<tr>
								<td colSpan={5} className="empty">
									<div className="empty-state">
										<strong className="empty-title">No telemetry sources</strong>
										<span className="empty-body">Sources appear after the control catalog reconciles with Operations.</span>
									</div>
								</td>
							</tr>
						)
						: sources.map((source) => (
							<tr key={source.id}>
								<td>
									<Link to="operations/sources/detail" params={{ sourceId: source.id }}>
										<strong>{source.displayName}</strong>
									</Link>
								</td>
								<td>
									<code>{source.appId}</code>
								</td>
								<td>{source.environment}</td>
								<td>{source.serviceKey}</td>
								<td>{source.publicOrigin ?? '—'}</td>
							</tr>
						))}
				</tbody>
			</table>
		</div>
	)
}
