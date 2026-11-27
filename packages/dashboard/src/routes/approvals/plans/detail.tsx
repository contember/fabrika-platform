import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { DecisionFailureNotice, StepUpHint } from '../../../components/DecisionFailureNotice'
import { Icon } from '../../../components/Icon'
import { PasskeyCheckPrompt } from '../../../components/PasskeyCheckPrompt'
import { Chip, Status } from '../../../components/Status'
import { Table } from '../../../components/Table'
import { api, type ApprovalPlanDto, type ApprovalPlanEntryDto } from '../../../lib/api'
import { activeEntries, PLAN_STATE_TEXT, planLamp, planLines, type PlannedSubject } from '../../../lib/approval-plans'
import { type DecisionFailure, decisionFailure, type PasskeyCheck, startDecision } from '../../../lib/decision-step-up'
import { requesterBlocks, requesterBlockText } from '../../../lib/environment-protection'
import { fmtDate, shortSha } from '../../../lib/format'
import { consoleSession } from '../../../lib/session'
import { ChangeLines, ChangeList } from '../detail'

// One approval plan (ADR-0050 §5): the access change of a commit not deployed yet, against what the environment
// publishes, approved ahead of its deploy. The page shows what the plan lets through, subject by subject, and what still
// waits for a person at the deploy; approving binds the two digests shown here, as a parked run's approval does.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [plan, session] = await Promise.all([api.approvals.plans.get({ id: params.id }), consoleSession()])
		return { plan, me: session.principal?.id ?? null }
	})
	.route('/approvals/plans/:id')
	.render(({ data, invalidate }) => {
		const { plan } = data
		const now = Math.floor(Date.now() / 1000)
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
								Plan for <Link to="apps/detail" params={{ id: plan.appId }}>{plan.appId}</Link>
							</h1>
							<div className="subtitle">
								<Chip>{plan.env}</Chip>
								<span className="dot-sep">
									commit <code>{shortSha(plan.commitSha)}</code>
								</span>
							</div>
						</div>
						<div className="row-actions">
							<Status lamp={planLamp(plan.state)}>{PLAN_STATE_TEXT[plan.state]}</Status>
						</div>
					</div>
				</div>
				<PlanView plan={plan} now={now} />
				{plan.state === 'pending' && <PlanDecision plan={plan} me={data.me} now={now} onDone={invalidate} />}
				{plan.state === 'approved' && activeEntries(plan) > 0 && <PlanRevoke plan={plan} onDone={invalidate} />}
			</>
		)
	})

const REQUESTER_VIA: Record<ApprovalPlanDto['requester']['credential'], string> = {
	oauth: 'through an agent',
	key: 'with a key',
	console: 'in the console',
}

/** Who asked for the plan and of what, what it lets through, and what it does not. */
export function PlanView({ plan, now }: { plan: ApprovalPlanDto; now: number }) {
	const { requester } = plan
	const lines = planLines(plan)
	return (
		<>
			<section className="card deploy-request">
				<div className="card-body">
					<p className="deploy-request-lead">
						<strong>{requester.principal.label}</strong> asks {REQUESTER_VIA[requester.credential]} to approve the access change of{' '}
						<code>{shortSha(plan.commitSha)}</code> on <strong>{plan.appId}</strong> · <strong>{plan.env}</strong> before it deploys.
					</p>
					{requester.clientId !== undefined && (
						<p className="small">
							Agent <span className="agent-text" title="Written by the agent, not by Fabrika">{requester.clientId}</span>
						</p>
					)}
					<p>
						<PlanSentence plan={plan} lines={lines.covered.length} person={lines.person.length} />
					</p>
					<p className="small">
						Commit <code>{plan.commitSha}</code> · compared with {plan.baselineRunId === null
							? <span className="muted">nothing published yet</span>
							: (
								<Link to="runs/detail" params={{ id: plan.baselineRunId }}>
									run <code>{plan.baselineRunId.slice(0, 8)}</code>
								</Link>
							)} · asked {fmtDate(plan.createdAt)}
					</p>
					<PlanTimes plan={plan} now={now} />
				</div>
			</section>
			{lines.covered.length > 0 && (
				<section>
					<div className="section-head">
						<Icon name="shield" size={15} />
						<h2>What the plan approves</h2>
					</div>
					<p className="hint">
						Each subject is one entry. A deploy whose lines for a subject are these lets them through without a second decision, once; a deploy with any
						other line waits for a person.
					</p>
					<Table
						colSpan={3}
						head={
							<tr>
								<th>Subject</th>
								<th className="grow">Change</th>
								<th>Entry</th>
							</tr>
						}
					>
						{lines.covered.map((subject) => <SubjectRow key={subject.subject} subject={subject} />)}
					</Table>
				</section>
			)}
			<ChangeList
				title="Still waits for a person at the deploy"
				icon="alert"
				hint="A plan never counts for these: the environment wants a person to approve the deploy itself."
				changes={lines.person}
			/>
			{lines.off.length > 0 && (
				<details className="every-line">
					<summary>
						Lines that wait for nothing <span className="muted">({lines.off.length})</span>
					</summary>
					<ChangeList title="Applies without approval" icon="arrow-right" changes={lines.off} />
				</details>
			)}
		</>
	)
}

