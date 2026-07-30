import { Link } from '@buzola/router'
import type { IssueListItem, IssueMutation, IssueStatus } from '@fabrika/operations-contract'
import { useMemo, useState } from 'react'
import { relativeSeen } from '../format'

export interface ErrorsViewProps {
	issues: readonly OperationsIssueListEntry[]
	onMutate?: (issueId: string, mutation: IssueMutation) => Promise<void>
}

/** Operator APIs must supply a globally opaque id; a source-local fingerprint is not a route identity. */
export interface OperationsIssueListEntry {
	id: string
	issue: IssueListItem
}

export function filterIssues(
	issues: readonly OperationsIssueListEntry[],
	query: string,
	status: IssueStatus | 'all',
): OperationsIssueListEntry[] {
	const needle = query.trim().toLocaleLowerCase()
	return issues.filter(({ issue }) => {
		if (status !== 'all' && issue.status !== status) return false
		return needle === ''
			|| issue.title.toLocaleLowerCase().includes(needle)
			|| issue.projectId.toLocaleLowerCase().includes(needle)
			|| (issue.culprit?.toLocaleLowerCase().includes(needle) ?? false)
	})
}

export function ErrorsView({ issues, onMutate }: ErrorsViewProps) {
	const [query, setQuery] = useState('')
	const [status, setStatus] = useState<IssueStatus | 'all'>('open')
	const [pending, setPending] = useState<string | null>(null)
	const [selected, setSelected] = useState<string[]>([])
	const visible = useMemo(() => filterIssues(issues, query, status), [issues, query, status])

	async function mutate(issueId: string, mutation: IssueMutation) {
		if (onMutate === undefined) return
		setPending(issueId)
		try {
			await onMutate(issueId, mutation)
		} finally {
			setPending(null)
		}
	}

	async function bulkStatus(nextStatus: IssueStatus) {
		if (onMutate === undefined) return
		try {
			for (const issueId of selected) {
				setPending(issueId)
				await onMutate(issueId, { kind: 'status', status: nextStatus })
			}
			setSelected([])
		} finally {
			setPending(null)
		}
	}

	function toggle(issueId: string) {
		setSelected((current) => current.includes(issueId) ? current.filter((item) => item !== issueId) : [...current, issueId])
	}

	return (
		<>
			<div className="filters">
				<label className="field-wide">
					Search
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, source or culprit" />
				</label>
				<label>
					Status
					<select value={status} onChange={(event) => setStatus(readStatus(event.target.value))}>
						<option value="all">All</option>
						<option value="open">Open</option>
						<option value="resolved">Resolved</option>
						<option value="ignored">Ignored</option>
					</select>
				</label>
				<span className="count">{visible.length} {visible.length === 1 ? 'issue' : 'issues'}</span>
			</div>

			{onMutate !== undefined && selected.length > 0 && (
				<div className="toolbar ops-bulk">
					<strong>{selected.length} selected</strong>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('resolved')}>Resolve</button>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('ignored')}>Ignore</button>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => setSelected([])}>Clear</button>
				</div>
			)}

			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							{onMutate !== undefined && (
								<th>
									<span className="sr-only">Select</span>
								</th>
							)}
							<th>Level</th>
							<th className="grow">Issue</th>
							<th>Source</th>
							<th>Events</th>
							<th>Last seen</th>
							<th>Status</th>
							{onMutate !== undefined && (
								<th>
									<span className="sr-only">Actions</span>
								</th>
							)}
						</tr>
					</thead>
					<tbody>
						{visible.length === 0
							? (
								<tr>
									<td className="empty" colSpan={onMutate === undefined ? 6 : 8}>
										<div className="empty-state">
											<strong className="empty-title">No issues match</strong>
											<span className="empty-body">Change the query or status filter.</span>
										</div>
									</td>
								</tr>
							)
							: visible.map(({ id, issue }) => {
								return (
									<tr key={id}>
										{onMutate !== undefined && (
											<td>
												<input
													type="checkbox"
													checked={selected.includes(id)}
													onChange={() => toggle(id)}
													aria-label={`Select ${issue.title}`}
												/>
											</td>
										)}
										<td>
											<span className={`ops-level ops-level-${severityClass(issue.level)}`}>{issue.level}</span>
										</td>
										<td>
											<Link to="operations/errors/detail" params={{ issueId: id }}>
												{issue.title}
											</Link>
											{issue.culprit !== null && <div className="cell-note">{issue.culprit}</div>}
										</td>
										<td>
											<code>{issue.projectId}</code>
										</td>
										<td className="numeric">{issue.count.toLocaleString()}</td>
										<td>{relativeSeen(issue.lastSeen)}</td>
										<td>
											<IssueStatusLabel status={issue.status} regressed={issue.regressedAt !== null} />
										</td>
										{onMutate !== undefined && (
											<td>
												<button
													type="button"
													className="btn small"
													disabled={pending === id}
													onClick={() => mutate(id, { kind: 'status', status: issue.status === 'resolved' ? 'open' : 'resolved' })}
												>
													{issue.status === 'resolved' ? 'Reopen' : 'Resolve'}
												</button>
											</td>
										)}
									</tr>
								)
							})}
					</tbody>
				</table>
			</div>
		</>
	)
}

function severityClass(level: string): string {
	if (level === 'fatal' || level === 'error' || level === 'warning' || level === 'info') return level
	return 'muted'
}

function readStatus(value: string): IssueStatus | 'all' {
	if (value === 'open' || value === 'resolved' || value === 'ignored') return value
	return 'all'
}

function IssueStatusLabel({ status, regressed }: { status: IssueStatus; regressed: boolean }) {
	const lamp = status === 'open' ? 'stop' : status === 'resolved' ? 'ok' : 'idle'
	return (
		<span className={`status status-${lamp}`}>
			<span className="lamp" aria-hidden="true" />
			{regressed && status === 'open' ? 'regressed' : status}
		</span>
	)
}
