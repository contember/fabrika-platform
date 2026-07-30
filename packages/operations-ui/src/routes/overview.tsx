import { createPage, Link } from '@buzola/router'
import { PageHead } from '../components/Unavailable'

export default createPage()
	.route('/operations')
	.render(() => (
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
					state="Issue model ready"
				/>
				<Capability
					to="operations/sources"
					title="Sources"
					body="The applications, environments and services that send telemetry."
					state="Catalog boundary ready"
				/>
				<Capability
					to="operations/releases"
					title="Releases"
					body="Release markers that connect a deploy with regressions and resolved issues."
					state="Contract pending"
				/>
				<Capability
					to="operations/health"
					title="Health"
					body="Service signals and telemetry pipeline delivery."
					state="Contract pending"
				/>
			</div>
		</>
	))

function Capability(
	{ to, title, body, state }: {
		to: 'operations/errors' | 'operations/sources' | 'operations/releases' | 'operations/health'
		title: string
		body: string
		state: string
	},
) {
	return (
		<Link to={to} className="card ops-capability">
			<div className="card-head">
				<h2>{title}</h2>
				<span className="spacer" />
				<span className="status status-idle">
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
