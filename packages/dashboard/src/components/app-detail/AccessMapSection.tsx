import { Link } from '@buzola/router'
import { appEnvironmentId } from '@fabrika/auth-core'
import type { AppEnvDto } from '../../lib/api'
import { AccessMapView } from '../AccessMap'

/** One environment's published access read by role, and where to see who holds each role. */
export function AccessMapSection({ env, people }: { env: AppEnvDto; people: boolean }) {
	const map = env.accessMap
	return (
		<section>
			<div className="section-head">
				<h2>Roles</h2>
				<span className="spacer" />
				{people && <Link to="people" params={{ app: appEnvironmentId(env.appId, env.env) }}>Who holds them</Link>}
			</div>
			<p className="section-note">What each role may do on {env.env}: the actions it holds, and the endpoints and data each one reaches.</p>
			{map === undefined || map.roles.length === 0 ? <p className="muted">No roles are published on {env.env} yet.</p> : <AccessMapView map={map} />}
		</section>
	)
}
