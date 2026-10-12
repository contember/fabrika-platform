import type { AppEnvDto } from '../../lib/api'
import { CloserReview } from '../CloserReview'
import { Icon } from '../Icon'
import { Chip } from '../Status'

/** What each environment's published access reaches off the paved road, protected or not. Nothing when none does. */
export function DeviationsSection({ envs }: { envs: readonly AppEnvDto[] }) {
	const listed = envs.filter((env) => env.deviations.length > 0)
	if (listed.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="alert" size={15} />
				<h2>Off the paved road</h2>
			</div>
			<p className="hint">
				The published access reaches beyond its endpoints' capabilities here: declared raw SQL, unscoped tables, connectors, share links and database
				code. A new one waits for approval on a protected environment.
			</p>
			{listed.map((env) => (
				<div key={env.env}>
					<h3>
						<Chip>{env.env}</Chip>
						{env.protected && <span className="muted small">protected</span>}
					</h3>
					<ul className="change-list">
						{env.deviations.map((line) => (
							<li key={line}>
								{line} <CloserReview />
							</li>
						))}
					</ul>
				</div>
			))}
		</section>
	)
}
