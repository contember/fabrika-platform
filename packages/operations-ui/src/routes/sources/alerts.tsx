import { createPage, Link } from '@buzola/router'
import type { OperationsAlertKind } from '@fabrika/operations-contract/operator-api'
import { useState } from 'react'
import { operationsClient } from '../../client'

const ALERT_KINDS: OperationsAlertKind[] = [
	'new_issue',
	'regression',
	'spike',
	'failed_check',
	'recovery',
	'unhealthy_telemetry',
]

export default createPage()
	.params({ sourceId: 'string' })
	.loader(async ({ params }) => {
		const [source, alerts] = await Promise.all([
			operationsClient.source(params.sourceId),
			operationsClient.alerts(params.sourceId),
		])
		return { source: source.source, alerts }
	})
	.route('/operations/sources/:sourceId/alerts')
	.render(({ data, invalidate }) => {
		const [threshold, setThreshold] = useState(String(data.alerts.spike?.threshold ?? 20))
		const [scope, setScope] = useState<OperationsAlertKind>('new_issue')
		const [target, setTarget] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function perform(action: () => Promise<unknown>): Promise<boolean> {
			setBusy(true)
			setError(null)
			try {
				await action()
				invalidate()
				return true
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : 'Alert settings could not be changed.')
				return false
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<Link to="operations/sources/detail" params={{ sourceId: data.source.id }} className="back-link">← {data.source.displayName}</Link>
				<div className="page-head">
					<p className="eyebrow">Alert routing</p>
					<h1>{data.source.displayName}</h1>
					<p className="hint">Configure issue, health and telemetry notifications. Stored destinations remain redacted.</p>
				</div>
				{error && <p className="error-text" role="alert">{error}</p>}

				<div className="board">
					<section className="card">
						<div className="card-head">
							<h2>Spike detection</h2>
						</div>
						<div className="card-body">
							<label>
								Events in the evaluation window
								<input
									type="number"
									min={1}
									value={threshold}
									onChange={(event) => setThreshold(event.target.value)}
								/>
							</label>
							<div className="form-row">
								<button
									type="button"
									className="primary"
									disabled={busy || Number(threshold) < 1}
									onClick={() =>
										perform(() =>
											operationsClient.updateSpikeAlert(data.source.id, {
												threshold: Number(threshold),
												enabled: true,
											})
										)}
								>
									Save and enable
								</button>
								<button
									type="button"
									disabled={busy || data.alerts.spike === null}
									onClick={() =>
										perform(() =>
											operationsClient.updateSpikeAlert(data.source.id, {
												threshold: data.alerts.spike?.threshold ?? Number(threshold),
												enabled: false,
											})
										)}
								>
									Disable
								</button>
							</div>
						</div>
					</section>

					<section className="card">
						<div className="card-head">
							<h2>Event rules</h2>
						</div>
						<div className="card-body flush">
							<div className="feed">
								{ALERT_KINDS.map((kind) => {
									const enabled = data.alerts.rules.find((rule) => rule.kind === kind)?.enabled ?? false
									return (
										<div className="feed-row" key={kind}>
											<span className="feed-main">
												<strong className="feed-title">{label(kind)}</strong>
												<span className="feed-meta">{enabled ? 'Enabled' : 'Disabled'}</span>
											</span>
											<button
												type="button"
												className="small"
												disabled={busy}
												aria-label={`${enabled ? 'Disable' : 'Enable'} ${label(kind)} alerts`}
												onClick={() => perform(() => operationsClient.updateAlertRule(data.source.id, kind, { enabled: !enabled }))}
											>
												{enabled ? 'Disable' : 'Enable'}
											</button>
										</div>
									)
								})}
							</div>
						</div>
					</section>
				</div>

				<section>
					<div className="section-head">
						<h2>Webhook channels</h2>
					</div>
					<div className="table-wrap">
						<table aria-label={`Webhook channels for ${data.source.displayName}`}>
							<thead>
								<tr>
									<th>Scope</th>
									<th className="grow">Destination</th>
									<th>State</th>
									<th>
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{data.alerts.channels.length === 0
									? (
										<tr>
											<td colSpan={4} className="empty">No webhook channels configured.</td>
										</tr>
									)
									: data.alerts.channels.map((channel) => (
										<tr key={channel.id}>
											<td>{label(channel.scope)}</td>
											<td>
												<code>{channel.targetDisplay}</code>
											</td>
											<td>{channel.enabled ? 'enabled' : 'disabled'}</td>
											<td>
												<div className="row-actions">
													<button
														type="button"
														className="small"
														disabled={busy}
														aria-label={`${channel.enabled ? 'Disable' : 'Enable'} ${label(channel.scope)} webhook ${channel.targetDisplay}`}
														onClick={() =>
															perform(() =>
																operationsClient.updateAlertChannel(data.source.id, channel.id, {
																	scope: channel.scope,
																	type: 'webhook',
																	enabled: !channel.enabled,
																})
															)}
													>
														{channel.enabled ? 'Disable' : 'Enable'}
													</button>
													<button
														type="button"
														className="danger small"
														disabled={busy}
														aria-label={`Delete ${label(channel.scope)} webhook ${channel.targetDisplay}`}
														onClick={() => perform(() => operationsClient.deleteAlertChannel(data.source.id, channel.id))}
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
						<h2>Add webhook channel</h2>
					</div>
					<div className="card-body">
						<div className="form-row">
							<label>
								Alert scope
								<select value={scope} onChange={(event) => setScope(readKind(event.target.value))}>
									{ALERT_KINDS.map((kind) => <option key={kind} value={kind}>{label(kind)}</option>)}
								</select>
							</label>
							<label className="field-wide">
								Webhook URL
								<input
									type="url"
									value={target}
									onChange={(event) => setTarget(event.target.value)}
									placeholder="https://hooks.example.test/…"
									autoComplete="off"
								/>
							</label>
							<button
								type="button"
								className="primary"
								disabled={busy || target.trim() === ''}
								onClick={async () => {
									const created = await perform(() =>
										operationsClient.createAlertChannel(data.source.id, {
											scope,
											type: 'webhook',
											target: target.trim(),
											enabled: true,
										})
									)
									if (created) setTarget('')
								}}
							>
								Add channel
							</button>
						</div>
						<p className="hint">The complete URL is write-only. The API returns only a redacted destination.</p>
					</div>
				</section>
			</>
		)
	})

function readKind(value: string): OperationsAlertKind {
	return ALERT_KINDS.find((kind) => kind === value) ?? 'new_issue'
}

function label(kind: OperationsAlertKind): string {
	return kind.split('_').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
}
