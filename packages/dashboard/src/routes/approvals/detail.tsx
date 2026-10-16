import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { CloserReview } from '../../components/CloserReview'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Chip, RunStatus } from '../../components/Status'
import { type AccessChangeDto, api, ApiError, type ApprovalDto } from '../../lib/api'
import { fmtDate, shortRef, shortSha } from '../../lib/format'

// One access change (ADR-0050): the plain-language lines of the diff against the environment's active snapshot, and
// the decision. Approving binds the two digests shown here; a run classified again since refuses the decision.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ approval: await api.approvals.get({ runId: params.id }) }))
	.route('/approvals/:id')
	.render(({ data, invalidate }) => {
		const { approval } = data
		const { run } = approval
		const waiting = run.status === 'awaiting_approval'
		const widening = approval.changes.filter((change) => change.widens)
		const narrowing = approval.changes.filter((change) => !change.widens)

		return (
			<>
				<div className="page-head">
					<Link to="approvals" className="back-link">
						<Icon name="chevron-left" size={14} />
						All approvals
					</Link>
					<div className="page-head-row">
						<div>
							<h1>
								Access change of <Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link>
							</h1>
							<div className="subtitle">
								<Chip>{run.env}</Chip>
								<span className="dot-sep" />
								<Link to="runs/detail" params={{ id: run.id }}>
									run <code>{run.id.slice(0, 8)}</code>
								</Link>
								<span className="dot-sep">{run.actor ?? run.trigger}</span>
							</div>
						</div>
						<div className="row-actions">
							<RunStatus status={run.status} />
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
						<Field label="Compared with">
							{approval.baselineRunId === null
								? <span className="muted">nothing published yet</span>
								: (
									<Link to="runs/detail" params={{ id: approval.baselineRunId }}>
										run <code>{approval.baselineRunId.slice(0, 8)}</code>
									</Link>
								)}
						</Field>
						<Field label="Created">{fmtDate(run.createdAt)}</Field>
						{approval.approval !== null && (
							<Field label="Approved" wide>
								{approval.approval.label} · {fmtDate(approval.approval.approvedAt)}
							</Field>
						)}
					</div>
				</section>

				<ChangeList title="Widens access" icon="alert" changes={widening} />
				<ChangeList title="Narrows access" icon="check" changes={narrowing} />

				{waiting && <Decision approval={approval} onDone={invalidate} />}
			</>
		)
	})

/** One side of the change; a line that steps off the paved road is marked for closer review. */
export function ChangeList({ title, icon, changes }: { title: string; icon: 'alert' | 'check'; changes: readonly AccessChangeDto[] }) {
	if (changes.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name={icon} size={15} />
				<h2>{title}</h2>
			</div>
			<ul className="change-list">
				{changes.map((change) => (
					<li key={change.line}>
						{change.line}
						{change.review === 'closer' && (
							<>
								{' '}
								<CloserReview />
							</>
						)}
					</li>
				))}
			</ul>
		</section>
	)
}

/** Approve (the page's one constructive step) or refuse. Only a person signed in to the console can do either. */
function Decision({ approval, onDone }: { approval: ApprovalDto; onDone: () => void }) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [rejecting, setRejecting] = useState(false)

	async function decide(decision: 'approve' | 'reject') {
		setBusy(true)
		setError(null)
		try {
			await api.approvals.complete({
				runId: approval.run.id,
				decision,
				candidateDigest: approval.candidateDigest,
				baselineDigest: approval.baselineDigest,
			})
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'The decision was not recorded.')
			setBusy(false)
		}
	}

	return (
		<>
			<section>
				<p className="hint">
					Approving deploys this change to{' '}
					<strong>{approval.run.env}</strong>. It holds only for the lines above: if the environment publishes another change first, the run waits again.
				</p>
				<div className="row-actions">
					<button type="button" className="primary" disabled={busy} onClick={() => void decide('approve')}>
						{busy ? 'Recording…' : 'Approve and deploy'}
					</button>
				</div>
				{error && <p className="error-text" role="alert">{error}</p>}
			</section>
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>Refuse this change</strong>
					The run fails and nothing is published. A new deploy is classified again.
				</div>
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy} onClick={() => setRejecting(true)}>
					Refuse
				</button>
			</div>
			{rejecting && (
				<ConfirmDialog
					title="Refuse the access change"
					confirmLabel="Refuse"
					body={<p>Fail this run without deploying it?</p>}
					onConfirm={() => decide('reject')}
					onClose={() => setRejecting(false)}
				/>
			)}
		</>
	)
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
	return (
		<div className={wide ? 'wide' : undefined}>
			<h4>{label}</h4>
			{children}
		</div>
	)
}
