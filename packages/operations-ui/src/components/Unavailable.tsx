import type { ReactNode } from 'react'

export function PageHead({ title, description }: { title: string; description: string }) {
	return (
		<div className="page-head">
			<p className="eyebrow">Operations plane</p>
			<h1>{title}</h1>
			<p className="hint">{description}</p>
		</div>
	)
}

export function Unavailable({ children }: { children: ReactNode }) {
	return (
		<div className="empty-panel">
			<div className="empty-state">
				<span className="ops-unavailable-mark" aria-hidden="true">—</span>
				<strong className="empty-title">Operator data is not available yet</strong>
				<span className="empty-body">{children}</span>
			</div>
		</div>
	)
}

export function OperationsRouteError({ error }: { error: unknown }) {
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
