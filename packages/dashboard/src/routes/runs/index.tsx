import { createPage, Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip, RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError, type RunDto } from '../../lib/api'
import { holdsGlobally, opensApplications, scopedRunReads } from '../../lib/console-access'
import { fmtAgo, fmtDate, fmtDuration, shortRef, shortSha } from '../../lib/format'
import { consoleSession } from '../../lib/session'

// Runs — the global deploy history. Filter by app and/or env; keyset-paged with `?before=`. Each row
// links to the run detail (which tails the live log). A per-app view is the same table prefiltered.
// A caller who reads runs only in some apps or environments starts filtered to the first of them.

const PAGE_SIZE = 50

export default createPage()
	.loader(async () => {
		const { access } = await consoleSession()
		const readsAll = access === null || holdsGlobally(access, CONTROL_ACTIONS.DEPLOY_READ)
		const scoped = access === null ? { apps: [], environments: [] } : scopedRunReads(access)
		const initialFilter = readsAll || scoped.apps.length > 0
			? { app: readsAll ? '' : (scoped.apps[0] ?? ''), env: '' }
			: { app: '', env: scoped.environments[0] ?? '' }
		const listsApps = opensApplications(access)
		const [runs, apps] = await Promise.all([
			api.runs.list({ ...runFilter(initialFilter.app, initialFilter.env), limit: PAGE_SIZE }),
			listsApps ? api.apps.list().then((list) => list.items.map((app) => app.id)) : scoped.apps,
		])
		return { initialRuns: runs, apps, initialFilter, readsAll, listsApps }
	})
	.route('/runs')
	.render(({ data }) => {
		const [app, setApp] = useState(data.initialFilter.app)
		const [env, setEnv] = useState(data.initialFilter.env)
		const [runs, setRuns] = useState<RunDto[]>(data.initialRuns.items)
		const [cursor, setCursor] = useState<string | null>(data.initialRuns.nextCursor)
		const [loading, setLoading] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function load(reset: boolean) {
			setLoading(true)
			setError(null)
			try {
				const before = reset ? undefined : (cursor ?? undefined)
				const page = await api.runs.list({
					...runFilter(app, env),
					...(before === undefined ? {} : { before }),
					limit: PAGE_SIZE,
				})
				setRuns((prev) => (reset ? page.items : [...prev, ...page.items]))
				setCursor(page.nextCursor)
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Failed to load runs.')
			} finally {
				setLoading(false)
			}
		}

		function applyFilters(e: React.FormEvent) {
			e.preventDefault()
			void load(true)
		}

		return (
			<>
				<div className="page-head">
					<h1>Deploy runs</h1>
					<p className="hint">Release history, newest first. Every run records its env, ref and commit, its timings, and its exit code.</p>
				</div>

				<form className="filters" onSubmit={applyFilters}>
					<label>
						App
						<select value={app} onChange={(e) => setApp(e.target.value)}>
							{(data.readsAll || data.initialFilter.app === '') && <option value="">{data.readsAll ? 'All apps' : 'Any app'}</option>}
							{data.apps.map((id) => <option key={id} value={id}>{id}</option>)}
						</select>
					</label>
					<label>
						Environment
						<input value={env} onChange={(e) => setEnv(e.target.value)} placeholder="any" />
					</label>
					<div className="filter-actions">
						<button type="submit" disabled={loading}>
							<Icon name="filter" size={14} />
							Filter
						</button>
						<button
							type="button"
							className="ghost"
							onClick={() => {
								setApp(data.initialFilter.app)
								setEnv(data.initialFilter.env)
								setRuns(data.initialRuns.items)
								setCursor(data.initialRuns.nextCursor)
							}}
							disabled={loading}
						>
							Clear
						</button>
					</div>
				</form>

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
								{data.listsApps ? <Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link> : run.appId}
							</td>
							<td>
								<Chip>{run.env}</Chip>
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
						<button type="button" onClick={() => load(false)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
					</div>
				)}
			</>
		)
	})

function runFilter(app: string, env: string): { appId?: string; env?: string } {
	return { ...(app === '' ? {} : { appId: app }), ...(env === '' ? {} : { env }) }
}
