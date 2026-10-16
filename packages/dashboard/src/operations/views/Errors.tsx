import { Link } from '@buzola/router'
import type { IssueStatus } from '@fabrika/operations-contract'
import type {
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueSummaryDto,
	OperationsSourceSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery } from '@fabrika/operations-contract/rpc'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { QuerySearch } from '../../components/QuerySearch'
import { fmtAgo } from '../../lib/format'
import type { QueryFilters, QueryLanguage } from '../../lib/query-search'

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

type IssueQueryKey = 'status' | 'level' | 'source' | 'window' | 'assignee' | 'sort'

/**
 * How a source is written in the search field: its name, `name/environment` where two sources share a name, and its id
 * where even that is shared. Built from the sources the caller can see, so `source:` accepts exactly those.
 */
export function sourceNames(sources: readonly OperationsSourceSummaryDto[]): Map<string, string> {
	const counts = new Map<string, number>()
	const count = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
	for (const source of sources) {
		count(source.displayName)
		count(`${source.displayName}/${source.environment}`)
	}
	return new Map(sources.map((source) => {
		const scoped = `${source.displayName}/${source.environment}`
		return [source.id, counts.get(source.displayName) === 1 ? source.displayName : counts.get(scoped) === 1 ? scoped : source.id]
	}))
}

/**
 * The source a `source:` value names. A value that is no listed source's name is taken as an id, so a click on a source
 * the list does not carry (one the caller no longer sees, say) still narrows to it instead of quietly showing everything.
 */
export function sourceIdNamed(sources: readonly OperationsSourceSummaryDto[], written: string): string {
	return [...sourceNames(sources)].find(([, name]) => name === written)?.[0] ?? written
}

/** The issue list's filters as the search field's qualifiers; words without a qualifier search title and culprit. */
export function issueQueryLanguage(sources: readonly OperationsSourceSummaryDto[]): QueryLanguage<IssueQueryKey> {
	return {
		qualifiers: [
			{ key: 'status', name: 'status', values: ['open', 'resolved', 'ignored', 'all'] },
			{ key: 'level', name: 'level', values: ['fatal', 'error', 'warning', 'info'] },
			{ key: 'source', name: 'source', values: [...sourceNames(sources).values()] },
			{ key: 'window', name: 'window', values: ['24h', '7d', '30d', 'all'] },
			{ key: 'assignee', name: 'assignee', values: ['me', 'none', 'all'] },
			{ key: 'sort', name: 'sort', values: ['recent', 'new', 'frequency'] },
		],
		freeText: true,
	}
}

/**
 * The field shows exactly what is filtered: each filter that narrows the list, and the sort when it is not the
 * default. A filter missing from the field does not narrow, so an emptied field lists every issue.
 */
export function issueFiltersToQuery(filters: IssueFilters, sources: readonly OperationsSourceSummaryDto[]): QueryFilters<IssueQueryKey> {
	return {
		...(filters.status === 'all' ? {} : { status: filters.status }),
		...(filters.level === 'all' ? {} : { level: filters.level }),
		...(filters.sourceId === '' ? {} : { source: sourceNames(sources).get(filters.sourceId) ?? filters.sourceId }),
		...(filters.window === 'all' ? {} : { window: filters.window }),
		...(filters.assignee === 'all' ? {} : { assignee: filters.assignee }),
		...(filters.sort === 'recent' ? {} : { sort: filters.sort }),
	}
}

export function issueFiltersFromQuery(
	query: QueryFilters<IssueQueryKey>,
	text: string,
	sources: readonly OperationsSourceSummaryDto[],
): IssueFilters {
	return {
		query: text,
		sourceId: query.source === undefined ? '' : sourceIdNamed(sources, query.source),
		status: readStatus(query.status ?? 'all'),
		level: readLevel(query.level ?? 'all'),
		window: readWindow(query.window ?? 'all'),
		assignee: readAssignee(query.assignee ?? 'all'),
		sort: readSort(query.sort ?? 'recent'),
	}
}

