import { createPage, Link } from '@buzola/router'
import { type ApprovalView, approvalView, type ChangeGroup, type ChangeRow, requesterPersonId, type SubjectRow } from '@fabrika/control-contract'
import { useState } from 'react'
import { AccessMapView } from '../../components/AccessMap'
import { CloserReview } from '../../components/CloserReview'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DecisionFailureNotice, StepUpHint } from '../../components/DecisionFailureNotice'
import { Icon, type IconName } from '../../components/Icon'
import { SearchField } from '../../components/SearchField'
import { Chip, RunStatus, Status } from '../../components/Status'
import { Table } from '../../components/Table'
import { Words } from '../../components/Words'
import {
	approvalStage,
	callerGroupPhrase,
	callerGroupTitle,
	changesWith,
	EFFECT_SECTIONS,
	type EffectSection,
	reviewReason,
	SUBJECT_TITLES,
	surfaceNotes,
} from '../../lib/access-changes'
import { type AccessChangeDto, api, type ApprovalDto, type DeployRequestDto, type SurfaceEndpointDto } from '../../lib/api'
import { type DecisionFailure, decisionFailure, postDecision } from '../../lib/decision-step-up'
import { changeWaits, requesterBlocks, requesterBlockText } from '../../lib/environment-protection'
import { fmtDate, shortRef, shortSha } from '../../lib/format'
import { consoleSession } from '../../lib/session'
import { browserCredentials, type PasskeyCredentials } from '../../lib/webauthn'

// One access change (ADR-0050 §7): who gains access first, grouped by caller, then what changes in data and runtime,
// built from the facts each line of the diff carries; every line stays one step away, and the decision follows.
// Approving binds the two digests shown here; a run classified again since refuses the decision.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [approval, session] = await Promise.all([api.approvals.get({ runId: params.id }), consoleSession()])
		return { approval, me: session.principal?.id ?? null }
	})
	.route('/approvals/:id')
	.render(({ data, invalidate }) => {
		const { approval } = data
		const { run } = approval
		const waiting = run.status === 'awaiting_approval'
		const view = approvalView(approval.changes)
		const stage = approvalStage(approval)

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
							<Status lamp={stage.lamp}>{stage.text}</Status>
							<RunStatus status={run.status} />
						</div>
					</div>
				</div>

				{approval.request !== undefined && <DeployRequestView request={approval.request} approval={approval} />}

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
							<Field label={approval.approval.holds ? 'Approved' : 'Approval lapsed'} wide>
								{approval.approval.label} · {fmtDate(approval.approval.approvedAt)}
							</Field>
						)}
					</div>
				</section>

				<AccessChangeView view={view} approval={approval} />

				{approval.accessMap !== undefined && approval.accessMap.roles.length > 0 && (
					<section>
						<div className="section-head">
							<Icon name="shield" size={15} />
							<h2>Access by role, after this change</h2>
						</div>
						<p className="hint">
							What each role may do once the run publishes: the actions it holds, the endpoints that require each one, and the tables and people they reach.
						</p>
						<AccessMapView map={approval.accessMap} />
					</section>
				)}

				{waiting && <Decision approval={approval} me={data.me} now={Math.floor(Date.now() / 1000)} onDone={invalidate} />}
			</>
		)
	})

/**
 * The change as the approver reads it: its impact, who gains access, what changes in data and runtime, and every line
 * one step away. A run classified before lines carried facts shows its lines in their effect sections.
 */
