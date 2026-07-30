import { createPage, Link } from '@buzola/router'
import type { OperationsHealthCheckUpsertRequestDto } from '@fabrika/operations-contract/operator-api'
import { useState } from 'react'
import { operationsClient } from '../../client'
import { formatTimestamp } from '../../format'

const DEFAULT_CHECK: OperationsHealthCheckUpsertRequestDto = {
	path: '/healthz',
	enabled: true,
	intervalMs: 60_000,
	timeoutMs: 5_000,
	expectedStatus: 200,
	failureThreshold: 3,
	recoveryThreshold: 2,
	staleAfterMs: 180_000,
}

export default createPage()
	.params({ sourceId: 'string' })
	.loader(async ({ params }) => {
		const [source, health] = await Promise.all([
			operationsClient.source(params.sourceId),
			operationsClient.sourceHealth(params.sourceId),
		])
		return { source: source.source, health }
	})
	.route('/operations/sources/:sourceId')
	.render(({ data, invalidate }) => {
		const [path, setPath] = useState(DEFAULT_CHECK.path)
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function perform(action: () => Promise<unknown>) {
			setBusy(true)
			setError(null)
			try {
				await action()
				invalidate()
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : 'The health check could not be changed.')
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<Link to="operations/sources" className="back-link">← All sources</Link>
				<div className="page-head">
					<p className="eyebrow">Operations source</p>
					<div className="page-head-row">
						<div>
							<h1>{data.source.displayName}</h1>
							<p className="hint">{data.source.appId} · {data.source.environment} · {data.source.serviceKey}</p>
						</div>
						<Link to="operations/sources/alerts" params={{ sourceId: data.source.id }} className="btn">Alert routing</Link>
					</div>
				</div>

				<div className="detail-grid">
					<Fact label="Application" value={data.source.appId} />
					<Fact label="Environment" value={data.source.environment} />
					<Fact label="Service" value={data.source.serviceKey} />
					<Fact label="Public origin" value={data.source.publicOrigin ?? 'Not configured'} />
				</div>

				<section>
					<div className="section-head">
						<h2>HTTP health checks</h2>
						<span className={`status status-${healthLamp(data.health.telemetryState)}`}>
							<span className="lamp" aria-hidden="true" />
							telemetry {data.health.telemetryState}
						</span>
					</div>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th className="grow">Path</th>
									<th>State</th>
									<th>Observed</th>
									<th>Latency</th>
									<th>Policy</th>
									<th>
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{data.health.httpChecks.length === 0
									? (
										<tr>
											<td colSpan={6} className="empty">No HTTP health checks configured.</td>
										</tr>
									)
									: data.health.httpChecks.map((check) => (
										<tr key={check.id}>
											<td>
												<code>{check.path}</code>
											</td>
											<td>
												<span
													className={`status status-${healthLamp(check.enabled ? (check.current?.state ?? 'unavailable') : 'unavailable')}`}
												>
													<span className="lamp" aria-hidden="true" />
													{check.enabled ? (check.current?.state ?? 'pending') : 'disabled'}
												</span>
											</td>
											<td>{formatTimestamp(check.current?.observedAt ?? null)}</td>
											<td>{check.current?.latencyMs === null || check.current === null ? '—' : `${check.current.latencyMs} ms`}</td>
											<td>{check.expectedStatus} · {Math.round(check.intervalMs / 1000)}s</td>
											<td>
												<div className="row-actions">
													<button
														type="button"
														className="small"
														disabled={busy}
														onClick={() =>
															perform(() =>
																operationsClient.updateHealthCheck(data.source.id, check.id, {
																	path: check.path,
																	enabled: !check.enabled,
																	intervalMs: check.intervalMs,
																	timeoutMs: check.timeoutMs,
																	expectedStatus: check.expectedStatus,
																	failureThreshold: check.failureThreshold,
																	recoveryThreshold: check.recoveryThreshold,
																	staleAfterMs: check.staleAfterMs,
																})
															)}
													>
														{check.enabled ? 'Disable' : 'Enable'}
													</button>
													<button
														type="button"
														className="danger small"
														disabled={busy}
														onClick={() => perform(() => operationsClient.deleteHealthCheck(data.source.id, check.id))}
													>
														Delete
													</button>
												</div>
											</td>
										</tr>
									))}
							</tbody>
						</table>
					</div>
				</section>

				<section className="card">
					<div className="card-head">
						<h2>Add HTTP check</h2>
					</div>
					<div className="card-body">
						<div className="form-row">
							<label className="field-wide">
								Path on the configured public origin
								<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/healthz" />
							</label>
							<button
								type="button"
								className="primary"
								disabled={busy || !path.startsWith('/')}
								onClick={() => perform(() => operationsClient.createHealthCheck(data.source.id, { ...DEFAULT_CHECK, path }))}
							>
								Add check
							</button>
						</div>
						<p className="hint">Default policy: every 60s, 5s timeout, three failures to fail and two successes to recover.</p>
					</div>
				</section>
			</>
		)
	})

function healthLamp(state: string): 'ok' | 'stop' | 'idle' {
	if (state === 'healthy') return 'ok'
	if (state === 'failed') return 'stop'
	return 'idle'
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}
