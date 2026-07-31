import { createPage, Link } from '@buzola/router'
import { operationsClient } from '../client'
import { PageHead } from '../components/Unavailable'
import { formatTimestamp } from '../format'

export default createPage()
	.loader(async () => ({ health: await operationsClient.health() }))
	.route('/operations/health')
	.render(({ data }) => (
		<>
			<PageHead title="Health and telemetry" description="Runtime signals and delivery state for every visible source." />
			<div className="table-wrap">
				<table aria-label="Operations health">
					<thead>
						<tr>
							<th className="grow">Source</th>
							<th>Telemetry</th>
							<th>HTTP checks</th>
							<th>Latest observation</th>
							<th>State</th>
						</tr>
					</thead>
					<tbody>
						{data.health.sources.length === 0
							? (
								<tr>
									<td colSpan={5} className="empty">
										No sources are visible. The control catalog must reconcile before health signals appear.
									</td>
								</tr>
							)
							: data.health.sources.map((source) => {
								const latest = source.httpChecks
									.flatMap((check) => check.current === null ? [] : [check.current])
									.sort((left, right) => right.observedAt - left.observedAt)[0] ?? null
								const state = aggregateHealth(
									source.telemetryState,
									source.httpChecks.flatMap((check) => check.enabled ? [check.current?.state ?? 'unavailable'] : []),
								)
								return (
									<tr key={source.source.id}>
										<td>
											<Link to="operations/sources/detail" params={{ sourceId: source.source.id }}>
												<strong>{source.source.displayName}</strong>
											</Link>
											<div className="cell-note">{source.source.environment} · {source.source.serviceKey}</div>
										</td>
										<td>{source.telemetryState}</td>
										<td>{source.httpChecks.length}</td>
										<td>{formatTimestamp(latest?.observedAt ?? null)}</td>
										<td>
											<span className={`status status-${healthLamp(state)}`}>
												<span className="lamp" aria-hidden="true" />
												{state}
											</span>
										</td>
									</tr>
								)
							})}
					</tbody>
				</table>
			</div>
		</>
	))

export function aggregateHealth(telemetry: string, checks: readonly string[]): string {
	const states = [telemetry, ...checks]
	if (states.includes('failed')) return 'failed'
	if (states.includes('degraded')) return 'degraded'
	if (states.includes('stale')) return 'stale'
	if (states.every((state) => state === 'healthy')) return 'healthy'
	return 'unavailable'
}

function healthLamp(state: string): 'ok' | 'stop' | 'idle' {
	if (state === 'healthy') return 'ok'
	if (state === 'failed') return 'stop'
	return 'idle'
}
