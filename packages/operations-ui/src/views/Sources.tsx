import type { CanonicalOperationsCatalogSourceV1 } from '@fabrika/operations-contract'

export function SourcesView({ sources }: { sources: readonly CanonicalOperationsCatalogSourceV1[] }) {
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
							<tr key={`${source.coordinate.appId}:${source.coordinate.environment}:${source.coordinate.serviceKey}`}>
								<td>
									<strong>{source.displayName}</strong>
								</td>
								<td>
									<code>{source.coordinate.appId}</code>
								</td>
								<td>{source.coordinate.environment}</td>
								<td>{source.coordinate.serviceKey}</td>
								<td>{source.publicOrigin ?? '—'}</td>
							</tr>
						))}
				</tbody>
			</table>
		</div>
	)
}
