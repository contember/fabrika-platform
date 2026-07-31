import { Link } from '@buzola/router'
import type { IssueStatus } from '@fabrika/operations-contract'
import type {
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueSummaryDto,
	OperationsSourceSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery } from '@fabrika/operations-contract/rpc'
import { type FormEvent, useEffect, useState } from 'react'
import { relativeSeen } from '../format'

const PAGE_SIZE = 50

type StatusFilter = IssueStatus | 'all'
type LevelFilter = NonNullable<OperationsIssueQuery['level']> | 'all'

export interface IssueFilters {
	query: string
	sourceId: string
	status: StatusFilter
	level: LevelFilter
	window: NonNullable<OperationsIssueQuery['window']>
	assignee: NonNullable<OperationsIssueQuery['assignee']>
	sort: NonNullable<OperationsIssueQuery['sort']>
}

export interface ErrorsViewProps {
	initialPage: OperationsIssueListResponseDto
	sources: readonly OperationsSourceSummaryDto[]
	onQuery: (query: OperationsIssueQuery) => Promise<OperationsIssueListResponseDto>
	onMutate?: (issueId: string, mutation: OperationsIssueMutationRequestDto) => Promise<void>
	onBulkStatus?: (issueIds: string[], status: IssueStatus) => Promise<void>
	onBulkMerge?: (issueIds: string[], targetIssueId: string) => Promise<void>
}

export const DEFAULT_ISSUE_FILTERS: IssueFilters = {
	query: '',
	sourceId: '',
	status: 'open',
	level: 'all',
	window: '24h',
	assignee: 'all',
	sort: 'recent',
}

export function issueQuery(filters: IssueFilters, cursor?: string): OperationsIssueQuery {
	return {
		...(filters.query.trim() === '' ? {} : { query: filters.query.trim() }),
		...(filters.sourceId === '' ? {} : { sourceId: filters.sourceId }),
		...(filters.status === 'all' ? {} : { status: filters.status }),
		...(filters.level === 'all' ? {} : { level: filters.level }),
		window: filters.window,
		assignee: filters.assignee,
		sort: filters.sort,
		...(cursor === undefined ? {} : { cursor }),
		limit: PAGE_SIZE,
	}
}

export function trendPoints(trend: readonly number[], width = 88, height = 24): string {
	if (trend.length === 0) return ''
	const peak = Math.max(...trend, 1)
	const divisor = Math.max(trend.length - 1, 1)
	return trend.map((value, index) => `${(index / divisor) * width},${height - (value / peak) * height}`).join(' ')
}

