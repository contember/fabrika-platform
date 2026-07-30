import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
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
					<Link to="namespaces" className="back-link">
						<Icon name="chevron-left" size={14} />
						All namespaces
					</Link>
					<h1>{namespace.id}</h1>
					<div className="subtitle">
						Created {fmtDate(namespace.createdAt)}
						<span className="dot-sep">
							target envelope <code>{namespace.target.provider}@{namespace.target.version}</code>
						</span>
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
					<div className="notice notice-bad" role="alert">
						<Icon name="alert" size={15} />
						<span>
							<strong>Last operation failed.</strong>
							<div className="error-text">{namespace.lastError}</div>
						</span>
					</div>
				)}

				<div className="toolbar namespace-detail-actions">
					<button type="button" className="primary" disabled={busy} onClick={reconcile}>
						<Icon name="refresh" size={14} />
						{busy ? 'Reconciling…' : 'Reconcile placement'}
					</button>
					<span className="hint">Re-apply the provider-owned boundary and refresh its durable checkpoint.</span>
				</div>
				{error && <p className="error-text" role="alert">{error}</p>}
			</>
		)
	})
