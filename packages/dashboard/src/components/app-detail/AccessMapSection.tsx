import type { AppEnvDto } from '../../lib/api'
import { AccessMapView } from '../AccessMap'
import { Icon } from '../Icon'
import { Chip } from '../Status'

/** Each environment's published access read by role. Nothing until a run publishes, or from an older Control. */
export function AccessMapSection({ envs }: { envs: readonly AppEnvDto[] }) {
	const listed = envs.flatMap((env) => (env.accessMap !== undefined && env.accessMap.roles.length > 0 ? [{ env: env.env, map: env.accessMap }] : []))
	if (listed.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Access by role</h2>
			</div>
			<p className="hint">
				What each role of the published contract may do: the actions it holds, the endpoints that require each one, and the tables and people they reach.
			</p>
			{listed.map(({ env, map }) => (
				<div key={env}>
					<h3>
						<Chip>{env}</Chip>
					</h3>
					<AccessMapView map={map} />
				</div>
			))}
		</section>
	)
}
