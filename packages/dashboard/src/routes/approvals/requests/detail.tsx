import { createPage, Link } from '@buzola/router'
import { ACTION_CATEGORIES, ALL_ENVIRONMENTS, type ApprovalRequestState, isFinalApprovalRequestState } from '@fabrika/control-contract'
import { useState } from 'react'
import { roleSummary } from '../../../components/AccessMap'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { DecisionFailureNotice, StepUpHint } from '../../../components/DecisionFailureNotice'
import { Icon } from '../../../components/Icon'
import { Chip, type Lamp, Status } from '../../../components/Status'
import { type AccessMapRoleDto, api, type ApprovalRequestDto, type ApprovalRequestText } from '../../../lib/api'
import { type DecisionFailure, decisionFailure, postDecision } from '../../../lib/decision-step-up'
import { categoryLabel, requesterBlocks, requesterBlockText } from '../../../lib/environment-protection'
import { fmtDate } from '../../../lib/format'
import { consoleSession } from '../../../lib/session'
import { browserCredentials, type PasskeyCredentials } from '../../../lib/webauthn'

// One approval request (ADR-0083 §8), mobile-first: who asks, through which client or key, exactly what its kind says
// it does, where and by when, and the decision. Text the agent wrote is escaped (React renders it as text) and marked
// as the agent's. Approving posts the input digest shown here; a request that is not the one shown refuses it.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [request, session] = await Promise.all([api.approvals.requests.get({ id: params.id }), consoleSession()])
		return { request, me: session.principal?.id ?? null }
	})
	.route('/approvals/requests/:id')
	.render(({ data, invalidate }) => {
		const { request } = data
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
								Request for <Link to="apps/detail" params={{ id: request.appId }}>{request.appId}</Link>
							</h1>
							<div className="subtitle">
								<Chip>{requestEnvLabel(request.env)}</Chip>
								<span className="dot-sep">{requestCategoryLabel(request.category)}</span>
							</div>
						</div>
						<div className="row-actions">
							<Status lamp={requestLamp(request.state)}>{REQUEST_STATE_TEXT[request.state]}</Status>
						</div>
					</div>
				</div>
				<ApprovalRequestView request={request} />
				<RequestOutcome request={request} />
				{request.state === 'pending' && <RequestDecision request={request} me={data.me} now={Math.floor(Date.now() / 1000)} onDone={invalidate} />}
			</>
		)
	})

export const REQUEST_STATE_TEXT: Readonly<Record<ApprovalRequestState, string>> = {
	pending: 'Waiting for a decision',
	approved: 'Approved',
	rejected: 'Refused',
	expired: 'Expired',
	executing: 'Executing',
	executed: 'Done',
	failed: 'Failed',
	unknown: 'Outcome unknown',
	stale: 'Out of date',
}

function requestLamp(state: ApprovalRequestState): Lamp {
	switch (state) {
		case 'executed':
			return 'ok'
		case 'approved':
		case 'executing':
		case 'unknown':
			return 'run'
		case 'rejected':
		case 'expired':
		case 'failed':
		case 'stale':
			return 'stop'
		case 'pending':
			return 'idle'
	}
}

/** Where a request acts: its environment, or every environment of the application (`ALL_ENVIRONMENTS`). */
export function requestEnvLabel(env: string): string {
	return env === ALL_ENVIRONMENTS ? 'every environment' : env
}

/** A category's label in the console's words; a category a later release added reads as its name. */
export function requestCategoryLabel(category: string): string {
	const known = ACTION_CATEGORIES.find((action) => action === category)
	return known === undefined ? category : categoryLabel(known)
}

/** One piece of the request's text: the agent's own is set apart and says so; a time is formatted as the page's other dates. */
function Text({ part }: { part: ApprovalRequestText }) {
	const text = part.at === undefined ? part.text : fmtDate(part.at)
	return part.agent ? <span className="agent-text" title="Written by the agent, not by Fabrika">{text}</span> : <>{text}</>
}

/** The kind's one-sentence summary of what approving does. */
export function RequestSummary({ request }: { request: ApprovalRequestDto }) {
	return <>{request.description.summary.map((part, index) => <Text key={index} part={part} />)}</>
}

/** Who asks, through what, for what, where and by when. */
export function ApprovalRequestView({ request }: { request: ApprovalRequestDto }) {
	const { requester, description } = request
	const via = requester.credential === 'oauth' ? 'through an agent' : requester.principal.type === 'service' ? 'with a service key' : 'with a key'
	return (
		<section className="card deploy-request">
			<div className="card-body">
				<p className="deploy-request-lead">
					<strong>{requester.principal.label}</strong> asks {via}: <RequestSummary request={request} />
				</p>
				{requester.clientId !== undefined && (
					<p className="small">
						Agent <span className="agent-text" title="Written by the agent, not by Fabrika">{requester.clientId}</span>
					</p>
				)}
				{description.role !== undefined && <RequestedRole role={description.role} />}
				{description.facts.length > 0 && (
					<dl className="request-facts">
						{description.facts.map((fact, index) => (
							<div key={index}>
								<dt className="muted small">{fact.label}</dt>
								<dd>
									<Text part={fact.value} />
								</dd>
							</div>
						))}
					</dl>
				)}
				<p className="small">
					<strong>{request.appId}</strong> · <strong>{requestEnvLabel(request.env)}</strong> · asked {fmtDate(request.createdAt)}
				</p>
				{request.state === 'pending' && (
					<p className="muted small">Decide by {fmtDate(request.deadline)}; after that the request expires and changes nothing.</p>
				)}
				{request.decision !== undefined && (
					<p className="small">
						{request.state === 'rejected' ? 'Refused' : 'Approved'} by {request.decision.label} · {fmtDate(request.decision.at)}
					</p>
				)}
			</div>
		</section>
	)
}