export function ErrorsView({ initialPage, sources, onQuery, onMutate, onBulkStatus, onBulkMerge }: ErrorsViewProps) {
	const language = useMemo(() => issueQueryLanguage(sources), [sources])
	const [appliedFilters, setAppliedFilters] = useState<IssueFilters>(DEFAULT_ISSUE_FILTERS)
	const [page, setPage] = useState(initialPage)
	const [pending, setPending] = useState<string | null>(null)
	const [selected, setSelected] = useState<string[]>([])
	const [bulkMergeTarget, setBulkMergeTarget] = useState('')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => setPage(initialPage), [initialPage])

	// Loads overlap (the five-second poll, a search, a click on a value), so only the newest one may land: an older
	// answer arriving last would put the list, and the field, back on the filters it was asked for.
	const latest = useRef(0)
	// The filters last asked for, which a load after a change and the poll reuse. Not `appliedFilters`: a search made
	// while a bulk change is still saving must survive the reload that change ends with, not be replaced by the filters
	// that were applied when it started.
	const requested = useRef(appliedFilters)

	async function load(nextFilters: IssueFilters, append: boolean, clearSelection = !append) {
		const ticket = ++latest.current
		if (!append) requested.current = nextFilters
		setPending(append ? 'more' : 'query')
		setError(null)
		try {
			const next = await onQuery(issueQuery(nextFilters, append ? page.nextCursor ?? undefined : undefined))
			if (ticket !== latest.current) return
			setPage(append ? { ...next, items: [...page.items, ...next.items] } : next)
			setAppliedFilters(nextFilters)
			if (clearSelection) setSelected([])
		} catch (cause) {
			if (ticket === latest.current) setError(cause instanceof Error ? cause.message : 'Issues could not be loaded.')
		} finally {
			if (ticket === latest.current) setPending(null)
		}
	}

	useEffect(() => {
		if (pending !== null || selected.length > 0) return
		const timer = window.setInterval(() => void load(requested.current, false, false), 5_000)
		return () => window.clearInterval(timer)
	}, [appliedFilters, pending, selected.length])

	async function mutate(issueId: string, mutation: OperationsIssueMutationRequestDto) {
		if (onMutate === undefined) return
		setPending(issueId)
		setError(null)
		try {
			await onMutate(issueId, mutation)
			await load(requested.current, false)
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
			await load(requested.current, false)
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
			await load(requested.current, false)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The selected issues could not be merged.')
		} finally {
			setPending(null)
		}
	}

	/** A value in the table narrows the list to it, keeping the filters already applied. */
	function narrow(change: Partial<IssueFilters>) {
		void load({ ...appliedFilters, ...change }, false)
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
			<QuerySearch
				id="issue-search"
				language={language}
				label="Search"
				filters={issueFiltersToQuery(appliedFilters, sources)}
				text={appliedFilters.query}
				onApply={(query, text) => void load(issueFiltersFromQuery(query, text, sources), false)}
				placeholder="status:open level:error checkout failed"
				aside={
					<>
						{page.summary.total.toLocaleString()} {page.summary.total === 1 ? 'issue' : 'issues'}
						<button type="button" className="ghost small" disabled={pending !== null} onClick={() => void load(appliedFilters, false)}>
							Refresh
						</button>
					</>
				}
			/>

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
										{/* A level the search cannot filter on (an SDK's own `debug`) is shown, not offered as a filter. */}
										{readLevel(issue.level) === 'all'
											? <span className={`ops-level ops-level-${severityClass(issue.level)}`}>{issue.level}</span>
											: (
												<button type="button" className="filter-value" title="Filter to this level" onClick={() => narrow({ level: readLevel(issue.level) })}>
													<span className={`ops-level ops-level-${severityClass(issue.level)}`}>{issue.level}</span>
												</button>
											)}
									</td>
									<td>
										<Link to="operations/errors/detail" params={{ issueId: issue.id }}>{issue.title}</Link>
										{issue.culprit !== null && <div className="cell-note">{issue.culprit}</div>}
									</td>
									<td>
										<span className="linked-value">
											<button type="button" className="filter-value" title="Filter to this source" onClick={() => narrow({ sourceId: issue.source.id })}>
												<span>{issue.source.displayName}</span>
											</button>
											<Link
												to="operations/sources/detail"
												params={{ sourceId: issue.source.id }}
												className="value-page"
												aria-label={`Open ${issue.source.displayName}`}
												title="Open this source"
											>
												<Icon name="arrow-right" size={12} />
											</Link>
										</span>
										<div className="cell-note">{issue.source.environment} · {issue.source.serviceKey}</div>
									</td>
									<td>
										<Trend issue={issue} />
									</td>
									<td className="numeric">{issue.count.toLocaleString()}</td>
									<td>{fmtAgo(issue.lastSeen / 1000)}</td>
									<td>
										<button type="button" className="filter-value" title="Filter to this status" onClick={() => narrow({ status: issue.status })}>
											<IssueStatusLabel issueId={issue.id} status={issue.status} regressed={issue.regressedAt !== null} />
										</button>
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
	if (points === '') return <span className="muted">none</span>
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
