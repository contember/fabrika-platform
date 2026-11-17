import { createPage, Link, useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useRef, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { LogView } from '../../components/LogView'
import { Chip, RunStatus } from '../../components/Status'
import { api, ApiError, type AppEnvDto, type createControlClient, type RunDto } from '../../lib/api'
import { mayDo, opensApplications } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { fmtDate, fmtDuration, shortRef, shortSha } from '../../lib/format'

// Run detail: the run's metadata + the live log view. The LogView calls `runs.tail` while the run
// is non-terminal, then shows the complete log; the final status + exit code come from the run row.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const run = await api.runs.get({ runId: params.id })
		// The env's deploy target (domain) is useful context; tolerate it being gone (deleted env).
		const envs = await api.apps.environments.list({ appId: run.appId }).catch(() => null)
		const appEnv = envs?.items.find((e) => e.env === run.env) ?? null
		return { run, appEnv }
	})
	.route('/runs/:id')
	.render(({ data, invalidate }) => {
		const { run, appEnv } = data
		const access = useConsoleAccess()

		return (
			<>
				<div className="page-head">
					<Link to="runs" className="back-link">
						<Icon name="chevron-left" size={14} />
						All deploy runs
					</Link>
					<div className="page-head-row">
						<div>
							<h1>
								Run <code>{run.id.slice(0, 8)}</code>
							</h1>
							<div className="subtitle">
								{opensApplications(access)
									? <Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link>
									: run.appId}
								<span className="dot-sep" />
								<Chip>{run.env}</Chip>
								<span className="dot-sep">{run.trigger}</span>
							</div>
						</div>
						<RunActions run={run} appEnv={appEnv} onDone={invalidate} />
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
						{appEnv !== null && appEnv.domain !== null && (
							<Field label="Target">
								<code>{appEnv.domain}</code>
							</Field>
						)}
						<Field label="Exit code">
							{run.exitCode === null ? <span className="muted">none</span> : <code>{run.exitCode}</code>}
						</Field>
						{/* The timings last, so with four columns they share the second row. */}
						<Field label="Duration">{fmtDuration(run.startedAt, run.finishedAt)}</Field>
						<Field label="Created">{fmtDate(run.createdAt)}</Field>
						<Field label="Started">{fmtDate(run.startedAt, 'not yet')}</Field>
						<Field label="Finished">{fmtDate(run.finishedAt, 'not yet')}</Field>
					</div>
				</section>

				{run.status === 'awaiting_approval' && (
					<section>
						<p className="hint">
							This deploy widens access on a protected environment and waits for a person.{' '}
							<Link to="approvals/detail" params={{ id: run.id }}>Review the access change</Link>
						</p>
					</section>
				)}

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
 * The run's status and what the caller may do with it: cancel an in-flight run, or deploy a succeeded run's commit again.
 * A dev environment deploys only per workspace and a deleted one not at all, so neither offers it: Control would refuse.
 */
export function RunActions({ run, appEnv, onDone }: { run: RunDto; appEnv: AppEnvDto | null; onDone: () => void }) {
	const access = useConsoleAccess()
	const inFlight = run.status === 'pending' || run.status === 'running' || run.status === 'awaiting_approval'
	const mayDeploy = mayDo(access, CONTROL_ACTIONS.DEPLOY_TRIGGER, { app: run.appId, env: run.env })

	return (
		<div className="row-actions">
			<RunStatus status={run.status} />
			{inFlight && mayDeploy && <CancelButton runId={run.id} onDone={onDone} />}
			{run.status === 'succeeded' && run.commitSha !== null && appEnv !== null && appEnv.kind !== 'dev' && mayDeploy && (
				<DeployAgainButton appId={run.appId} env={run.env} commitSha={run.commitSha} />
			)}
		</div>
	)
}

/** A rollback is a new deploy (ADR-0050 §6): a new run of the same commit to the same environment. */
export function deployAgain(
	client: ReturnType<typeof createControlClient>,
	target: { appId: string; env: string; commitSha: string },
): Promise<RunDto> {
	return client.deploy({ appId: target.appId, env: target.env, ref: target.commitSha })
}

/** Deploys a succeeded run's commit again after a confirmation, then opens the new run. */
function DeployAgainButton({ appId, env, commitSha }: { appId: string; env: string; commitSha: string }) {
	const navigate = useNavigate()
	const [confirming, setConfirming] = useState(false)
	const button = useRef<HTMLButtonElement>(null)

	async function deploy() {
		const next = await deployAgain(api, { appId, env, commitSha })
		navigate('runs/detail', { params: { id: next.id } })
	}

	function close() {
		setConfirming(false)
		requestAnimationFrame(() => button.current?.focus())
	}

	return (
		<>
			<button ref={button} type="button" className="small" onClick={() => setConfirming(true)} aria-haspopup="dialog">
				<Icon name="refresh" size={13} />
				Deploy again
			</button>
			{confirming && <DeployAgainDialog env={env} commitSha={commitSha} onConfirm={deploy} onClose={close} />}
		</>
	)
}

/** Names the commit and the environment, because the caller may be rolling back production. A refusal shows in the dialog. */
export function DeployAgainDialog({ env, commitSha, onConfirm, onClose }: {
	env: string
	commitSha: string
	onConfirm: () => Promise<void>
	onClose: () => void
}) {
	return (
		<ConfirmDialog
			title="Deploy this commit again"
			confirmLabel="Deploy again"
			body={
				<p>
					Deploy commit <code>{shortSha(commitSha)}</code> to <strong>{env}</strong> again? It replaces what runs there now.
				</p>
			}
			onConfirm={onConfirm}
			onClose={onClose}
		/>
	)
}

/**
 * Cancel button for a pending/running run: destroys its deploy container and marks the run failed. Shown
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
			await api.runs.cancel({ runId })
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
