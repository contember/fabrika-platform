import { createPage, Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { RecentRunsSection } from '../../components/app-detail/RecentRunsSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { DeployButton } from '../../components/app/DeployButton'
import { WaitingApprovals } from '../../components/app/WaitingApprovals'
import { RunStatus, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, type AppEnvDto, type RunDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { type EnvironmentState, stateLabel, stateLamp } from '../../lib/environment-state'
import { fmtAgo, fmtDate, shortSha } from '../../lib/format'
import { type OverviewRead, overviewRead } from '../../lib/overview'
import { consoleSession } from '../../lib/session'
import { operationsClient } from '../../operations/client'

// An application's Overview: each environment's state, what it runs, its last run and open errors, what waits for a
// decision, and the newest runs. The environment states load one by one after the page (T1429, card t1429-stav-prostredi).

const RECENT_RUNS = 5
const ISSUE_LIMIT = 100

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const frame = await loadAppFrame(params.id)
		const readsRuns = access === null || mayDo(access, CONTROL_ACTIONS.DEPLOY_READ)
		const decides = access === null || mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE)
		const readsErrors = access === null || mayDo(access, OPERATIONS_ACTIONS.READ)
		const [runs, approvals, issues, published] = await Promise.all([
			overviewRead(readsRuns, () => api.runs.list({ appId: params.id, limit: RECENT_RUNS })),
			overviewRead(decides, () => api.approvals.list()),
			overviewRead(readsErrors, () => operationsClient.issues({ status: 'open', window: 'all', sort: 'recent', limit: ISSUE_LIMIT })),
			Promise.all(frame.envs.map(async (env) => [env.env, await publishedRun(env)] as const)),
		])
		return {
			...frame,
			runs,
			waiting: approvals.data?.items.filter((approval) => approval.run.appId === params.id) ?? [],
			issues,
			published: new Map(published),
		}
	})
	.route('/apps/:id')
	.render(({ data }) => {
		const { app, envs, runs, waiting, issues, published } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="overview" states={states}>
				<section>
					<div className="section-head">
						<h2>Environments</h2>
					</div>
					<Table
						colSpan={6}
						isEmpty={envs.length === 0}
						empty={
							<EmptyState
								icon="bay"
								title="No environments yet"
								body={
									<>
										Add one in <Link to="apps/settings" params={{ id: app.id }}>Settings</Link> to give this application an address.
									</>
								}
							/>
						}
						head={
							<tr>
								<th>Environment</th>
								<th className="grow">State</th>
								<th>Running</th>
								<th>Last run</th>
								<th>Errors</th>
								<th aria-label="Actions" />
							</tr>
						}
					>
						{envs.map((env) => (
							<EnvironmentRow
								key={env.env}
								env={env}
								state={states.get(env.env) ?? { kind: 'reading' }}
								published={published.get(env.env) ?? null}
								last={runs.data?.items.find((run) => run.env === env.env) ?? null}
								issues={issues}
							/>
						))}
					</Table>
				</section>
				{waiting.length > 0 && <WaitingApprovals waiting={waiting} />}
				{runs.data !== null && <RecentRunsSection appId={app.id} runs={runs.data.items} />}
			</AppFrame>
		)
	})

/** The run an environment publishes, by its id: never a guess from the newest run. */
async function publishedRun(env: AppEnvDto): Promise<RunDto | null> {
	if (env.publishedRunId === null) return null
	return api.runs.get({ runId: env.publishedRunId }).catch(() => null)
}

function EnvironmentRow({ env, state, published, last, issues }: {
	env: AppEnvDto
	state: EnvironmentState
	published: RunDto | null
	last: RunDto | null
	issues: OverviewRead<Awaited<ReturnType<typeof operationsClient.issues>>>
}) {
	const access = useConsoleAccess()
	const open = issues.data?.items.filter((issue) => issue.source.appId === env.appId && issue.source.environment === env.env) ?? null
	const readsErrors = mayDo(access, OPERATIONS_ACTIONS.READ, { app: env.appId, env: env.env })
	return (
		<tr>
			<td>
				<div className="cell-stack">
					<strong>{env.env}</strong>
					<span className="muted small">{env.publicOrigin?.replace(/^https?:\/\//, '') ?? env.domain ?? 'No public address'}</span>
				</div>
			</td>
			<td>
				<div className="cell-stack">
					<Status lamp={stateLamp(state)}>{stateLabel(state)}</Status>
					<StateCause appId={env.appId} env={env.env} state={state} />
				</div>
			</td>
			<td>
				{env.publishedRunId === null ? <span className="muted">Not published</span> : (
					<div className="cell-stack">
						<Link to="runs/detail" params={{ id: env.publishedRunId }}>
							<code>{published === null ? 'Published run' : shortSha(published.commitSha)}</code>
						</Link>
						{published?.finishedAt != null && <span className="muted small">{fmtAgo(published.finishedAt)}</span>}
					</div>
				)}
			</td>
			<td>
				{last === null ? <span className="muted">None</span> : (
					<div className="cell-stack">
						<Link to="runs/detail" params={{ id: last.id }}>
							<RunStatus status={last.status} />
						</Link>
						<span className="muted small" title={fmtDate(last.createdAt)}>{fmtAgo(last.createdAt)}</span>
					</div>
				)}
			</td>
			<td>
				{!readsErrors || open === null
					? <span className="muted">Unknown</span>
					: open.length === 0
					? <span className="muted">None</span>
					: (
						<Link to="operations/errors" params={{ window: 'all', source: open[0]?.source.id ?? '' }}>
							{open.length >= ISSUE_LIMIT ? `${ISSUE_LIMIT}+` : open.length} open
						</Link>
					)}
			</td>
			<td>
				<DeployButton appId={env.appId} env={env.env} />
			</td>
		</tr>
	)
}

/** One line under the lamp naming why it is not green, with the tab that acts on it. */
function StateCause({ appId, env, state }: { appId: string; env: string; state: EnvironmentState }) {
	switch (state.kind) {
		case 'operation':
			return (
				<span className="small">
					{state.operation.state === 'running' ? 'Started' : 'Failed'} {fmtAgo(state.operation.updatedAt)} at step {state.operation.step}.{' '}
					<Link to="apps/data" params={{ id: appId, env }}>Open Data to recover</Link>
				</span>
			)
		case 'boot-failure':
			return (
				<span className="small">
					The application failed to boot. <Link to="apps/data" params={{ id: appId, env }}>Open Data</Link>
				</span>
			)
		case 'mode':
			return (
				<span className="small">
					Maintenance is on. <Link to="apps/data" params={{ id: appId, env }}>Open Data</Link>
				</span>
			)
		case 'suspended':
			return <span className="small muted">Control took it offline {fmtAgo(state.at)}.</span>
		default:
			return null
	}
}
