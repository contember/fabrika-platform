import { Outlet } from '@buzola/router'

export default function OperationsLayout() {
	return (
		<Outlet
			fallback={<div className="loading">Connecting to Operations…</div>}
			errorFallback={(error) => <OperationsUnavailable error={error} />}
		/>
	)
}

// The plane's own outage screen, not RouteError: an Operations outage must read as bounded to this plane.
function OperationsUnavailable({ error }: { error: unknown }) {
	const message = error instanceof Error ? error.message : 'The Operations page could not be loaded.'
	return (
		<div className="gate-screen">
			<p className="eyebrow">Operations plane</p>
			<h1>Operations is unavailable</h1>
			<p className="error-text">{message}</p>
			<button type="button" onClick={() => location.reload()}>Retry connection</button>
		</div>
	)
}