export function AccessChangeView({ view, approval }: { view: ApprovalView; approval: ApprovalDto }) {
	const endpoints = new Map(approval.endpoints.map((endpoint) => [endpoint.id, endpoint]))
	const crossOrigins = approval.crossOrigins
	// The framework's default limits, said once: a row says only the limits of its own.
	const defaults = approval.endpoints.flatMap(surfaceNotes).find((note) => note.default === true)
	return (
		<>
			{approval.changes.length > 0 && <Summary view={view} approval={approval} />}
			{view.callers.length > 0 && (
				<section>
					<div className="section-head">
						<Icon name="users" size={15} />
						<h2>Who gains access</h2>
					</div>
					<p className="hint">
						The endpoints this change touches, grouped by who reaches them, the group that needs the closest look first. A group that only narrows access or
						leaves it unchanged starts closed.
						{defaults !== undefined && (
							<>
								{' '}A row marked <em>default limits</em> <Words text={defaults.text} />.
							</>
						)}
					</p>
					{view.callers.map((group) => <GroupCard key={group.key} group={group} endpoints={endpoints} crossOrigins={crossOrigins} />)}
				</section>
			)}
			{view.data.length > 0 && (
				<section>
					<div className="section-head">
						<Icon name="schema" size={15} />
						<h2>Data and runtime</h2>
					</div>
					{view.data.map((group) => <GroupCard key={group.key} group={group} endpoints={endpoints} crossOrigins={crossOrigins} />)}
				</section>
			)}
			{view.unsorted.length > 0
				? <EffectSections changes={view.unsorted} crossOrigins={crossOrigins} />
				: <EveryLine changes={approval.changes} crossOrigins={crossOrigins} />}
		</>
	)
}

const REACH_ICONS: Record<string, IconName> = { anyone: 'globe', link: 'link', app: 'app', machine: 'key', human: 'users' }

/**
 * The head of the page, in plain words: what the change does to endpoints and to whom, what else it changes, whether it
 * waits, and the lines to check first, each with the reason it needs a closer look.
 */
