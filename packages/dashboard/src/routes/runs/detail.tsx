import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { LogView } from '../../components/LogView'
import { Chip, RunStatus } from '../../components/Status'
import { api, ApiError, type AppEnvDto, type ListResponse, type RunDto } from '../../lib/api'
import { fmtDate, fmtDuration, shortRef, shortSha } from '../../lib/format'

// Run detail — the run's metadata + the live log view. The LogView tails `runs/:id/tail` while the run
// is non-terminal, then shows the complete log; the final status + exit code come from the run row.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const run = await api.get<RunDto>(`/runs/${params.id}`)
		// The env's deploy target (domain) is useful context; tolerate it being gone (deleted env).
		const envs = await api.get<ListResponse<AppEnvDto>>(`/apps/${run.appId}/envs`).catch(() => null)
		const appEnv = envs?.items.find((e) => e.env === run.env) ?? null
		return { run, appEnv }
	})
	.route('/runs/:id')
	.render(({ data, invalidate }) => {
		const { run, appEnv } = data
		const inFlight = run.status === 'pending' || run.status === 'running'

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>
								Run <code>{run.id.slice(0, 8)}</code>
							</h1>
							<div className="subtitle">
								<Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link>
								<span className="dot-sep" />
								<Chip>{run.env}</Chip>
								<span className="dot-sep">{run.trigger}</span>
							</div>
						</div>
						<div className="row-actions">
							<RunStatus status={run.status} />
							{inFlight && <CancelButton runId={run.id} onDone={invalidate} />}
						</div>
					</div>
				</div>

				<section>
					<div className="detail-grid">
						<Field label="Ref">
							<code>{shortRef(run.ref)}</code>
						</Field>
						<Field label="Commit">
							<code>{shortSha(run.commitSha)}</code>
						</Field>
						<Field label="Exit code">
							{run.exitCode === null ? <span className="muted">—</span> : <code>{run.exitCode}</code>}
						</Field>
						<Field label="Duration">{fmtDuration(run.startedAt, run.finishedAt)}</Field>
						<Field label="Created">{fmtDate(run.createdAt)}</Field>
						<Field label="Started">{fmtDate(run.startedAt)}</Field>
						<Field label="Finished">{fmtDate(run.finishedAt)}</Field>
						{appEnv !== null && appEnv.domain !== null && (
							<Field label="Target">
								<code>{appEnv.domain}</code>
							</Field>
						)}
					</div>
				</section>

				<section>
					<div className="section-head">
						<Icon name="terminal" size={15} />
						<h2>Log</h2>
					</div>
					<LogView runId={run.id} initialStatus={run.status} />
				</section>
			</>
		)
	})

/**
 * Cancel button for a pending/running run — destroys its deploy container and marks the run failed. Shown
 * only while in-flight; on success re-loads the run so the badge + log settle. A cancelled run reads as
 * `failed` (fabrika has no distinct cancelled state).
 */
function CancelButton({ runId, onDone }: { runId: string; onDone: () => void }) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function cancel() {
		setBusy(true)
		setError(null)
		try {
			await api.post<RunDto>(`/runs/${runId}/cancel`)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Cancel failed.')
			setBusy(false)
		}
	}

	return (
		<>
			<button type="button" className="danger small" onClick={cancel} disabled={busy}>
				{busy ? 'Cancelling…' : 'Cancel'}
			</button>
			{error && <span className="error-text small">{error}</span>}
		</>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<h4>{label}</h4>
			{children}
		</div>
	)
}
