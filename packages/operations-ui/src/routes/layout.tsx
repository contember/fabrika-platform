import { Outlet } from '@buzola/router'
import { OperationsRouteError } from '../components/Unavailable'

export default function OperationsLayout() {
	return (
		<Outlet
			fallback={<div className="loading">Connecting to Operations…</div>}
			errorFallback={(error) => <OperationsRouteError error={error} />}
		/>
	)
}
