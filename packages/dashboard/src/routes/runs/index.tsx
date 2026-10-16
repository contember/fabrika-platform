import { createPage, Link, useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { QuerySearch } from '../../components/QuerySearch'
import { Chip, RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError, type RunDto } from '../../lib/api'
import { holdsGlobally, opensApplications, scopedRunReads } from '../../lib/console-access'
import { fmtAgo, fmtDate, fmtDuration, shortRef, shortSha } from '../../lib/format'
import type { QueryLanguage } from '../../lib/query-search'
import { consoleSession } from '../../lib/session'

// Runs: the global deploy history. Filter by app and/or env through the search field or a click on a value in the
// table; the filter lives in the page's address (`?app=&env=`), and "Load more" pages on with the cursor. Each row
// links to the run detail (which tails the live log). A caller who reads runs only in some apps or environments
// starts filtered to the first of them, and an emptied search returns there.

const PAGE_SIZE = 50

interface RunFilter {
	app?: string
	env?: string
}

/** The two filters Control can apply to the run list, as the search field's qualifiers; there is no text search. */
const RUNS_QUERY: QueryLanguage<keyof RunFilter> = {
	qualifiers: [
		{ key: 'app', name: 'app' },
		{ key: 'env', name: 'env', aliases: ['environment'] },
	],
	freeText: false,
}

export default createPage()
	.params({ app: '?string', env: '?string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const readsAll = access === null || holdsGlobally(access, CONTROL_ACTIONS.DEPLOY_READ)
		const scoped = access === null ? { apps: [], environments: [] } : scopedRunReads(access)
		const initialFilter = readsAll || scoped.apps.length > 0
			? { app: readsAll ? '' : (scoped.apps[0] ?? ''), env: '' }
			: { app: '', env: scoped.environments[0] ?? '' }
		const listsApps = opensApplications(access)
		const chosen = params.app !== undefined || params.env !== undefined
		const filter = chosen ? { app: params.app ?? '', env: params.env ?? '' } : initialFilter
		// The field accepts any app or environment, and Control refuses a filter outside what the caller reads: that
		// refusal is the list's answer, said above an empty table, not an error that replaces the page.
		const listed = await api.runs.list({ ...runFilter(filter.app, filter.env), limit: PAGE_SIZE }).then(
			(page) => ({ page, refused: null }),
			(cause: unknown) => {
				if (!chosen || !(cause instanceof ApiError)) throw cause
				return { page: { items: [], nextCursor: null }, refused: cause.message }
			},
		)
		// Every load is new, even one that lands on the filter already shown, so the search field is rebuilt from it.
		return { initialRuns: listed.page, refused: listed.refused, filter, listsApps, loadedAt: Date.now() }
	})
	.route('/runs')
	.render(({ data }) => {
		const navigate = useNavigate()
		const [runs, setRuns] = useState<RunDto[]>(data.initialRuns.items)
		const [cursor, setCursor] = useState<string | null>(data.initialRuns.nextCursor)
		const [loading, setLoading] = useState(false)
		const [error, setError] = useState<string | null>(null)
		const current: RunFilter = { app: data.filter.app || undefined, env: data.filter.env || undefined }

		// A page "Load more" asked for under one filter must not land under the next one.
		const generation = useRef(0)

		// A new filter loads a new first page; the pages "Load more" added belong to the old one.
		useEffect(() => {
			generation.current++
			setRuns(data.initialRuns.items)
			setCursor(data.initialRuns.nextCursor)
			setError(null)
		}, [data.initialRuns])

		async function loadMore() {
			if (cursor === null) return
			const asked = generation.current
			setLoading(true)
			setError(null)
			try {
				const page = await api.runs.list({ ...runFilter(data.filter.app, data.filter.env), before: cursor, limit: PAGE_SIZE })
				if (asked !== generation.current) return
				setRuns((prev) => [...prev, ...page.items])
				setCursor(page.nextCursor)
			} catch (cause) {
				if (asked === generation.current) setError(cause instanceof ApiError ? cause.message : 'Failed to load runs.')
			} finally {
				setLoading(false)
			}
		}

		function applyFilters(next: RunFilter) {
			navigate('runs', { params: { app: next.app, env: next.env }, replace: true })
		}

		return (
			<>
				<div className="page-head">
					<h1>Deploy runs</h1>
					<p className="hint">Release history, newest first. Every run records its env, ref and commit, its timings, and its exit code.</p>
				</div>

				<QuerySearch
					key={data.loadedAt}
					id="runs-search"
					language={RUNS_QUERY}
					label="Search deploy runs"
					filters={current}
					onApply={(filters) => applyFilters(filters)}
					placeholder="app:storefront env:prod"
				/>

				{data.refused !== null && <p className="error-text" role="alert">{data.refused}</p>}
				{error && <p className="error-text" role="alert">{error}</p>}

				<Table
					colSpan={7}
					isEmpty={runs.length === 0}
					empty={
						<EmptyState
							icon="runs"
							title="No runs match"
							body="A push to an env's trigger ref starts a run, or deploy one by hand from its app page."
						/>
					}
					head={
						<tr>
							<th>Status</th>
							<th>App</th>
							<th>Env</th>
							<th className="grow">Ref</th>
							<th>Commit</th>
							<th>Trigger</th>
							<th>Duration</th>
							<th>Started</th>
						</tr>
					}
				>
					{runs.map((run) => (
						<tr key={run.id}>
							<td>
								<Link to="runs/detail" params={{ id: run.id }}>
									<RunStatus status={run.status} />
								</Link>
							</td>
							<td>
								<span className="linked-value">
									<Link to="runs" params={{ ...current, app: run.appId }} title="Filter to this app" className="filter-link">
										<span>{run.appId}</span>
									</Link>
									{data.listsApps && (
										<Link to="apps/detail" params={{ id: run.appId }} className="value-page" aria-label={`Open ${run.appId}`} title="Open this app">
											<Icon name="arrow-right" size={12} />
										</Link>
									)}
								</span>
							</td>
							<td>
								<Link to="runs" params={{ ...current, env: run.env }} title="Filter to this environment" className="filter-link">
									<Chip>{run.env}</Chip>
								</Link>
							</td>
							<td>
								<code>{shortRef(run.ref)}</code>
							</td>
							<td>
								<code>{shortSha(run.commitSha)}</code>
							</td>
							<td className="muted small">{run.trigger}</td>
							<td className="small">{fmtDuration(run.startedAt, run.finishedAt)}</td>
							<td className="muted small" title={fmtDate(run.createdAt)}>{fmtAgo(run.createdAt)}</td>
						</tr>
					))}
				</Table>

				{cursor !== null && (
					<div className="pager">
						<button type="button" onClick={() => void loadMore()} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
					</div>
				)}
			</>
		)
	})

function runFilter(app: string, env: string): { appId?: string; env?: string } {
	return { ...(app === '' ? {} : { appId: app }), ...(env === '' ? {} : { env }) }
}
