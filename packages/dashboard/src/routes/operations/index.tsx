import { createPage, Link } from '@buzola/router'
import { Status } from '../../components/Status'
import { needsMonitoringAttention } from '../../lib/health'
import { operationsClient } from '../../operations/client'
import { PageHead } from '../../operations/components/PageHead'

export default createPage()
	.loader(async () => {
		const [issues, sources, releases, health] = await Promise.all([
			operationsClient.issues({ limit: 1 }),
			operationsClient.sources(),
			operationsClient.releases({ limit: 1 }),
			operationsClient.health(),
		])
		return { issues, sources, releases, health, loadedAt: Date.now() }
	})
	.route('/operations')
	.render(({ data }) => {
		const unhealthy = data.health.sources.filter((source) => needsMonitoringAttention(source, data.loadedAt)).length
		const hasSources = data.health.sources.some((source) => source.source.enabled)
		return (
			<>
				<PageHead
					title="Operations overview"
					description="Investigate failures, connect them to releases, and watch the runtime signals that explain impact."
				/>
				<div className="ops-capabilities">
					<Capability
						to="operations/errors"
						title="Errors"
						body="Grouped application failures, occurrence context and operator triage."
						state={`${data.issues.summary.open} open`}
						lamp={data.issues.summary.open > 0 ? 'stop' : 'ok'}
					/>
					<Capability
						to="operations/sources"
						title="Sources"
						body="The applications, environments and services that send telemetry."
						state={`${data.sources.items.length} configured`}
						lamp="idle"
					/>
					<Capability
						to="operations/releases"
						title="Releases"
						body="Release markers that connect a deploy with regressions and resolved issues."
						state={data.releases.items.length === 0 ? 'No releases' : `Latest ${data.releases.items[0]?.releaseName ?? ''}`}
						lamp={data.releases.items.length === 0 ? 'idle' : 'ok'}
					/>
					<Capability
						to="operations/health"
						title="Health"
						body="Service signals and telemetry pipeline delivery."
						state={!hasSources ? 'No active sources' : unhealthy === 0 ? 'No monitoring alerts' : `${unhealthy} need attention`}
						lamp={!hasSources ? 'idle' : unhealthy === 0 ? 'ok' : 'stop'}
					/>
				</div>
			</>
		)
	})

function Capability(
	{ to, title, body, state, lamp }: {
		to: 'operations/errors' | 'operations/sources' | 'operations/releases' | 'operations/health'
		title: string
		body: string
		state: string
		lamp: 'ok' | 'stop' | 'idle'
	},
) {
	return (
		<Link to={to} className="card ops-capability">
			<div className="card-head">
				<h2>{title}</h2>
				<span className="spacer" />
				<Status lamp={lamp} title={state}>
					<span className="truncate">{state}</span>
				</Status>
			</div>
			<div className="card-body">
				<p>{body}</p>
			</div>
		</Link>
	)
}
