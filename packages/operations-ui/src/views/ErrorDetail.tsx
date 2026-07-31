import { Link } from '@buzola/router'
import type { ActivityItem, DisplayFrame, EventDetail } from '@fabrika/operations-contract'
import type {
	OperationsAssigneeListResponseDto,
	OperationsEventDetailResponseDto,
	OperationsIssueDetailDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueOccurrenceDto,
	OperationsIssueOccurrenceListResponseDto,
	OperationsIssueSummaryDto,
	OperationsReleaseSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import { type ReactNode, useEffect, useState } from 'react'
import { formatTimestamp, relativeSeen } from '../format'

export interface ErrorDetailViewProps {
	issue: OperationsIssueDetailDto
	initialEvent: OperationsEventDetailResponseDto | null
	assignees: OperationsAssigneeListResponseDto['items']
	releases: readonly OperationsReleaseSummaryDto[]
	onSelectOccurrence?: (occurrenceId: string) => Promise<OperationsEventDetailResponseDto>
	onLoadOccurrences?: (cursor: string) => Promise<OperationsIssueOccurrenceListResponseDto>
	onFindMergeTargets?: (query: string) => Promise<OperationsIssueSummaryDto[]>
	onMutate?: (mutation: OperationsIssueMutationRequestDto) => Promise<void>
}

export function frameLocation(frame: DisplayFrame): string {
	const position = [frame.line, frame.column].filter((part): part is number => part !== null).join(':')
	return position === '' ? frame.file : `${frame.file}:${position}`
}

export function activityPayloadLabel(item: ActivityItem): string | null {
	const data = item.data
	if (data === null) return null
	const { text, to, toId, until: untilValue, release: releaseValue, count: countValue, into, from } = data
	if (item.kind === 'comment') return stringValue(text)
	if (item.kind === 'assigned') {
		const assignee = stringValue(to) ?? stringValue(toId)
		return assignee === null ? 'Unassigned' : `Assigned to ${assignee}`
	}
	if (item.kind === 'snoozed') {
		const until = numberValue(untilValue)
		if (until !== null) return `Snoozed until ${formatTimestamp(until)}`
		const release = stringValue(releaseValue)
		if (release !== null) return `Resolved in release ${release}`
		const count = numberValue(countValue)
		if (count !== null) return `Snoozed for ${count} additional events`
		return null
	}
	if (item.kind === 'merged') {
		const target = stringValue(into)
		return target === null ? null : `Merged into ${target}`
	}
	if (item.kind === 'status') {
		const previous = stringValue(from)
		const next = stringValue(to)
		return previous === null || next === null ? null : `${previous} to ${next}`
	}
	return null
}

export function ErrorDetailView({
	issue,
	initialEvent,
	assignees,
	releases,
	onSelectOccurrence,
	onLoadOccurrences,
	onFindMergeTargets,
	onMutate,
}: ErrorDetailViewProps) {
	const [comment, setComment] = useState('')
	const [assignee, setAssignee] = useState(issue.assignedTo?.id ?? '')
	const [mergeTarget, setMergeTarget] = useState('')
	const [mergeQuery, setMergeQuery] = useState('')
	const [mergeTargets, setMergeTargets] = useState<OperationsIssueSummaryDto[]>([])
	const [releaseId, setReleaseId] = useState(issue.resolvedInRelease?.id ?? '')
	const [event, setEvent] = useState(initialEvent)
	const [occurrences, setOccurrences] = useState<OperationsIssueOccurrenceDto[]>(issue.occurrences)
	const [occurrencesCursor, setOccurrencesCursor] = useState(issue.occurrencesNextCursor)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setEvent(initialEvent)
		setOccurrences(issue.occurrences)
		setOccurrencesCursor(issue.occurrencesNextCursor)
	}, [initialEvent, issue.occurrences, issue.occurrencesNextCursor])

	async function mutate(mutation: OperationsIssueMutationRequestDto): Promise<boolean> {
		if (onMutate === undefined) return false
		setBusy(true)
		setError(null)
		try {
			await onMutate(mutation)
			return true
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The issue could not be changed.')
			return false
		} finally {
			setBusy(false)
		}
	}

	async function selectOccurrence(occurrenceId: string) {
		if (onSelectOccurrence === undefined || occurrenceId === event?.occurrenceId) return
		setBusy(true)
		setError(null)
		try {
			setEvent(await onSelectOccurrence(occurrenceId))
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The occurrence could not be loaded.')
		} finally {
			setBusy(false)
		}
	}

	async function loadOlderOccurrences() {
		if (onLoadOccurrences === undefined || occurrencesCursor === null) return
		setBusy(true)
		setError(null)
		try {
			const next = await onLoadOccurrences(occurrencesCursor)
			setOccurrences((current) => [...current, ...next.items])
			setOccurrencesCursor(next.nextCursor)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Older occurrences could not be loaded.')
		} finally {
			setBusy(false)
		}
	}

	async function findMergeTargets() {
		if (onFindMergeTargets === undefined) return
		setBusy(true)
		setError(null)
		try {
			const candidates = await onFindMergeTargets(mergeQuery.trim())
			setMergeTargets(candidates)
			setMergeTarget(candidates[0]?.id ?? '')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Merge targets could not be loaded.')
		} finally {
			setBusy(false)
		}
	}

	const eventDetail = event?.detail ?? null

	return (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<div>
						<p className="eyebrow">
							{issue.source.appId} · {issue.source.environment} · {issue.source.serviceKey}
						</p>
						<h1>{issue.title}</h1>
						<p className="hint">{issue.culprit ?? 'No culprit was reported.'}</p>
					</div>
					<span
						className={`status status-${issue.status === 'open' ? 'stop' : issue.status === 'resolved' ? 'ok' : 'idle'}`}
						data-testid="issue-status"
						data-status={issue.status}
					>
						<span className="lamp" aria-hidden="true" />
						{issue.regressedAt !== null && issue.status === 'open' ? 'regressed' : issue.status}
					</span>
				</div>
			</div>

			<div className="detail-grid">
				<Fact label="Events" value={issue.count.toLocaleString()} />
				<Fact label="First seen" value={formatTimestamp(issue.firstSeen)} />
				<Fact label="Last seen" value={relativeSeen(issue.lastSeen)} />
				<Fact label="Assigned to" value={issue.assignedTo?.label ?? issue.assignedTo?.id ?? 'Unassigned'} />
				<Fact label="Release" value={issue.latestOccurrence?.release ?? '—'} />
				<Fact
					label="Resolved in release"
					value={issue.resolvedInRelease === null
						? '—'
						: (
							<Link to="operations/releases/detail" params={{ releaseId: issue.resolvedInRelease.id }}>
								{issue.resolvedInRelease.name}
							</Link>
						)}
				/>
				<Fact label="Environment" value={eventDetail?.environment ?? '—'} />
			</div>

			<section>
				<div className="section-head">
					<h2>Occurrences</h2>
				</div>
				{occurrences.length > 0 && (
					<div className="form-row">
						<label>
							Occurrence
							<select value={event?.occurrenceId ?? ''} disabled={busy} onChange={(change) => void selectOccurrence(change.target.value)}>
								{occurrences.map((occurrence) => (
									<option key={occurrence.id} value={occurrence.id}>{formatTimestamp(occurrence.receivedAt)} · {occurrence.release ?? 'no release'}</option>
								))}
							</select>
						</label>
						{occurrencesCursor !== null && (
							<button type="button" disabled={busy} onClick={() => void loadOlderOccurrences()}>Load older occurrences</button>
						)}
					</div>
				)}
				{eventDetail === null
					? <p className="section-note">No event context was retained for this issue.</p>
					: (
						<div className="ops-occurrence">
							<div className="ops-trace-line">
								<span>
									<strong>{eventDetail.request?.method ?? 'event'}</strong> {eventDetail.request?.url ?? eventDetail.platform ?? 'unknown origin'}
								</span>
								<span>{eventDetail.runtime ?? 'unknown runtime'}{eventDetail.os === null ? '' : ` · ${eventDetail.os}`}</span>
							</div>
							{eventDetail.exceptions.map((exception, exceptionIndex) => (
								<div className="ops-exception" key={`${exception.type ?? 'exception'}:${exceptionIndex}`}>
									<h3>
										{exceptionIndex === 0 ? 'Exception' : `Caused by ${exception.type ?? 'exception'}`}:{' '}
										{[exception.type, exception.value].filter(Boolean).join(': ') || issue.title}
									</h3>
									<div className="ops-stack" data-testid="stack-frames" data-exception-index={exceptionIndex}>
										{exception.frames.map((frame, frameIndex) => (
											<div
												className={`ops-frame${frame.inApp ? ' in-app' : ''}`}
												key={`${frameLocation(frame)}:${frameIndex}`}
												data-testid="stack-frame"
												data-frame-index={frameIndex}
												data-frame-file={frame.file}
												data-frame-in-app={frame.inApp}
												data-frame-resolved={frame.resolved}
											>
												<div>
													<strong>{frame.function ?? '(anonymous)'}</strong>
													<code data-testid="frame-location">{frameLocation(frame)}</code>
												</div>
												<FrameSource frame={frame} />
											</div>
										))}
									</div>
								</div>
							))}
							<EventContext event={eventDetail} />
						</div>
					)}
			</section>

			<div className="board">
				<section className="card">
					<div className="card-head">
						<h2>Triage</h2>
					</div>
					<div className="card-body">
						{onMutate === undefined
							? <p className="hint">Triage actions are read-only in this context.</p>
							: (
								<div className="ops-triage">
									{error && <p className="error-text" role="alert">{error}</p>}
									<div className="form-row">
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'status', status: 'resolved' })}>Resolve</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'status', status: 'ignored' })}>Ignore</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'snooze_until', until: Date.now() + 24 * 60 * 60 * 1000 })}>
											Snooze 24 h
										</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'snooze_until', until: Date.now() + 7 * 24 * 60 * 60 * 1000 })}>
											Snooze 7 d
										</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'snooze_count', additional: 10 })}>Snooze 10 events</button>
									</div>
									<label>
										Assignee
										<div className="ops-inline-action">
											<select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
												<option value="">Unassigned</option>
												{assignees.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
											</select>
											<button type="button" disabled={busy} onClick={() => mutate({ kind: 'assign', principalId: assignee || null })}>
												Assign
											</button>
										</div>
									</label>
									<label>
										Comment
										<textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} />
									</label>
									<button
										type="button"
										disabled={busy || comment.trim() === ''}
										onClick={async () => {
											if (await mutate({ kind: 'comment', text: comment.trim() })) setComment('')
										}}
									>
										Add comment
									</button>
									<label>
										Resolve in release
										<div className="ops-inline-action">
											<select value={releaseId} onChange={(event) => setReleaseId(event.target.value)}>
												<option value="">Clear release</option>
												{releases.map((release) => <option key={release.id} value={release.id}>{release.releaseName}</option>)}
											</select>
											<button
												type="button"
												disabled={busy}
												onClick={() => mutate({ kind: 'resolve_in_release', releaseId: releaseId || null })}
											>
												Apply
											</button>
										</div>
									</label>
									<label>
										Merge into issue
										<div className="ops-inline-action">
											<input value={mergeQuery} onChange={(event) => setMergeQuery(event.target.value)} placeholder="Search issue title or culprit" />
											<button type="button" disabled={busy || onFindMergeTargets === undefined} onClick={() => void findMergeTargets()}>Find</button>
										</div>
										{mergeTargets.length > 0 && (
											<div className="ops-inline-action">
												<select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)} aria-label="Merge target">
													{mergeTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.count} events</option>)}
												</select>
												<button
													type="button"
													disabled={busy || mergeTarget === ''}
													onClick={() => mutate({ kind: 'merge', targetIssueId: mergeTarget })}
												>
													Merge
												</button>
											</div>
										)}
									</label>
								</div>
							)}
					</div>
				</section>

				<section className="card">
					<div className="card-head">
						<h2>Activity</h2>
					</div>
					<div className="card-body flush">
						{issue.activity.length === 0
							? (
								<div className="empty-state">
									<strong className="empty-title">No triage activity</strong>
								</div>
							)
							: (
								<div className="feed">
									{issue.activity.map((item) => <ActivityEntry item={item} key={item.id} />)}
								</div>
							)}
					</div>
				</section>
			</div>
		</>
	)
}

