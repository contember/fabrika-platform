import { Outlet } from '@buzola/router'
import { AppNamesProvider, useLoadedAppNames } from '../../access/lib/app-names'
import { useMe } from '../../access/lib/useMe'
import { RouteError } from '../../components/RouteError'

export default function AccessLayout() {
	const me = useMe()
	const names = useLoadedAppNames()

	if (me.status === 'forbidden') {
		return (
			<div className="gate-screen">
				<p className="eyebrow">Access plane</p>
				<h1>IAM admin access required</h1>
				<p>
					Your session is valid, but it does not include <code>iam.admin</code>. Ask an IAM administrator to grant the <code>admin</code> role.
				</p>
			</div>
		)
	}

	if (me.status === 'error') {
		return (
			<div className="gate-screen">
				<p className="eyebrow">Access plane</p>
				<h1>IAM is unavailable</h1>
				<p className="error-text">{me.message}</p>
				<button type="button" onClick={() => location.reload()}>Retry connection</button>
			</div>
		)
	}

	return (
		<AppNamesProvider names={names}>
			<Outlet
				fallback={<div className="loading">Connecting to IAM…</div>}
				errorFallback={(error) => <RouteError error={error} />}
			/>
		</AppNamesProvider>
	)
}