/** What approving does, in one sentence, or what the plan did. */
function PlanSentence({ plan, lines, person }: { plan: ApprovalPlanDto; lines: number; person: number }) {
	const subjects = `${lines} ${lines === 1 ? 'subject' : 'subjects'}`
	const rest = person === 0
		? ''
		: ` ${person === 1 ? '1 line still waits' : `${person} lines still wait`} for a person at the deploy.`
	switch (plan.state) {
		case 'pending':
			return <>Approving lets the next deploy of this change through on {subjects} without a second decision.{rest}</>
		case 'approved':
			if (activeEntries(plan) === 0) return <>Its entries were used or have expired; it lets nothing more through.</>
			return <>It lets a deploy of this change through on {subjects} without a second decision.{rest}</>
		case 'rejected':
			return <>It was refused and lets nothing through.</>
		case 'expired':
			return <>Nobody decided it before its deadline, so it expired and lets nothing through.</>
		case 'revoked':
			return <>It was revoked and lets nothing through from then on.</>
	}
}

/** The deadline of a pending plan, the expiry of an approved one, and who decided it. */
function PlanTimes({ plan, now }: { plan: ApprovalPlanDto; now: number }) {
	return (
		<>
			{plan.state === 'pending' && plan.deadline > now && (
				<p className="muted small">Decide by {fmtDate(plan.deadline)}; after that the plan expires and approves nothing.</p>
			)}
			{plan.state === 'approved' && plan.expiresAt !== undefined && activeEntries(plan) > 0 && (
				<p className="muted small">Its entries cover a deploy until {fmtDate(plan.expiresAt)}, each one deploy only.</p>
			)}
			{plan.decision !== undefined && (
				<p className="small">
					{DECIDED[plan.state]} by {plan.decision.label} · {fmtDate(plan.decision.at)}
				</p>
			)}
		</>
	)
}

const DECIDED: Record<ApprovalPlanDto['state'], string> = {
	pending: 'Decided',
	approved: 'Approved',
	rejected: 'Refused',
	expired: 'Decided',
	revoked: 'Revoked',
}

function SubjectRow({ subject }: { subject: PlannedSubject }) {
	return (
		<tr>
			<td>
				<code>{subject.subject}</code>
			</td>
			<td>
				<ChangeLines changes={subject.changes} crossOrigins={undefined} inRow={false} />
			</td>
			<td className="nowrap">
				<EntryState entry={subject.entry} />
			</td>
		</tr>
	)
}

const ENTRY_STATE_TEXT: Record<ApprovalPlanEntryDto['state'], string> = {
	pending: 'until approved',
	active: 'covers a deploy',
	consumed: 'used',
	revoked: 'revoked',
	expired: 'expired',
}

function EntryState({ entry }: { entry: ApprovalPlanEntryDto | undefined }) {
	if (entry === undefined) return <span className="muted">—</span>
	if (entry.state === 'consumed' && entry.consumedByRunId !== undefined) {
		return (
			<>
				used by{' '}
				<Link to="runs/detail" params={{ id: entry.consumedByRunId }}>
					run <code>{entry.consumedByRunId.slice(0, 8)}</code>
				</Link>
			</>
		)
	}
	return <span className={entry.state === 'active' ? undefined : 'muted'}>{ENTRY_STATE_TEXT[entry.state]}</span>
}

/**
 * Approve (the page's one constructive step) or refuse a pending plan, under the rules of a parked run: a person signed
 * in to the console, before the deadline, the second of two approvers a different person, the requester's own person
 * only where the environment lets them, and a passkey where deciding takes one.
 */
