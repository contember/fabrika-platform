import { Outlet } from '@buzola/router'
import { RouteError } from '@fabrika/iam-ui/route-error'
import { useMe } from '@fabrika/iam-ui/use-me'

export default function AccessLayout() {
	const me = useMe()

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
		<Outlet
			fallback={<div className="loading">Connecting to IAM…</div>}
			errorFallback={(error) => <RouteError error={error} />}
		/>
	)
}
