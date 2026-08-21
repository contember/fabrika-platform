import { createPage, Link } from '@buzola/router'
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { NamespaceSignature } from '../../components/NamespaceSignature'
import { api, ApiError } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { isNamespaceSettling, scheduleNamespacePoll } from '../../lib/namespaces'

// Provisioning runs behind the queue and takes minutes, so this page follows it rather than waiting on
// a request: `reconcile` returns the moment the job is enqueued and the poll below reports the outcome.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ namespace: await api.namespaces.get({ namespaceId: params.id }) }))
	.route('/namespaces/:id')
	.render(({ data, invalidate }) => {
		const { namespace } = data
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)
		const settling = isNamespaceSettling(namespace.state)

		useEffect(() => {
			return scheduleNamespacePoll(namespace.state, invalidate, (callback, delayMs) => {
				const timer = window.setTimeout(callback, delayMs)
				return () => window.clearTimeout(timer)
			})
		}, [namespace, invalidate])

		async function reconcile() {
			setBusy(true)
			setError(null)
			try {
				await api.namespaces.reconcile({ namespaceId: namespace.id })
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

				{settling && (
					<div className="notice">
						<Icon name="refresh" size={15} />
						<span>
							<strong>{namespace.state === 'pending' ? 'Queued.' : 'Provisioning.'}</strong>
							<div className="muted small">
								The provider mutation runs behind the queue and takes several minutes. This page follows it; closing it changes nothing.
							</div>
						</span>
					</div>
				)}

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
					{/* Safe while settling: a reconcile of a non-terminal namespace only re-arms the job. */}
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