export function ErrorsView({ initialPage, sources, onQuery, onMutate, onBulkStatus, onBulkMerge }: ErrorsViewProps) {
	const [filters, setFilters] = useState<IssueFilters>(DEFAULT_ISSUE_FILTERS)
	const [appliedFilters, setAppliedFilters] = useState<IssueFilters>(DEFAULT_ISSUE_FILTERS)
	const [page, setPage] = useState(initialPage)
	const [pending, setPending] = useState<string | null>(null)
	const [selected, setSelected] = useState<string[]>([])
	const [bulkMergeTarget, setBulkMergeTarget] = useState('')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => setPage(initialPage), [initialPage])

	async function load(nextFilters: IssueFilters, append: boolean, clearSelection = !append) {
		setPending(append ? 'more' : 'query')
		setError(null)
		try {
			const next = await onQuery(issueQuery(nextFilters, append ? page.nextCursor ?? undefined : undefined))
			setPage(append ? { ...next, items: [...page.items, ...next.items] } : next)
			setAppliedFilters(nextFilters)
			if (clearSelection) setSelected([])
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Issues could not be loaded.')
		} finally {
			setPending(null)
		}
	}

	useEffect(() => {
		if (pending !== null || selected.length > 0) return
		const timer = window.setInterval(() => void load(appliedFilters, false, false), 5_000)
		return () => window.clearInterval(timer)
	}, [appliedFilters, pending, selected.length])

	async function mutate(issueId: string, mutation: OperationsIssueMutationRequestDto) {
		if (onMutate === undefined) return
		setPending(issueId)
		setError(null)
		try {
			await onMutate(issueId, mutation)
			await load(appliedFilters, false)
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
			await load(appliedFilters, false)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The selected issues could not be changed.')
		} finally {
			setPending(null)
		}
	}

	async function bulkMerge(targetIssueId: string) {
		if (onBulkMerge === undefined) return
		setPending('bulk')
		setError(null)
		try {
			await onBulkMerge(selected, targetIssueId)
			setSelected([])
			setBulkMergeTarget('')
			await load(appliedFilters, false)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The selected issues could not be merged.')
		} finally {
			setPending(null)
		}
	}

	function apply(event: FormEvent) {
		event.preventDefault()
		void load(filters, false)
	}

	function toggle(issueId: string) {
		setSelected((current) => {
			const next = current.includes(issueId) ? current.filter((item) => item !== issueId) : [...current, issueId]
			setBulkMergeTarget((target) => next.includes(target) ? target : next[0] ?? '')
			return next
		})
	}

	const selectedIssues = page.items.filter((issue) => selected.includes(issue.id))
	const sameSource = selectedIssues.length > 1 && selectedIssues.every((issue) => issue.source.id === selectedIssues[0]?.source.id)

	return (
		<>
			<form className="filters" onSubmit={apply}>
				<label className="field-wide">
					Search
					<input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Title or culprit" />
				</label>
				<label>
					Source
					<select value={filters.sourceId} onChange={(event) => setFilters({ ...filters, sourceId: event.target.value })}>
						<option value="">All sources</option>
						{sources.map((source) => <option key={source.id} value={source.id}>{source.displayName} · {source.environment}</option>)}
					</select>
				</label>
				<label>
					Status
					<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: readStatus(event.target.value) })}>
						<option value="all">All</option>
						<option value="open">Open</option>
						<option value="resolved">Resolved</option>
						<option value="ignored">Ignored</option>
					</select>
				</label>
				<label>
					Level
					<select value={filters.level} onChange={(event) => setFilters({ ...filters, level: readLevel(event.target.value) })}>
						<option value="all">All</option>
						<option value="fatal">Fatal</option>
						<option value="error">Error</option>
						<option value="warning">Warning</option>
						<option value="info">Info</option>
					</select>
				</label>
				<label>
					Window
					<select value={filters.window} onChange={(event) => setFilters({ ...filters, window: readWindow(event.target.value) })}>
						<option value="24h">24 hours</option>
						<option value="7d">7 days</option>
						<option value="30d">30 days</option>
						<option value="all">All time</option>
					</select>
				</label>
				<label>
					Assignee
					<select value={filters.assignee} onChange={(event) => setFilters({ ...filters, assignee: readAssignee(event.target.value) })}>
						<option value="all">Anyone</option>
						<option value="me">Assigned to me</option>
						<option value="none">Unassigned</option>
					</select>
				</label>
				<label>
					Sort
					<select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: readSort(event.target.value) })}>
						<option value="recent">Recent</option>
						<option value="new">New</option>
						<option value="frequency">Frequency</option>
					</select>
				</label>
				<div className="filter-actions">
					<button type="submit" disabled={pending !== null}>Apply</button>
					<button type="button" className="ghost" disabled={pending !== null} onClick={() => void load(appliedFilters, false)}>Refresh</button>
				</div>
				<span className="count">{page.summary.total.toLocaleString()} {page.summary.total === 1 ? 'issue' : 'issues'}</span>
			</form>

			{onBulkStatus !== undefined && selected.length > 0 && (
				<div className="toolbar ops-bulk">
					<strong>{selected.length} selected</strong>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('resolved')}>Resolve</button>
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => bulkStatus('ignored')}>Ignore</button>
					{onBulkMerge !== undefined && selected.length > 1 && (
						<>
							<select
								value={bulkMergeTarget}
								disabled={pending !== null || !sameSource}
								onChange={(event) => setBulkMergeTarget(event.target.value)}
								aria-label="Canonical issue"
							>
								{selectedIssues.map((issue) => <option key={issue.id} value={issue.id}>{issue.title}</option>)}
							</select>
							<button
								type="button"
								className="btn small"
								disabled={pending !== null || !sameSource || bulkMergeTarget === ''}
								onClick={() => void bulkMerge(bulkMergeTarget)}
							>
								Merge into canonical
							</button>
							{!sameSource && <span className="hint">Select issues from one source to merge.</span>}
						</>
					)}
					<button type="button" className="btn small" disabled={pending !== null} onClick={() => setSelected([])}>Clear</button>
				</div>
			)}
			{error && <p className="error-text" role="alert">{error}</p>}

			<div className="table-wrap">
				<table aria-label="Operations issues">
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
							<th>Trend</th>
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
						{page.items.length === 0
							? (
								<tr>
									<td className="empty" colSpan={onMutate === undefined ? 7 : 9}>No issues match the server-side filters.</td>
								</tr>
							)
							: page.items.map((issue) => (
								<tr key={issue.id}>
									{onMutate !== undefined && (
										<td>
											<input type="checkbox" checked={selected.includes(issue.id)} onChange={() => toggle(issue.id)} aria-label={`Select ${issue.title}`} />
										</td>
									)}
									<td>
										<span className={`ops-level ops-level-${severityClass(issue.level)}`}>{issue.level}</span>
									</td>
									<td>
										<Link to="operations/errors/detail" params={{ issueId: issue.id }}>{issue.title}</Link>
										{issue.culprit !== null && <div className="cell-note">{issue.culprit}</div>}
									</td>
									<td>
										<Link to="operations/sources/detail" params={{ sourceId: issue.source.id }}>{issue.source.displayName}</Link>
										<div className="cell-note">{issue.source.environment} · {issue.source.serviceKey}</div>
									</td>
									<td>
										<Trend issue={issue} />
									</td>
									<td className="numeric">{issue.count.toLocaleString()}</td>
									<td>{relativeSeen(issue.lastSeen)}</td>
									<td>
										<IssueStatusLabel issueId={issue.id} status={issue.status} regressed={issue.regressedAt !== null} />
									</td>
									{onMutate !== undefined && (
										<td>
											<button
												type="button"
												className="btn small"
												disabled={pending !== null}
												onClick={() => mutate(issue.id, { kind: 'status', status: issue.status === 'resolved' ? 'open' : 'resolved' })}
											>
												{issue.status === 'resolved' ? 'Reopen' : 'Resolve'}
											</button>
										</td>
									)}
								</tr>
							))}
					</tbody>
				</table>
			</div>
			{page.nextCursor !== null && (
				<div className="pager">
					<button type="button" disabled={pending !== null} onClick={() => void load(appliedFilters, true)}>
						{pending === 'more' ? 'Loading…' : 'Load more'}
					</button>
				</div>
			)}
		</>
	)
}