function Summary({ view, approval }: { view: ApprovalView; approval: ApprovalDto }) {
	const { summary, impact } = view
	const reached = impact.callers.map((entry) => {
		const count = entry.endpoints + entry.removedEndpoints + entry.removedMounts
		return `${callerGroupPhrase(entry.reach, entry.mount, entry.people)} (${count})`
	})
	const others = view.data.map((group) => (group.kind === 'subject' ? SUBJECT_TITLES[group.subject].toLowerCase() : ''))
	const closer = summary.check.some((change) => change.review === 'closer')
	return (
		<section className="card change-summary">
			<div className="card-body">
				<p className="change-summary-lead">
					<Words text={endpointSentence(summary)} />
					{others.length > 0 && <>{' '}It also changes {andList(others)}.</>}
					{impact.migrations > 0 && (
						<>
							{' '}
							{impact.migrations === 1 ? '1 migration is' : `${impact.migrations} migrations are`} new or changed.
						</>
					)}
				</p>
				{reached.length > 0 && (
					<p>
						Who reaches the endpoints: <Words text={reached.join(', ')} />.
					</p>
				)}
				<p className="muted">{outcomeSentence(approval)}</p>
				{summary.check.length > 0 && (
					<div className="change-summary-check">
						<h3>Check first</h3>
						<ul className="change-lines">
							{summary.check.map((change, index) => {
								const reason = reviewReason(change)
								return (
									<li key={`${index}:${change.line}`} className={`change-${change.effect}`}>
										<Icon name={EFFECT_ICONS[change.effect]} size={13} />
										<span>
											<Words text={change.line} />
											{reason !== null && (
												<>
													{' '}
													<CloserReview />
													<span className="change-reason muted small">
														<Words text={reason} />
													</span>
												</>
											)}
										</span>
									</li>
								)
							})}
						</ul>
						{!closer && (
							<p className="muted small">
								Nothing in this change needs closer review: no step off the paved road, nothing anyone sets off without signing in, no people revealed.
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	)
}

/** `This change adds 1 endpoint and changes 2.`, `This change removes 3 endpoints.`, or that it touches none. */
function endpointSentence({ added, changed, removed }: ApprovalView['summary']): string {
	const counted = (count: number, verb: string) => (count === 0 ? [] : [`${verb} ${count} ${count === 1 ? 'endpoint' : 'endpoints'}`])
	const parts = [...counted(added, 'adds'), ...counted(changed, 'changes'), ...counted(removed, 'removes')]
	if (parts.length === 0) return 'This change touches no endpoint.'
	// The noun once: "adds 1 endpoint and changes 2".
	const [first, ...rest] = parts
	return `This change ${andList([first ?? '', ...rest.map((part) => part.replace(/ endpoints?$/, ''))])}.`
}

/**
 * Whether the change widens access, and what that means for this run. A run that waits, or that was approved, says so
 * whatever its lines need now: an earlier release parked every widening on a protected environment.
 */
function outcomeSentence(approval: ApprovalDto): string {
	const waits = changeWaits(approval)
	if (approval.request !== undefined) {
		const what = approval.outcome === 'widening' ? 'It widens access' : 'It only narrows access or leaves it unchanged'
		if (approval.run.status === 'awaiting_approval') return `${what}. An agent or a key asked for this deploy, so it waits for your approval.`
		return `${what}. An agent or a key asked for this deploy, so it waited for approval.`
	}
	const what = approval.outcome === 'widening' ? 'It widens access' : 'It only narrows access or leaves it unchanged'
	const closer = waits ? ', and a line needs approval on this environment' : ''
	if (approval.run.status === 'awaiting_approval') return `${what}${closer}, so it waits for your approval.`
	if (approval.approval !== null) return `${what}${closer}, so it waited for approval.`
	if (!waits) return `${what}, and nothing in it needs approval on this environment, so it publishes without waiting.`
	if (!approval.protected) return `${what}; this environment is not protected, so it publishes without waiting.`
	return `${what}, and a line needs approval on this environment.`
}

function andList(items: readonly string[]): string {
	if (items.length <= 1) return items.join('')
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** One group: a caller group's endpoints with what each requires and what stands in front of it, or one kind of subject. */
export function GroupCard(
	{ group, endpoints, crossOrigins }: {
		group: ChangeGroup
		endpoints: ReadonlyMap<string, SurfaceEndpointDto>
		crossOrigins: readonly string[] | undefined
	},
) {
	const callers = group.kind === 'caller'
	const title = callers ? callerGroupTitle(group.reach, group.mount, group.people) : SUBJECT_TITLES[group.subject]
	const { closer } = group.standing
	return (
		<details className="card change-group" open={!group.collapsed}>
			<summary className="card-head">
				<Icon name={callers ? (REACH_ICONS[group.reach] ?? 'users') : 'schema'} size={16} />
				<h3>
					<Words text={title} />
				</h3>
				<span className="muted small">{tallyText(group)}</span>
				{closer > 0 && (
					<span className="badge badge-warn">
						{closer === 1 ? (callers ? '1 endpoint needs' : '1 needs') : `${closer} ${callers ? 'endpoints ' : ''}need`} closer review, below
					</span>
				)}
			</summary>
			<div className="card-body flush">
				<Table
					colSpan={callers ? 4 : 2}
					head={
						<tr>
							<th>{callers ? 'Endpoint' : 'Subject'}</th>
							{callers && <th>Requires</th>}
							<th className="grow">Change</th>
							{callers && <th>In front of it</th>}
						</tr>
					}
				>
					{group.rows.map((row) => <GroupRow key={rowKey(row)} row={row} callers={callers} endpoints={endpoints} crossOrigins={crossOrigins} />)}
				</Table>
			</div>
		</details>
	)
}

function GroupRow(
	{ row, callers, endpoints, crossOrigins }: {
		row: ChangeRow
		callers: boolean
		endpoints: ReadonlyMap<string, SurfaceEndpointDto>
		crossOrigins: readonly string[] | undefined
	},
) {
	if (row.kind === 'folded') {
		return (
			<tr>
				<td colSpan={callers ? 4 : 2}>
					<details className="folded-row">
						<summary>
							<strong>{row.subjects.length}</strong> {callers ? 'endpoints' : 'subjects'} {foldedEffect(row)}:{' '}
							{row.rules.map((rule) => <code key={`${rule.rule} ${rule.effect}`}>{rule.rule}</code>)}
						</summary>
						<ul className="change-list">
							{row.subjects.map((subject) => (
								<li key={`${subject.subject.kind}:${subject.subject.name}`}>
									<SubjectName row={subject} />
									<ChangeLines changes={subject.changes} crossOrigins={crossOrigins} inRow={callers} />
								</li>
							))}
						</ul>
					</details>
				</td>
			</tr>
		)
	}
	// A removed mount may share an endpoint's name; only an endpoint has a surface row.
	const surface = row.subject.kind === 'endpoint' ? endpoints.get(row.subject.name) : undefined
	const requirement = row.audience?.requirement ?? null
	return (
		<tr>
			<td>
				<SubjectName row={row} />
			</td>
			{callers && <td>{requirement === null ? <span className="muted">nothing</span> : <Words text={requirement} />}</td>}
			<td>
				<ChangeLines changes={row.changes} crossOrigins={crossOrigins} inRow={callers} />
			</td>
			{callers && (
				<td>
					<InFrontOf surface={surface} changes={row.changes} />
				</td>
			)}
		</tr>
	)
}

/**
 * What stands in front of an endpoint, without what its lines already say and without the framework's default limits,
 * which the section says once.
 */
function InFrontOf({ surface, changes }: { surface: SurfaceEndpointDto | undefined; changes: readonly AccessChangeDto[] }) {
	if (surface === undefined) return <span className="muted">removed</span>
	const stated = new Set(changes.flatMap((change) => change.states ?? []))
	const unsaid = surfaceNotes(surface).filter((note) => note.topic === undefined || !stated.has(note.topic))
	const shown = unsaid.filter((note) => note.default !== true)
	const defaults = unsaid.some((note) => note.default === true)
	if (shown.length === 0) return <span className="muted">{defaults ? 'default limits' : '—'}</span>
	return (
		<>
			{shown.map((note, index) => (
				<span key={`${note.topic}:${note.text}`}>
					{index > 0 && ' · '}
					<Words text={note.text} />
				</span>
			))}
			{defaults && <span className="muted">{' · '}default limits</span>}
		</>
	)
}

/** An endpoint by its route with its id beneath; any other subject by its name. */
function SubjectName({ row }: { row: SubjectRow }) {
	const { subject } = row
	if (subject.method === undefined || subject.path === undefined) return <code>{subject.name}</code>
	return (
		<>
			<code>
				{subject.method} {subject.path}
			</code>
			<div className="muted small">{subject.name}</div>
		</>
	)
}

/**
 * One subject's lines, each with its effect, the closer-review mark and the reason for it. In a caller group's row,
 * which names the endpoint, its route and who reaches it already, a line says only the rest (`inRow`).
 */
function ChangeLines(
	{ changes, crossOrigins, inRow }: { changes: readonly AccessChangeDto[]; crossOrigins: readonly string[] | undefined; inRow: boolean },
) {
	return (
		<ul className="change-lines">
			{changes.map((change, index) => {
				const reason = reviewReason(change)
				return (
					// Two lines of one subject may read alike (two statements adopting one collection), so the place keys them.
					<li key={`${index}:${change.line}`} className={`change-${change.effect}`}>
						<Icon name={EFFECT_ICONS[change.effect]} size={13} />
						<span>
							<Words text={inRow ? (change.inRow ?? change.line) : change.line} />
							{change.environmentOrigins === true && crossOrigins !== undefined && <EnvironmentOrigins origins={crossOrigins} />}
							{reason !== null && (
								<>
									{' '}
									<CloserReview />
									<span className="change-reason muted small">
										<Words text={reason} />
									</span>
								</>
							)}
						</span>
					</li>
				)
			})}
		</ul>
	)
}

const EFFECT_ICONS: Record<AccessChangeDto['effect'], IconName> = { widens: 'alert', narrows: 'check', neutral: 'arrow-right' }

function rowKey(row: ChangeRow): string {
	return row.kind === 'subject'
		? `${row.subject.kind}:${row.subject.name}`
		: `folded:${row.rules.map((rule) => `${rule.rule} ${rule.effect}`).join('|')}`
}

/** What the heading counts, the rows of the group: `2 endpoints, both widen access`, `4 changes, none widens access`. */
function tallyText(group: ChangeGroup): string {
	const { subjects, widening } = group.standing
	const noun = group.kind === 'caller' ? (subjects === 1 ? 'endpoint' : 'endpoints') : subjects === 1 ? 'change' : 'changes'
	if (widening === 0) return `${subjects} ${noun}, none widens access`
	if (widening === subjects) return `${subjects} ${noun}, ${subjects === 1 ? 'it widens' : subjects === 2 ? 'both widen' : 'all widen'} access`
	return `${subjects} ${noun}, ${widening} ${widening === 1 ? 'widens' : 'widen'} access`
}

function foldedEffect(row: Extract<ChangeRow, { kind: 'folded' }>): string {
	const effects = new Set(row.rules.map((rule) => rule.effect))
	if (effects.size > 1) return 'that narrow access or leave it unchanged, alike'
	return effects.has('narrows') ? 'that only narrow access, alike' : 'that leave access unchanged, alike'
}

/** Every line of the change in its effect section, with a filter over the words: the same facts, unordered. */
function EveryLine({ changes, crossOrigins }: { changes: readonly AccessChangeDto[]; crossOrigins: readonly string[] | undefined }) {
	const [query, setQuery] = useState('')
	const words = query.trim().toLowerCase()
	const shown = words === '' ? changes : changes.filter((change) => change.line.toLowerCase().includes(words))
	return (
		<details className="every-line">
			<summary>
				Every line of the change <span className="muted">({changes.length})</span>
			</summary>
			<div className="filters">
				<SearchField label="Find a line" value={query} onChange={setQuery} placeholder="an endpoint, a table, an action" />
			</div>
			<EffectSections changes={shown} crossOrigins={crossOrigins} />
		</details>
	)
}

function EffectSections({ changes, crossOrigins }: { changes: readonly AccessChangeDto[]; crossOrigins: readonly string[] | undefined }) {
	return (
		<>
			{EFFECT_SECTIONS.map((section) => (
				<ChangeList
					key={section.effect}
					title={section.title}
					icon={section.icon}
					{...(section.hint === undefined ? {} : { hint: section.hint })}
					{...(crossOrigins === undefined ? {} : { crossOrigins })}
					changes={changesWith(changes, section.effect)}
				/>
			))}
		</>
	)
}

/**
 * One effect of the change; a line that steps off the paved road is marked for closer review. A line that opens an
 * endpoint to the environment's cross-origin list names the list as it stands, when the approval carries it.
 */
export function ChangeList(
	{ title, icon, hint, crossOrigins, changes }: {
		title: string
		icon: EffectSection['icon']
		hint?: string
		crossOrigins?: readonly string[]
		changes: readonly AccessChangeDto[]
	},
) {
	if (changes.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name={icon} size={15} />
				<h2>{title}</h2>
			</div>
			{hint !== undefined && <p className="hint">{hint}</p>}
			<ul className="change-list">
				{changes.map((change, index) => (
					<li key={`${index}:${change.line}`}>
						<Words text={change.line} />
						{change.environmentOrigins === true && crossOrigins !== undefined && <EnvironmentOrigins origins={crossOrigins} />}
						{change.review === 'closer' && (
							<>
								{' '}
								<CloserReview />
								{reviewReason(change) !== null && (
									<span className="change-reason muted small">
										<Words text={reviewReason(change) ?? ''} />
									</span>
								)}
							</>
						)}
					</li>
				))}
			</ul>
		</section>
	)
}

/**
 * The environment's cross-origin list beside the line that opens an endpoint to it. The list is the environment's: it
 * is set there, applies at once and is not part of this approval (ADR-0050).
 */
function EnvironmentOrigins({ origins }: { origins: readonly string[] }) {
	return (
		<span className="muted small" title="Set on the environment; a change applies at once and is not part of this approval.">
			{' '}
			({origins.length === 0 ? 'the environment lists none yet' : (
				<>
					the environment lists {origins.map((origin, index) => (
						<span key={origin}>
							{index > 0 && ', '}
							<code>{origin}</code>
						</span>
					))}
				</>
			)})
		</span>
	)
}

/**
 * Who asked for a deploy and what (ADR-0050 §4), read on a phone first: the person and the client, the commit with its
 * message and a compare with what runs now, and the deadline. The message and the client's id are the agent's text:
 * rendered as text, never as markup, and marked so.
 */
export function DeployRequestView({ request, approval }: { request: DeployRequestDto; approval: ApprovalDto }) {
	const { run } = approval
	const via = request.credential === 'oauth' ? 'through an agent' : 'with a key'
	return (
		<section className="card deploy-request">
			<div className="card-body">
				<p className="deploy-request-lead">
					<strong>{request.principal.label}</strong> asks {via} to deploy <code>{shortSha(request.commitSha)}</code> to <strong>{run.appId}</strong> ·{' '}
					<strong>{run.env}</strong>
					{request.runningCommitSha === null
						? ', which runs nothing yet.'
						: (
							<>
								, which runs <code>{shortSha(request.runningCommitSha)}</code>.
							</>
						)}
				</p>
				{request.clientId !== undefined && (
					<p className="small">
						Agent <span className="agent-text" title="Written by the agent, not by Fabrika">{request.clientId}</span>
					</p>
				)}
				{request.commitMessage !== null && (
					<figure className="agent-text-block">
						<figcaption className="muted small">Commit message, written by the agent</figcaption>
						<pre className="agent-text">{request.commitMessage}</pre>
					</figure>
				)}
				<p className="small">
					Commit <code>{request.commitSha}</code>
					{request.compareUrl !== null && (
						<>
							{' · '}
							<a href={request.compareUrl} target="_blank" rel="noreferrer noopener">Compare with what runs now</a>
						</>
					)}
				</p>
				{approval.deadline !== undefined && run.status === 'awaiting_approval' && (
					<p className="muted small">Decide by {fmtDate(approval.deadline)}; after that the request expires and deploys nothing.</p>
				)}
			</div>
		</section>
	)
}

/**
 * Approve (the page's one constructive step) or refuse. Only a person signed in to the console can do either. `me` is
 * the signed-in principal and `now` the time in unix seconds: past the deadline Control refuses both, and the first of
 * two approvers may refuse but not approve again.
 */
export function Decision({ approval, me, now, onDone, credentials = browserCredentials() }: {
	approval: ApprovalDto
	me: string | null
	now: number
	onDone: () => void
	credentials?: PasskeyCredentials | null
}) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<DecisionFailure | null>(null)
	const [rejecting, setRejecting] = useState(false)

	if (approval.deadline !== undefined && approval.deadline <= now) {
		return (
			<section>
				<p className="hint">
					Nobody decided this deploy before its deadline, {fmtDate(approval.deadline)}, so it expired and deploys nothing. A new deploy asks again.
				</p>
			</section>
		)
	}
	const approvedByMe = approval.partialApproval !== undefined && approval.partialApproval.principalId === me
	const blocked = approval.request === undefined
		? null
		: requesterBlocks(approval.requesterMayApprove, requesterPersonId(approval.request.principal), me)

	async function decide(decision: 'approve' | 'reject') {
		setBusy(true)
		setFailure(null)
		const item = { runId: approval.run.id, decision, candidateDigest: approval.candidateDigest, baselineDigest: approval.baselineDigest }
		try {
			await postDecision(
				approval.stepUp,
				credentials,
				() => api.approvals.challenge(item),
				async (stepUp) => {
					await api.approvals.complete(stepUp === undefined ? item : { ...item, stepUp })
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
				<p className="hint">
					Approving deploys this change to{' '}
					<strong>{approval.run.env}</strong>. It holds only for the lines above: if an older run publishes another change first, this one waits again, and
					once a newer run publishes, this one does not deploy.
				</p>
				{approval.approvers === 2 && (
					<p className="hint">
						{approval.partialApproval === undefined
							? 'Two different people approve this deploy: the first approval is recorded, and the second deploys it.'
							: `${approval.partialApproval.label} approved it ${fmtDate(approval.partialApproval.approvedAt)}; a second, different person deploys it.`}
					</p>
				)}
				<StepUpHint stepUp={approval.stepUp} item="deploy" />
				<div className="row-actions">
					{approvedByMe
						? <span className="muted decision-note">Waiting for a second person</span>
						: blocked !== null
						? <span className="muted decision-note">{requesterBlockText(blocked, 'deploy')}</span>
						: (
							<button type="button" className="primary" disabled={busy} onClick={() => void decide('approve')}>
								{busy ? 'Recording…' : 'Approve and deploy'}
							</button>
						)}
				</div>
				{failure !== null && <DecisionFailureNotice failure={failure} />}
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