export function PlanDecision({ plan, me, now, onDone }: { plan: ApprovalPlanDto; me: string | null; now: number; onDone: () => void }) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<DecisionFailure | null>(null)
	const [rejecting, setRejecting] = useState(false)
	const [check, setCheck] = useState<PasskeyCheck<void> | null>(null)

	if (plan.deadline <= now) {
		return (
			<p className="hint">Nobody decided this plan before {fmtDate(plan.deadline)}, so it expired and approves nothing. The agent may plan again.</p>
		)
	}
	const approvedByMe = plan.partialApproval !== undefined && plan.partialApproval.principalId === me
	const blocked = requesterBlocks(plan.requesterMayApprove, plan.requester.personId, me)

	async function decide(decision: 'approve' | 'reject') {
		setBusy(true)
		setFailure(null)
		const item = { id: plan.id, decision, candidateDigest: plan.candidateDigest, baselineDigest: plan.baselineDigest }
		try {
			const started = await startDecision(
				plan.stepUp,
				() => api.approvals.plans.challenge(item),
				async (stepUp) => {
					await api.approvals.plans.decide(stepUp === undefined ? item : { ...item, stepUp })
				},
				'decision',
			)
			if (started.kind === 'posted') {
				onDone()
				return
			}
			setCheck(started.check)
		} catch (cause) {
			setFailure(decisionFailure(cause))
		}
		setBusy(false)
	}

	return (
		<>
			<section>
				<p className="hint">
					Approving deploys nothing now. It holds only for the lines above, against what <strong>{plan.env}</strong>{' '}
					publishes now: once another change publishes first, a deploy of this one waits for a person again.
				</p>
				{plan.approvers === 2 && (
					<p className="hint">
						{plan.partialApproval === undefined
							? 'Two different people approve this plan: the first approval is recorded, and the second makes it cover a deploy.'
							: `${plan.partialApproval.label} approved it ${fmtDate(plan.partialApproval.at)}; a second, different person makes it cover a deploy.`}
					</p>
				)}
				<StepUpHint stepUp={plan.stepUp} item="plan" />
				{check !== null
					? (
						<PasskeyCheckPrompt
							check={check}
							onDone={() => {
								// As after a decision without a passkey: nothing to decide again while the page refetches.
								setBusy(true)
								setCheck(null)
								onDone()
							}}
							onCancel={() => setCheck(null)}
						/>
					)
					: (
						<div className="row-actions">
							{approvedByMe
								? <span className="muted decision-note">Waiting for a second person</span>
								: blocked !== null
								? <span className="muted decision-note">{requesterBlockText(blocked, 'plan')}</span>
								: (
									<button type="button" className="primary" disabled={busy} onClick={() => void decide('approve')}>
										{busy ? 'Recording…' : 'Approve plan'}
									</button>
								)}
						</div>
					)}
				{failure !== null && <DecisionFailureNotice failure={failure} />}
			</section>
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>Refuse this plan</strong>
					It approves nothing; a deploy of the change waits for a person as before.
				</div>
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy || check !== null} onClick={() => setRejecting(true)}>
					Refuse
				</button>
			</div>
			{rejecting && (
				<ConfirmDialog
					title="Refuse the plan"
					confirmLabel="Refuse"
					body={<p>Refuse this plan? It lets nothing through.</p>}
					onConfirm={() => decide('reject')}
					onClose={() => setRejecting(false)}
				/>
			)}
		</>
	)
}

/** End an approved plan early: its entries that still cover a deploy cover nothing from now on. */
export function PlanRevoke({ plan, onDone }: { plan: ApprovalPlanDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	return (
		<>
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>Revoke this plan</strong>
					Its entries stop covering a deploy now; a deploy of the change waits for a person.
				</div>
				<span className="spacer" />
				<button type="button" className="danger" onClick={() => setConfirming(true)}>
					Revoke
				</button>
			</div>
			{confirming && (
				<ConfirmDialog
					title="Revoke the plan"
					confirmLabel="Revoke"
					body={<p>Stop this plan covering a deploy of {plan.appId} · {plan.env}?</p>}
					onConfirm={async () => {
						await api.approvals.plans.revoke({ id: plan.id })
						onDone()
					}}
					onClose={() => setConfirming(false)}
				/>
			)}
		</>
	)
}
