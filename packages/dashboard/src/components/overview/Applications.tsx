import { Link } from '@buzola/router'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { useState } from 'react'
import type { AppEnvDto } from '../../lib/api'
import { mayDo, mayOpen } from '../../lib/console-access'
import { fmtAgo, shortSha } from '../../lib/format'
import { runtimeHealth, unhealthyTelemetry } from '../../lib/health'
import { boundedCount, environmentSources, isProduction, OVERVIEW_APP_LIMIT, type OverviewData } from '../../lib/overview'
import { FilterGroup } from '../FilterGroup'
import { Chip, Status } from '../Status'
import { Panel } from './Panel'

export function Applications({ data, initialFilter = 'all' }: { data: OverviewData; initialFilter?: 'all' | 'production' }) {
	const [productionOnly, setProductionOnly] = useState(initialFilter === 'production')
	const allApps = data.apps.data?.items ?? []
	const apps = allApps.slice(0, OVERVIEW_APP_LIMIT)
	const allEnvs = [...data.environments.values()].flatMap((read) => read.data?.items ?? [])
	const envCount = allEnvs.length
	const monitored = allEnvs.filter((env) => runtimeHealth(environmentSources(data, env.appId, env.env), data.loadedAt).monitored).length
	const failedReads = [...data.environments.values()].some((read) => read.problem !== null)
	return (
		<Panel
			title="Applications & environments"
			meta={
				<span className="ov-section-note">
					{allApps.length} applications · {boundedCount(envCount, failedReads || allApps.length > apps.length)} environments
				</span>
			}
			aside={
				<FilterGroup
					label="Environment filter"
					options={[{ value: 'all', label: 'All environments' }, { value: 'production', label: 'Production' }]}
					value={productionOnly ? 'production' : 'all'}
					onChange={(value) => setProductionOnly(value === 'production')}
				/>
			}
		>
			<div className="ov-table-scroll">
				<table className="ov-app-table" aria-label="Applications and environments">
					<thead>
						<tr>
							<th className="grow">Application / environment</th>
							<th>Runtime health</th>
							<th>Published release</th>
							<th>Errors</th>
						</tr>
					</thead>
					<tbody>
						{apps.map((app) => {
							const read = data.environments.get(app.id)
							if (read?.data == null || read.data.items.length === 0) {
								// No environment to show is not a production one either.
								if (productionOnly) return null
								return (
									<tr key={app.id}>
										<td>
											<Link to="apps/detail" params={{ id: app.id }}>{app.id}</Link>
										</td>
										<td colSpan={3} className="muted">
											{read?.data == null ? 'Environments could not be read' : 'No environments configured'}
										</td>
									</tr>
								)
							}
							return read.data.items.filter((env) => !productionOnly || isProduction(env.env)).map((env) => (
								<Environment key={`${app.id}:${env.env}`} env={env} data={data} />
							))
						})}
					</tbody>
				</table>
			</div>
			{data.apps.problem !== null && (
				<p className="ov-empty">Applications {data.apps.problem === 'forbidden' ? 'are not available with your access' : 'could not be loaded'}.</p>
			)}
			{productionOnly && allEnvs.every((env) => !isProduction(env.env)) && <p className="ov-empty">No visible environments named prod or production.</p>}
			<div className="ov-panel-foot">
				<span>
					{data.health.data === null ? 'Monitoring coverage is unknown' : `HTTP checks cover ${monitored} of ${envCount} visible environments`}
					{failedReads ? ' · Some environments are unreadable' : ''}
				</span>
				{allApps.length > apps.length && <Link to="apps">All {allApps.length} applications →</Link>}
				{mayOpen(data.caller, 'operations/health') && <Link to="operations/health">View monitoring →</Link>}
			</div>
		</Panel>
	)
}

function Environment({ env, data }: { env: AppEnvDto; data: OverviewData }) {
	const sources = environmentSources(data, env.appId, env.env)
	const health = runtimeHealth(sources, data.loadedAt)
	const telemetryUnknown = sources === null || sources.length === 0 || sources.some(unhealthyTelemetry)
	const readable = mayDo(data.caller.access, OPERATIONS_ACTIONS.READ, { app: env.appId, env: env.env })
	const issues = data.issues.data?.items.filter((issue) => issue.source.appId === env.appId && issue.source.environment === env.env) ?? []
	const regressions = issues.filter((issue) => issue.regressedAt !== null).length
	// The Errors page narrows to one source; an environment with several has no page of its own errors, so its count is
	// no link (an unfiltered one would list every application's errors).
	const errorFilter = sources?.length === 1 && sources[0] !== undefined ? { window: 'all', source: sources[0].source.id } : null
	const published = env.publishedRunId === null ? null : data.publishedRuns.get(env.publishedRunId)?.data
	return (
		<tr>
			<td>
				<div className="ov-app-name">
					<Link to="apps/detail" params={{ id: env.appId }}>{env.appId}</Link>
					<Chip>{env.env}</Chip>
				</div>
				<span className="ov-domain">{env.publicOrigin?.replace(/^https?:\/\//, '') ?? env.domain ?? 'No public address'}</span>
			</td>
			<td>
				<Status lamp={health.lamp}>{health.label}</Status>
				<small className="ov-cell-note">{health.note}</small>
			</td>
			<td>
				{env.publishedRunId === null ? <span className="muted">Not published</span> : (
					<>
						<Link to="runs/detail" params={{ id: env.publishedRunId }} className="ov-release-link">
							<code>{published?.commitSha ? shortSha(published.commitSha) : 'Published run'}</code>
						</Link>
						<small className="ov-cell-note">{published?.finishedAt ? fmtAgo(published.finishedAt, data.loadedAt) : 'Current publication'}</small>
					</>
				)}
			</td>
			<td>
				{!readable || data.issues.data === null || telemetryUnknown
					? (
						<>
							<span className="muted">Unknown</span>
							{readable && issues.length > 0 && (
								<small className="ov-cell-note">
									{errorFilter === null
										? `${issues.length} recorded open`
										: <Link to="operations/errors" params={errorFilter}>{issues.length} recorded open</Link>}
								</small>
							)}
						</>
					)
					: (
						<>
							{errorFilter === null
								? <span>{boundedCount(issues.length, data.issues.data.nextCursor !== null)} open</span>
								: <Link to="operations/errors" params={errorFilter}>{boundedCount(issues.length, data.issues.data.nextCursor !== null)} open</Link>}
							{regressions > 0 && <small className="ov-cell-note">{regressions} {regressions === 1 ? 'regression' : 'regressions'}</small>}
						</>
					)}
				{telemetryUnknown && <small className="ov-cell-note">{sources?.length === 0 ? 'No telemetry source' : 'Telemetry not current'}</small>}
			</td>
		</tr>
	)
}