function Trend({ issue }: { issue: OperationsIssueSummaryDto }) {
	const points = trendPoints(issue.trend)
	if (points === '') return <span className="muted">—</span>
	return (
		<svg width="88" height="24" viewBox="0 0 88 24" role="img" aria-label={`Event trend for ${issue.title}`}>
			<polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	)
}

function severityClass(level: string): string {
	if (level === 'fatal' || level === 'error' || level === 'warning' || level === 'info') return level
	return 'muted'
}

function readStatus(value: string): StatusFilter {
	if (value === 'open' || value === 'resolved' || value === 'ignored') return value
	return 'all'
}

function readLevel(value: string): LevelFilter {
	if (value === 'fatal' || value === 'error' || value === 'warning' || value === 'info') return value
	return 'all'
}

function readWindow(value: string): NonNullable<OperationsIssueQuery['window']> {
	if (value === '7d' || value === '30d' || value === 'all') return value
	return '24h'
}

function readAssignee(value: string): NonNullable<OperationsIssueQuery['assignee']> {
	if (value === 'me' || value === 'none') return value
	return 'all'
}

function readSort(value: string): NonNullable<OperationsIssueQuery['sort']> {
	if (value === 'new' || value === 'frequency') return value
	return 'recent'
}

function IssueStatusLabel({ issueId, status, regressed }: { issueId: string; status: IssueStatus; regressed: boolean }) {
	const lamp = status === 'open' ? 'stop' : status === 'resolved' ? 'ok' : 'idle'
	return (
		<span className={`status status-${lamp}`} data-testid="issue-status" data-issue-id={issueId} data-status={status}>
			<span className="lamp" aria-hidden="true" />
			{regressed && status === 'open' ? 'regressed' : status}
		</span>
	)
}
