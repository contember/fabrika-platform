import { Link } from '@buzola/router'
import { appEnvironmentId } from '@fabrika/auth-core'
import type { AppEnvDto } from '../../lib/api'
import type { RoleHolders } from '../../lib/role-holders'
import { AccessMapView } from '../AccessMap'

/**
 * One environment's published access read by role: `holders` counts who holds each role (null when IAM gave no count),
 * and a caller who administers its people (`people`) gets the link to them.
 */
export function AccessMapSection({ env, people, holders = null }: { env: AppEnvDto; people: boolean; holders?: RoleHolders | null }) {
	const map = env.accessMap
	// A Control released before the map sends none: nothing to say about roles then.
	if (map === undefined) return null
	return (
		<section>
			<div className="section-head">
				<h2>Roles</h2>
				<span className="spacer" />
				{people && <Link to="people" params={{ app: appEnvironmentId(env.appId, env.env) }}>Who holds them</Link>}
			</div>
			<p className="section-note">What each role may do on {env.env}: the actions it holds, and the endpoints and data each one reaches.</p>
			{map.roles.length > 0
				? <AccessMapView map={map} holders={holders} />
				: env.publishedRunId === null
				? <p className="muted">No roles are published on {env.env} yet.</p>
				: <p className="muted">The release published on {env.env} declares no roles.</p>}
		</section>
	)
}
