import { Link } from '@buzola/router'
import type { AppEnvDto } from '../../lib/api'
import { Icon } from '../Icon'
import { Chip } from '../Status'

/**
 * What each environment's published access reaches off the paved road, protected or not. Nothing when none does. An
 * inventory of what is already published, so no line carries the approval page's "needs closer review" mark.
 */
export function DeviationsSection({ envs }: { envs: readonly AppEnvDto[] }) {
	const listed = envs.filter((env) => env.deviationSubjects.length > 0)
	if (listed.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Off the paved road</h2>
			</div>
			<p className="hint">
				What each environment's published access already takes beyond its endpoints' capabilities: declared raw SQL, unscoped tables, connectors, share
				links, e-mail and database code. Nothing here waits for anyone. A new step waits for approval in its deploy's access change on a protected
				environment. A line disappears when a later deploy no longer declares it: move the endpoint onto the paved road, with scoped tables and the query
				builder instead of declared raw SQL.
			</p>
			{listed.map((env) => <EnvironmentDeviations key={env.env} env={env} />)}
		</section>
	)
}

function EnvironmentDeviations({ env }: { env: AppEnvDto }) {
	const steps = env.deviationSubjects.reduce((count, subject) => count + subject.steps.length, 0)
	return (
		<details className="deviations">
			<summary>
				<Chip>{env.env}</Chip>
				{env.protected && <span className="muted small">protected</span>}
				<span>
					{steps === 1 ? '1 step' : `${steps} steps`} off the paved road, published
					{env.publishedRunId !== null && (
						<>
							{' by '}
							<Link to="runs/detail" params={{ id: env.publishedRunId }}>
								run <code>{env.publishedRunId.slice(0, 8)}</code>
							</Link>
						</>
					)}
				</span>
			</summary>
			<ul className="deviation-subjects">
				{env.deviationSubjects.map((subject) => (
					<li key={subject.subject}>
						{subject.subject}
						<ul className="change-list">
							{subject.steps.map((step) => <li key={step}>{step}</li>)}
						</ul>
					</li>
				))}
			</ul>
		</details>
	)
}