function FrameSource({ frame }: { frame: DisplayFrame }) {
	const source = frame.source
	if (source === undefined) return null
	return (
		<pre className="ops-source" data-testid="frame-source">
			{source.lines.map((line, lineIndex) => (
				<span className={lineIndex === source.errorIndex ? 'error-line' : ''} key={source.startLine + lineIndex}>
					<b>{source.startLine + lineIndex}</b> {line}
				</span>
			))}
		</pre>
	)
}

function EventContext({ event }: { event: EventDetail }) {
	return (
		<div className="ops-context-grid">
			<section className="card">
				<div className="card-head">
					<h3>Breadcrumbs</h3>
				</div>
				<div className="card-body flush">
					{event.breadcrumbs.length === 0
						? (
							<div className="empty-state">
								<span className="empty-body">None reported</span>
							</div>
						)
						: (
							<div className="feed">
								{event.breadcrumbs.map((breadcrumb, index) => (
									<div className="feed-row" key={`${breadcrumb.timestamp ?? 'none'}:${index}`}>
										<span className="feed-main">
											<strong className="feed-title">{breadcrumb.message ?? breadcrumb.category ?? breadcrumb.type ?? 'event'}</strong>
											<span className="feed-meta">{breadcrumb.level ?? 'info'}</span>
										</span>
										<span className="feed-side">{breadcrumb.timestamp ?? ''}</span>
									</div>
								))}
							</div>
						)}
				</div>
			</section>
			<section className="card">
				<div className="card-head">
					<h3>Event context</h3>
				</div>
				<div className="card-body">
					<div className="detail-grid">
						<Fact label="Trace" value={event.traceId ?? '—'} />
						<Fact label="Server" value={event.serverName ?? '—'} />
						<Fact label="User" value={event.user?.email ?? event.user?.username ?? event.user?.id ?? '—'} />
						<Fact label="Event ID" value={event.eventId ?? '—'} />
					</div>
					<details className="ops-raw">
						<summary>Raw event</summary>
						<pre>{event.rawEvent}</pre>
					</details>
				</div>
			</section>
			<section className="card">
				<div className="card-head">
					<h3>Tags</h3>
				</div>
				<div className="card-body flush">
					{event.tags.length === 0
						? (
							<div className="empty-state">
								<span className="empty-body">None reported</span>
							</div>
						)
						: (
							<div className="feed">
								{event.tags.map((tag) => (
									<div className="feed-row" key={tag.key}>
										<strong className="feed-title">{tag.key}</strong>
										<code>{tag.value}</code>
									</div>
								))}
							</div>
						)}
				</div>
			</section>
		</div>
	)
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null
}

function numberValue(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function ActivityEntry({ item }: { item: ActivityItem }) {
	const payload = activityPayloadLabel(item)
	return (
		<div className="feed-row" data-testid="activity-entry" data-activity-kind={item.kind}>
			<span className="feed-main">
				<strong className="feed-title">{item.kind}</strong>
				{payload !== null && <span className="feed-meta" data-testid="activity-payload">{payload}</span>}
				<span className="feed-meta">{item.actorLabel ?? 'System'}</span>
			</span>
			<span className="feed-side">{relativeSeen(item.at)}</span>
		</div>
	)
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}
