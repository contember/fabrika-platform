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
import { holdsAtApp, mayDo } from '../../lib/console-access'
import { type EnvironmentState, stateLabel, stateLamp } from '../../lib/environment-state'
import { fmtAgo, fmtDate, shortSha } from '../../lib/format'
import { type OverviewRead, overviewRead } from '../../lib/overview'
import { consoleSession } from '../../lib/session'
import { operationsClient } from '../../operations/client'

// An application's Overview: each environment's state, what it runs, its last run and open errors, what waits for a
// decision, and the newest runs. The environment states load one by one after the page, so a slow one blocks no row.

const RECENT_RUNS = 5

/** An environment's open errors: a count, no source to count in, or not known (refused or unavailable). */
type OpenErrors = { readonly kind: 'count'; readonly open: number; readonly sourceId: string } | { readonly kind: 'no-source' } | {
	readonly kind: 'unknown'
}

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const frame = await loadAppFrame(params.id)
		const at = (env: AppEnvDto) => ({ app: params.id, env: env.env })
		const readsRuns = access === null || holdsAtApp(access, CONTROL_ACTIONS.DEPLOY_READ, params.id)
		const decides = access === null || mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE)
		const readsErrors = access === null || mayDo(access, OPERATIONS_ACTIONS.READ)
		const [runs, approvals, sources, perEnv] = await Promise.all([
			overviewRead(readsRuns, () => api.runs.list({ appId: params.id, limit: RECENT_RUNS })),
			overviewRead(decides, () => api.approvals.list()),
			overviewRead(readsErrors, () => operationsClient.sources()),
			Promise.all(frame.envs.map(async (env) => {
				const [published, last] = await Promise.all([
					publishedRun(env),
					overviewRead(access === null || mayDo(access, CONTROL_ACTIONS.DEPLOY_READ, at(env)), async () => {
						const page = await api.runs.list({ appId: params.id, env: env.env, limit: 1 })
						return page.items[0] ?? null
					}),
				])
				return { env: env.env, published, last }
			})),
		])
		const errors = await Promise.all(frame.envs.map(async (env): Promise<readonly [string, OpenErrors]> => {
			if (sources.data === null || (access !== null && !mayDo(access, OPERATIONS_ACTIONS.READ, at(env)))) return [env.env, { kind: 'unknown' }]
			const source = sources.data.items.find((candidate) => candidate.appId === params.id && candidate.environment === env.env)
			if (source === undefined) return [env.env, { kind: 'no-source' }]
			const read = await overviewRead(true, () => operationsClient.issues({ sourceId: source.id, status: 'open', window: 'all', limit: 1 }))
			return [env.env, read.data === null ? { kind: 'unknown' } : { kind: 'count', open: read.data.summary.open, sourceId: source.id }]
		}))
		return {
			...frame,
			runs,
			waiting: approvals.data?.items.filter((approval) => approval.run.appId === params.id) ?? [],
			perEnv: new Map(perEnv.map((entry) => [entry.env, entry])),
			errors: new Map(errors),
		}
	})
	.route('/apps/:id')
	.render(({ data }) => {
		const { app, envs, runs, waiting, perEnv, errors } = data
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
								published={perEnv.get(env.env)?.published ?? null}
								last={perEnv.get(env.env)?.last ?? { data: null, problem: 'unavailable' }}
								errors={errors.get(env.env) ?? { kind: 'unknown' }}
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

function EnvironmentRow({ env, state, published, last, errors }: {
	env: AppEnvDto
	state: EnvironmentState
	published: RunDto | null
	last: OverviewRead<RunDto | null>
	errors: OpenErrors
}) {
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
				{last.data === null
					? <span className="muted">{last.problem === null ? 'None' : 'Unknown'}</span>
					: (
						<div className="cell-stack">
							<Link to="runs/detail" params={{ id: last.data.id }}>
								<RunStatus status={last.data.status} />
							</Link>
							<span className="muted small" title={fmtDate(last.data.createdAt)}>{fmtAgo(last.data.createdAt)}</span>
						</div>
					)}
			</td>
			<td>
				{errors.kind === 'unknown'
					? <span className="muted">Unknown</span>
					: errors.kind === 'no-source' || errors.open === 0
					? <span className="muted">None</span>
					: <Link to="operations/errors" params={{ window: 'all', source: errors.sourceId }}>{errors.open} open</Link>}
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
