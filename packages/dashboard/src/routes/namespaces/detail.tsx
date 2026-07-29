import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { NamespaceSignature } from '../../components/NamespaceSignature'
import { api, ApiError, type DeploymentNamespaceDetailDto } from '../../lib/api'
import { fmtDate } from '../../lib/format'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ namespace: await api.get<DeploymentNamespaceDetailDto>(`/namespaces/${params.id}`) }))
	.route('/namespaces/:id')
	.render(({ data, invalidate }) => {
		const { namespace } = data
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function reconcile() {
			setBusy(true)
			setError(null)
			try {
				await api.post<DeploymentNamespaceDetailDto>(`/namespaces/${namespace.id}/reconcile`)
				setBusy(false)
				invalidate()
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Namespace reconcile failed.')
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>{namespace.id}</h1>
							<div className="subtitle muted">
								Created {fmtDate(namespace.createdAt)} · target envelope <code>{namespace.target.provider}@{namespace.target.version}</code>
							</div>
						</div>
						<Link to="namespaces" className="nav-cta">All namespaces →</Link>
					</div>
				</div>

				<NamespaceSignature
					id={namespace.id}
					env={namespace.env}
					provider={namespace.provider}
					exclusiveAppId={namespace.exclusiveAppId}
					state={namespace.state}
					presentation={namespace.presentation}
				/>

				{namespace.lastError !== null && (
					<div className="panel namespace-failure" role="alert">
						<strong>Last operation failed.</strong>
						<div className="error-text">{namespace.lastError}</div>
					</div>
				)}

				<div className="toolbar namespace-detail-actions">
					<button type="button" className="primary" disabled={busy} onClick={reconcile}>
						{busy ? 'Reconciling…' : 'Reconcile placement'}
					</button>
					<span className="hint">Re-apply the provider-owned boundary and refresh its durable checkpoint.</span>
				</div>
				{error && <p className="error-text" role="alert">{error}</p>}
			</>
		)
	})
