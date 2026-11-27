import { createPage, Link } from '@buzola/router'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { DeployButton } from '../../components/app/DeployButton'
import { Icon } from '../../components/Icon'
import { RunDuration, RunReview } from '../../components/RunDuration'
import { RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate, shortRef, shortSha } from '../../lib/format'

// An application's runs, newest first, narrowed to one environment by the address (`?env=`); the global Deploy runs
// list holds every application's, with its paging.

const PAGE_SIZE = 50

export default createPage()
	.params({ id: 'string', env: '?string' })
	.loader(async ({ params }) => {
		const [frame, runs] = await Promise.all([
			loadAppFrame(params.id),
			api.runs.list({ appId: params.id, ...(params.env === undefined ? {} : { env: params.env }), limit: PAGE_SIZE }),
		])
		return { ...frame, runs, env: params.env ?? null }
	})
	.route('/apps/:id/deploys')
	.render(({ data }) => {
		const { app, envs, runs, env } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="deploys" states={states}>
				<div className="toolbar">
					<div className="filter-group" role="group" aria-label="Environment">
						<Link to="apps/deploys" params={{ id: app.id }} className="filter-option" aria-current={env === null ? 'page' : undefined}>
							All environments
						</Link>
						{envs.map((candidate) => (
							<Link
								key={candidate.env}
								to="apps/deploys"
								params={{ id: app.id, env: candidate.env }}
								className="filter-option"
								aria-current={env === candidate.env ? 'page' : undefined}
							>
								{candidate.env}
							</Link>
						))}
					</div>
					<span className="spacer" />
					{envs.filter((candidate) => env === null || candidate.env === env).map((candidate) => (
						<DeployButton key={candidate.env} appId={app.id} env={candidate.env} named />
					))}
				</div>
				<Table
					colSpan={6}
					isEmpty={runs.items.length === 0}
					empty={<EmptyState icon="runs" title="No runs yet" body="Deploy an environment, or push to its trigger branch." />}
					head={
						<tr>
							<th>Status</th>
							<th>Environment</th>
							<th className="grow">Ref</th>
							<th>Commit</th>
							<th>Duration</th>
							<th>Started</th>
						</tr>
					}
				>
					{runs.items.map((run) => (
						<tr key={run.id}>
							<td>
								<div className="cell-stack">
									<Link to="runs/detail" params={{ id: run.id }}>
										<RunStatus status={run.status} />
									</Link>
									<RunReview run={run} />
								</div>
							</td>
							<td>{run.env}</td>
							<td>
								<code>{shortRef(run.ref)}</code>
							</td>
							<td>
								<code>{shortSha(run.commitSha)}</code>
							</td>
							<td className="muted small nowrap">
								<RunDuration run={run} />
							</td>
							<td className="muted small nowrap" title={fmtDate(run.createdAt)}>{fmtAgo(run.createdAt)}</td>
						</tr>
					))}
				</Table>
				{runs.nextCursor !== null && (
					<p className="muted small">
						The newest {PAGE_SIZE} runs.{' '}
						<Link to="runs" params={{ app: app.id, ...(env === null ? {} : { env }) }} className="card-link">
							All of them in Deploy runs
							<Icon name="chevron-right" size={13} />
						</Link>
					</p>
				)}
			</AppFrame>
		)
	})
