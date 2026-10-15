import { Outlet } from '@buzola/router'
import { iamAdministrationScope } from '@fabrika/iam-contract'
import { AdministrationProvider } from '../../access/lib/administration'
import { AppNamesProvider, useLoadedAppNames } from '../../access/lib/app-names'
import { useMe } from '../../access/lib/useMe'
import { RouteError } from '../../components/RouteError'

export default function AccessLayout() {
	const me = useMe()
	const names = useLoadedAppNames()

	const administration = me.status === 'ok' ? iamAdministrationScope(me.me.permissions) : null
	if (me.status === 'forbidden' || (me.status === 'ok' && administration === null)) {
		return (
			<div className="gate-screen">
				<p className="eyebrow">Access plane</p>
				<h1>IAM admin access required</h1>
				<p>
					Your session is valid, but it holds neither <code>iam.admin</code> nor{' '}
					<code>iam.users.manage</code>. Ask an installation administrator to grant the <code>admin</code> role, or <code>user-admin</code> at Access.
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

	// The pages below offer what the caller administers, so they wait for IAM to say what that is.
	if (administration === null) return <div className="loading">Connecting to IAM…</div>

	return (
		<AdministrationProvider administration={administration}>
			<AppNamesProvider names={names}>
				<Outlet
					fallback={<div className="loading">Connecting to IAM…</div>}
					errorFallback={(error) => <RouteError error={error} />}
				/>
			</AppNamesProvider>
		</AdministrationProvider>
	)
}