/** The role a grant gives, summarized as the access map summarizes it, with every action it holds. */
function RequestedRole({ role }: { role: AccessMapRoleDto }) {
	const held = [...role.actions, ...role.via.flatMap((via) => via.actions.map((action) => `${action} through ${via.relation}`))]
	return (
		<div className="request-role">
			<p>
				<Chip>{role.role}</Chip> <span className="small">{roleSummary(role)}</span>
			</p>
			{held.length > 0 && <p className="muted small">{held.join(', ')}</p>}
		</div>
	)
}

/** IAM's own grant request an agent's approved grant became, where the application's grants wait (ADR-0083 §4). */
function grantRequestOf(result: ApprovalRequestDto['result']): string | null {
	const linked = typeof result === 'object' && result !== null && !Array.isArray(result) ? result['grantRequest'] : undefined
	const id = typeof linked === 'object' && linked !== null && !Array.isArray(linked) ? linked['id'] : undefined
	return typeof id === 'string' ? id : null
}

/** What happened once a person decided: the result, or why it did not run. */
export function RequestOutcome({ request }: { request: ApprovalRequestDto }) {
	if (request.state === 'pending' || request.state === 'rejected') return null
	if (request.state === 'expired') {
		return <p className="hint">Nobody decided this request before {fmtDate(request.deadline)}, so it expired and changed nothing.</p>
	}
	const heldByIam = request.state === 'executed' && grantRequestOf(request.result) !== null
	return (
		<section>
			{request.state === 'executed' && !heldByIam && <p className="hint">It was done.</p>}
			{heldByIam && (
				<p className="hint">
					The application's grants wait for approval, so IAM holds this grant until another administrator of the application approves it under{' '}
					<Link to="approvals">Approvals</Link>; nothing is granted until then.
				</p>
			)}
			{(request.state === 'approved' || request.state === 'executing') && <p className="hint">It is being carried out.</p>}
			{request.state === 'unknown' && <p className="hint">Control did not see how it ended and follows it; this page shows the outcome once known.</p>}
			{request.state === 'stale' && <p className="hint">It was not carried out; the agent asks again.</p>}
			{request.error !== undefined && <p className={request.state === 'unknown' ? 'muted' : 'error-text'}>{request.error}</p>}
			{request.result !== undefined && <pre className="request-result">{JSON.stringify(request.result, null, 2)}</pre>}
			{isFinalApprovalRequestState(request.state) && request.operationId !== undefined && (
				<p className="muted small">
					Operation <code>{request.operationId}</code>
				</p>
			)}
		</section>
	)
}

/**
 * Approve or refuse a pending request. `me` is the signed-in principal and `now` the time in unix seconds: past the
 * deadline Control refuses both; the first of two approvers waits for a second person; the requester's own person may
 * only refuse where the environment says so; a request this Control cannot describe may only be refused.
 */
export function RequestDecision({ request, me, now, onDone, credentials = browserCredentials() }: {
	request: ApprovalRequestDto
	me: string | null
	now: number
	onDone: () => void
	credentials?: PasskeyCredentials | null
}) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<DecisionFailure | null>(null)
	const [rejecting, setRejecting] = useState(false)

	if (request.deadline <= now) {
		return <p className="hint">Nobody decided this request before {fmtDate(request.deadline)}, so it expired and changes nothing.</p>
	}
	const approvedByMe = request.partialApproval !== undefined && request.partialApproval.principalId === me
	const blocked = requesterBlocks(request.requesterMayApprove, request.requester.personId, me)

	async function decide(decision: 'approve' | 'reject') {
		setBusy(true)
		setFailure(null)
		const item = { id: request.id, decision, inputDigest: request.inputDigest }
		try {
			await postDecision(
				request.stepUp,
				credentials,
				() => api.approvals.requests.challenge(item),
				async (stepUp) => {
					await api.approvals.requests.decide(stepUp === undefined ? item : { ...item, stepUp })
				},
				'decision',
			)
			onDone()
		} catch (cause) {
			setFailure(decisionFailure(cause))
			setBusy(false)
		}
	}

	return (
		<>
			<section>
				{request.described && <p className="hint">Approving carries it out now, as you, with the requester recorded beside you.</p>}
				{request.described && request.approvers === 2 && (
					<p className="hint">
						{request.partialApproval === undefined
							? 'Two different people approve this request: the first approval is recorded, and the second carries it out.'
							: `${request.partialApproval.label} approved it ${fmtDate(request.partialApproval.at)}; a second, different person carries it out.`}
					</p>
				)}
				<StepUpHint stepUp={request.stepUp} item="request" />
				<div className="row-actions">
					{!request.described
						? <span className="muted decision-note">This Control cannot show what the request does, so it cannot be approved here.</span>
						: approvedByMe
						? <span className="muted decision-note">Waiting for a second person</span>
						: blocked !== null
						? <span className="muted decision-note">{requesterBlockText(blocked, 'request')}</span>
						: (
							<button type="button" className="primary" disabled={busy} onClick={() => void decide('approve')}>
								{busy ? 'Recording…' : 'Approve'}
							</button>
						)}
				</div>
				{failure !== null && <DecisionFailureNotice failure={failure} />}
			</section>
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>Refuse this request</strong>
					Nothing changes. The agent may ask again.
				</div>
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy} onClick={() => setRejecting(true)}>
					Refuse
				</button>
			</div>
			{rejecting && (
				<ConfirmDialog
					title="Refuse the request"
					confirmLabel="Refuse"
					body={<p>Refuse this request? Nothing it asks for happens.</p>}
					onConfirm={() => decide('reject')}
					onClose={() => setRejecting(false)}
				/>
			)}
		</>
	)
}
