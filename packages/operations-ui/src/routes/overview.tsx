import { createPage, Link } from '@buzola/router'
import { operationsClient } from '../client'
import { PageHead } from '../components/Unavailable'

export default createPage()
	.loader(async () => {
		const [issues, sources, releases, health] = await Promise.all([
			operationsClient.issues({ limit: 1 }),
			operationsClient.sources(),
			operationsClient.releases({ limit: 1 }),
			operationsClient.health(),
		])
		return { issues, sources, releases, health }
	})
	.route('/operations')
	.render(({ data }) => {
		const unhealthy = data.health.sources.filter((source) =>
			source.telemetryState !== 'healthy'
			|| source.httpChecks.some((check) => check.enabled && (check.current === null || check.current.state !== 'healthy'))
		).length
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
						state={unhealthy === 0 ? 'All healthy' : `${unhealthy} need attention`}
						lamp={unhealthy === 0 ? 'ok' : 'stop'}
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
				<span className={`status status-${lamp}`}>
					<span className="lamp" aria-hidden="true" />
					{state}
				</span>
			</div>
			<div className="card-body">
				<p>{body}</p>
			</div>
		</Link>
	)
}
