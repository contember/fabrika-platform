import type { AppEnvDto } from '../../lib/api'

/**
 * What one environment's published access reaches off the paved road, protected or not; nothing when it stays on it. An
 * inventory of what is already published, so no line carries the approval page's "needs closer review" mark.
 */
export function DeviationsSection({ env }: { env: AppEnvDto }) {
	if (env.deviationSubjects.length === 0) return null
	const steps = env.deviationSubjects.reduce((count, subject) => count + subject.steps.length, 0)
	return (
		<section>
			<div className="section-head">
				<h2>Off the paved road</h2>
			</div>
			<p className="section-note">
				{steps === 1 ? '1 step' : `${steps} steps`} beyond what{' '}
				{env.env}'s endpoints declare as capabilities: raw SQL, unscoped tables, connectors, share links, e-mail or database code. Nothing here waits for
				anyone.
			</p>
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
		</section>
	)
}
