import { Link } from '@buzola/router'
import type { IssueStatus } from '@fabrika/operations-contract'
import type { OperationsIssueMutationRequestDto, OperationsIssueSummaryDto } from '@fabrika/operations-contract/operator-api'
import { useMemo, useState } from 'react'
import { relativeSeen } from '../format'

export interface ErrorsViewProps {
	issues: readonly OperationsIssueSummaryDto[]
	onMutate?: (issueId: string, mutation: OperationsIssueMutationRequestDto) => Promise<void>
	onBulkStatus?: (issueIds: string[], status: IssueStatus) => Promise<void>
}

export function filterIssues(
	issues: readonly OperationsIssueSummaryDto[],
	query: string,
	status: IssueStatus | 'all',
): OperationsIssueSummaryDto[] {
	const needle = query.trim().toLocaleLowerCase()
	return issues.filter((issue) => {
		if (status !== 'all' && issue.status !== status) return false
		return needle === ''
			|| issue.title.toLocaleLowerCase().includes(needle)
			|| issue.source.displayName.toLocaleLowerCase().includes(needle)
			|| issue.source.appId.toLocaleLowerCase().includes(needle)
			|| (issue.culprit?.toLocaleLowerCase().includes(needle) ?? false)
	})
}

export function ErrorsView({ issues, onMutate, onBulkStatus }: ErrorsViewProps) {
	const [query, setQuery] = useState('')
	const [status, setStatus] = useState<IssueStatus | 'all'>('open')
	const [pending, setPending] = useState<string | null>(null)
	const [selected, setSelected] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const visible = useMemo(() => filterIssues(issues, query, status), [issues, query, status])

	async function mutate(issueId: string, mutation: OperationsIssueMutationRequestDto) {
		if (onMutate === undefined) return
		setPending(issueId)
		setError(null)
		try {
			await onMutate(issueId, mutation)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The issue could not be changed.')
		} finally {
			setPending(null)
		}
	}

	async function bulkStatus(nextStatus: IssueStatus) {
		if (onBulkStatus === undefined) return
		setPending('bulk')
		setError(null)
		try {
			await onBulkStatus(selected, nextStatus)
			setSelected([])
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The selected issues could not be changed.')
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

			{onBulkStatus !== undefined && selected.length > 0 && (
				<div className="toolbar ops-bulk">
					<strong>{selected.length} selected</strong>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('resolved')}>Resolve</button>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('ignored')}>Ignore</button>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => setSelected([])}>Clear</button>
				</div>
			)}
			{error && <p className="error-text" role="alert">{error}</p>}

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
							: visible.map((issue) => {
								return (
									<tr key={issue.id}>
										{onMutate !== undefined && (
											<td>
												<input
													type="checkbox"
													checked={selected.includes(issue.id)}
													onChange={() => toggle(issue.id)}
													aria-label={`Select ${issue.title}`}
												/>
											</td>
										)}
										<td>
											<span className={`ops-level ops-level-${severityClass(issue.level)}`}>{issue.level}</span>
										</td>
										<td>
											<Link to="operations/errors/detail" params={{ issueId: issue.id }}>
												{issue.title}
											</Link>
											{issue.culprit !== null && <div className="cell-note">{issue.culprit}</div>}
										</td>
										<td>
											<Link to="operations/sources/detail" params={{ sourceId: issue.source.id }}>
												{issue.source.displayName}
											</Link>
											<div className="cell-note">{issue.source.environment} · {issue.source.serviceKey}</div>
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
													disabled={pending === issue.id}
													onClick={() => mutate(issue.id, { kind: 'status', status: issue.status === 'resolved' ? 'open' : 'resolved' })}
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
