import { createPage, Link } from '@buzola/router'
import { type ApprovalView, approvalView, type ChangeGroup, type ChangeRow, type SubjectRow } from '@fabrika/control-contract'
import { useState } from 'react'
import { CloserReview } from '../../components/CloserReview'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon, type IconName } from '../../components/Icon'
import { SearchField } from '../../components/SearchField'
import { Chip, RunStatus, Status } from '../../components/Status'
import { Table } from '../../components/Table'
import {
	approvalStage,
	callerGroupTitle,
	changesWith,
	EFFECT_SECTIONS,
	type EffectSection,
	reviewReason,
	SUBJECT_TITLES,
} from '../../lib/access-changes'
import { type AccessChangeDto, api, ApiError, type ApprovalDto, type SurfaceEndpointDto } from '../../lib/api'
import { fmtDate, shortRef, shortSha } from '../../lib/format'

// One access change (ADR-0050 §7): who gains access first, grouped by caller, then what changes in data and runtime,
// built from the facts each line of the diff carries; every line stays one step away, and the decision follows.
// Approving binds the two digests shown here; a run classified again since refuses the decision.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ approval: await api.approvals.get({ runId: params.id }) }))
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

				{waiting && <Decision approval={approval} onDone={invalidate} />}
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
	return (
		<>
			{view.impact.callers.length + view.impact.migrations > 0 && <Impact view={view} />}
			{view.callers.length > 0 && (
				<section>
					<div className="section-head">
						<Icon name="users" size={15} />
						<h2>Who gains access</h2>
					</div>
					<p className="hint">
						The endpoints this change touches, grouped by who reaches them, the group that needs the closest look first. A group that only narrows access or
						leaves it unchanged starts closed.
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

/** The head of the page: per caller group the endpoints that change, and the migrations. */
function Impact({ view }: { view: ApprovalView }) {
	const closerIn = (key: string) => view.callers.find((group) => group.key === key)?.tally.closer ?? 0
	return (
		<section className="instrument-cluster readings change-impact">
			{view.impact.callers.map((entry) => (
				<div key={entry.key} className="instrument">
					<div className="instrument-label">
						<Words text={callerGroupTitle(entry.reach, entry.mount)} />
					</div>
					<div className="instrument-value">{entry.endpoints + entry.removedEndpoints + entry.removedMounts}</div>
					<div className="instrument-note">
						{reachedThings(entry)}
						{closerIn(entry.key) > 0 && (
							<>
								{', '}
								<span className="badge badge-warn">
									{closerIn(entry.key)} {closerIn(entry.key) === 1 ? 'line' : 'lines'} for closer review
								</span>
							</>
						)}
					</div>
				</div>
			))}
			{view.impact.migrations > 0 && (
				<div className="instrument">
					<div className="instrument-label">Migrations</div>
					<div className="instrument-value">{view.impact.migrations}</div>
					<div className="instrument-note">new or changed</div>
				</div>
			)}
		</section>
	)
}

/** `endpoints`, or `2 endpoints, 1 removed mount` when the group holds removals too. */
function reachedThings(entry: ApprovalView['impact']['callers'][number]): string {
	const { endpoints, removedEndpoints, removedMounts } = entry
	if (removedEndpoints + removedMounts === 0) return endpoints === 1 ? 'endpoint' : 'endpoints'
	const counted: [number, string, string][] = [
		[endpoints, 'endpoint', 'endpoints'],
		[removedEndpoints, 'removed endpoint', 'removed endpoints'],
		[removedMounts, 'removed mount', 'removed mounts'],
	]
	return counted.flatMap(([count, one, many]) => (count === 0 ? [] : [`${count} ${count === 1 ? one : many}`])).join(', ')
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
	const title = callers ? callerGroupTitle(group.reach, group.mount) : SUBJECT_TITLES[group.subject]
	return (
		<details className="card change-group" open={!group.collapsed}>
			<summary className="card-head">
				<Icon name={callers ? (REACH_ICONS[group.reach] ?? 'users') : 'schema'} size={16} />
				<h3>
					<Words text={title} />
				</h3>
				<span className="muted small">{tallyText(group)}</span>
				<span className="spacer" />
				{group.tally.closer > 0 && <CloserReview />}
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
									<ChangeLines changes={subject.changes} crossOrigins={crossOrigins} />
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
	return (
		<tr>
			<td>
				<SubjectName row={row} />
			</td>
			{callers && <td>{row.audience?.requirement ?? <span className="muted">nothing</span>}</td>}
			<td>
				<ChangeLines changes={row.changes} crossOrigins={crossOrigins} />
			</td>
			{callers && (
				<td>
					{surface === undefined || surface.notes.length === 0
						? <span className="muted">{surface === undefined ? 'removed' : 'nothing listed'}</span>
						: surface.notes.join(' · ')}
				</td>
			)}
		</tr>
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

/** One subject's lines, each with its effect, the closer-review mark and the reason for it. */
function ChangeLines({ changes, crossOrigins }: { changes: readonly AccessChangeDto[]; crossOrigins: readonly string[] | undefined }) {
	return (
		<ul className="change-lines">
			{changes.map((change, index) => {
				const reason = reviewReason(change)
				return (
					// Two lines of one subject may read alike (two statements adopting one collection), so the place keys them.
					<li key={`${index}:${change.line}`} className={`change-${change.effect}`}>
						<Icon name={EFFECT_ICONS[change.effect]} size={13} />
						<span>
							<Words text={change.line} />
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

/** A line's words with each `name` set as code, the way the diff quotes identifiers. */
export function Words({ text }: { text: string }) {
	const parts = text.split('`')
	// An odd count of backticks leaves the last one open: show the text as it is.
	if (parts.length % 2 === 0) return <>{text}</>
	return <>{parts.map((part, index) => (index % 2 === 1 ? <code key={`${index}:${part}`}>{part}</code> : part))}</>
}

const EFFECT_ICONS: Record<AccessChangeDto['effect'], IconName> = { widens: 'alert', narrows: 'check', neutral: 'arrow-right' }

function rowKey(row: ChangeRow): string {
	return row.kind === 'subject'
		? `${row.subject.kind}:${row.subject.name}`
		: `folded:${row.rules.map((rule) => `${rule.rule} ${rule.effect}`).join('|')}`
}

/** `2 widen · 1 for closer review · 40 narrow`, leaving out what the group does not have. */
function tallyText(group: ChangeGroup): string {
	const { widens, narrows, neutral } = group.tally
	return [
		widens > 0 ? `${widens} ${widens === 1 ? 'widens' : 'widen'}` : '',
		narrows > 0 ? `${narrows} ${narrows === 1 ? 'narrows' : 'narrow'}` : '',
		neutral > 0 ? `${neutral} unchanged` : '',
	].filter((part) => part !== '').join(' · ')
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
						{change.line}
						{change.environmentOrigins === true && crossOrigins !== undefined && <EnvironmentOrigins origins={crossOrigins} />}
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
