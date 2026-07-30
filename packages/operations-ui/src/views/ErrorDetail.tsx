import type { ActivityItem, DisplayFrame, EventDetail, IssueListItem, IssueMutation } from '@fabrika/operations-contract'
import { useState } from 'react'
import { formatTimestamp, relativeSeen } from '../format'

export interface ErrorDetailViewProps {
	issue: IssueListItem
	event: EventDetail | null
	activity: readonly ActivityItem[]
	onMutate?: (mutation: IssueMutation) => Promise<void>
}

export function frameLocation(frame: DisplayFrame): string {
	const position = [frame.line, frame.column].filter((part): part is number => part !== null).join(':')
	return position === '' ? frame.file : `${frame.file}:${position}`
}

export function ErrorDetailView({ issue, event, activity, onMutate }: ErrorDetailViewProps) {
	const [comment, setComment] = useState('')
	const [assignee, setAssignee] = useState(issue.assignedTo ?? '')
	const [mergeTarget, setMergeTarget] = useState('')
	const [release, setRelease] = useState(event?.release ?? '')
	const [busy, setBusy] = useState(false)

	async function mutate(mutation: IssueMutation) {
		if (onMutate === undefined) return
		setBusy(true)
		try {
			await onMutate(mutation)
		} finally {
			setBusy(false)
		}
	}

	const primaryException = event?.exceptions[0] ?? null

	return (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<div>
						<p className="eyebrow">{issue.projectId}</p>
						<h1>{issue.title}</h1>
						<p className="hint">{issue.culprit ?? 'No culprit was reported.'}</p>
					</div>
					<span className={`status status-${issue.status === 'open' ? 'stop' : issue.status === 'resolved' ? 'ok' : 'idle'}`}>
						<span className="lamp" aria-hidden="true" />
						{issue.regressedAt !== null && issue.status === 'open' ? 'regressed' : issue.status}
					</span>
				</div>
			</div>

			<div className="detail-grid">
				<Fact label="Events" value={issue.count.toLocaleString()} />
				<Fact label="First seen" value={formatTimestamp(issue.firstSeen)} />
				<Fact label="Last seen" value={relativeSeen(issue.lastSeen)} />
				<Fact label="Assigned to" value={issue.assignedTo ?? 'Unassigned'} />
				<Fact label="Release" value={event?.release ?? '—'} />
				<Fact label="Environment" value={event?.environment ?? '—'} />
			</div>

			<section>
				<div className="section-head">
					<h2>Latest occurrence</h2>
				</div>
				{event === null
					? <p className="section-note">No event context was retained for this issue.</p>
					: (
						<div className="ops-occurrence">
							<div className="ops-trace-line">
								<span>
									<strong>{event.request?.method ?? 'event'}</strong> {event.request?.url ?? event.platform ?? 'unknown origin'}
								</span>
								<span>{event.runtime ?? 'unknown runtime'}{event.os === null ? '' : ` · ${event.os}`}</span>
							</div>
							{primaryException !== null && (
								<div className="ops-exception">
									<h3>{[primaryException.type, primaryException.value].filter(Boolean).join(': ') || issue.title}</h3>
									<div className="ops-stack">
										{primaryException.frames.map((frame, index) => (
											<div className={`ops-frame${frame.inApp ? ' in-app' : ''}`} key={`${frameLocation(frame)}:${index}`}>
												<div>
													<strong>{frame.function ?? '(anonymous)'}</strong>
													<code>{frameLocation(frame)}</code>
												</div>
												<FrameSource frame={frame} />
											</div>
										))}
									</div>
								</div>
							)}
							<EventContext event={event} />
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
									<div className="form-row">
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'status', status: 'resolved' })}>Resolve</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'status', status: 'ignored' })}>Ignore</button>
										<button type="button" disabled={busy} onClick={() => mutate({ kind: 'snooze_until', until: Date.now() + 24 * 60 * 60 * 1000 })}>
											Snooze 24 h
										</button>
									</div>
									<label>
										Assignee
										<div className="ops-inline-action">
											<input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="Principal ID" />
											<button type="button" disabled={busy} onClick={() => mutate({ kind: 'assign', principalId: assignee || null, principalLabel: null })}>
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
											await mutate({ kind: 'comment', text: comment.trim() })
											setComment('')
										}}
									>
										Add comment
									</button>
									<label>
										Resolve in release
										<div className="ops-inline-action">
											<input value={release} onChange={(event) => setRelease(event.target.value)} placeholder="Release name" />
											<button
												type="button"
												disabled={busy || release.trim() === ''}
												onClick={() => mutate({ kind: 'resolve_in_release', release: release.trim() })}
											>
												Resolve
											</button>
										</div>
									</label>
									<label>
										Merge into issue
										<div className="ops-inline-action">
											<input value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)} placeholder="Opaque issue token" />
											<button
												type="button"
												disabled={busy || mergeTarget.trim() === ''}
												onClick={() => mutate({ kind: 'merge', target: mergeTarget.trim() })}
											>
												Merge
											</button>
										</div>
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
						{activity.length === 0
							? (
								<div className="empty-state">
									<strong className="empty-title">No triage activity</strong>
								</div>
							)
							: (
								<div className="feed">
									{activity.map((item) => (
										<div className="feed-row" key={item.id}>
											<span className="feed-main">
												<strong className="feed-title">{item.kind}</strong>
												<span className="feed-meta">{item.actorLabel ?? 'System'}</span>
											</span>
											<span className="feed-side">{relativeSeen(item.at)}</span>
										</div>
									))}
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
		<pre className="ops-source">
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
		</div>
	)
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}
