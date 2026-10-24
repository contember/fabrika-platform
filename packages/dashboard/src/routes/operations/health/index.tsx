import { createPage, Link } from '@buzola/router'
import { Status } from '../../../components/Status'
import { fmtDate } from '../../../lib/format'
import { healthLamp, runtimeHealth } from '../../../lib/health'
import { operationsClient } from '../../../operations/client'
import { PageHead } from '../../../operations/components/PageHead'

export default createPage()
	.loader(async () => ({ health: await operationsClient.health(), loadedAt: Date.now() }))
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
							<th>Latest HTTP observation</th>
							<th>HTTP health</th>
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
								const enabled = source.httpChecks.filter((check) => source.source.enabled && check.enabled)
								const latest = source.httpChecks
									.flatMap((check) => check.current === null ? [] : [check.current])
									.sort((left, right) => right.observedAt - left.observedAt)[0] ?? null
								const health = runtimeHealth([source], data.loadedAt)
								const telemetry = source.source.enabled ? source.telemetryState : 'disabled'
								return (
									<tr key={source.source.id}>
										<td>
											<Link to="operations/sources/detail" params={{ sourceId: source.source.id }}>
												<strong>{source.source.displayName}</strong>
											</Link>
											<div className="cell-note">{source.source.environment} · {source.source.serviceKey}</div>
										</td>
										<td>
											<Status lamp={healthLamp(telemetry)}>{telemetry}</Status>
										</td>
										<td>{enabled.length} enabled / {source.httpChecks.length}</td>
										<td>{fmtDate(latest === null ? null : latest.observedAt / 1000, 'never')}</td>
										<td>
											<Status lamp={health.lamp} title={health.note}>{source.source.enabled ? health.label : 'Disabled'}</Status>
										</td>
									</tr>
								)
							})}
					</tbody>
				</table>
			</div>
		</>
	))
