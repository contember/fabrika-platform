import { createPage, Link, useNavigate } from '@buzola/router'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { NamespaceSignature } from '../../components/NamespaceSignature'
import { Table } from '../../components/Table'
import { api, ApiError } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import {
	canUpdateNamespace,
	isNamespaceSettling,
	namespaceFailure,
	namespaceUpdateSeed,
	parseNamespaceTarget,
	retainedNamespaceResources,
	scheduleNamespacePoll,
} from '../../lib/namespaces'

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
		const [confirmingRemoval, setConfirmingRemoval] = useState(false)
		const [editedTarget, setEditedTarget] = useState<string | null>(null)
		const [updating, setUpdating] = useState(false)
		const [updateError, setUpdateError] = useState<string | null>(null)
		const navigate = useNavigate()
		const settling = isNamespaceSettling(namespace.state)
		const failure = namespaceFailure(namespace)
		const retained = retainedNamespaceResources(namespace)
		const hosts = namespace.hosts ?? []

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

		// Synchronous, unlike reconcile: an in-place change is one provider call plus its read-back, so the
		// answer (or the 409 naming the supported path) comes back in this request.
		async function updateTarget(event: React.FormEvent) {
			event.preventDefault()
			if (editedTarget === null) return
			const parsed = parseNamespaceTarget(editedTarget, namespace.target.provider)
			if (!parsed.ok) {
				setUpdateError(parsed.error)
				return
			}
			setUpdating(true)
			setUpdateError(null)
			try {
				await api.namespaces.update({ namespaceId: namespace.id, namespace: { target: parsed.target } })
				setUpdating(false)
				setEditedTarget(null)
				invalidate()
			} catch (cause) {
				setUpdateError(cause instanceof ApiError ? cause.message : 'Namespace update failed.')
				setUpdating(false)
			}
		}

		// `ConfirmDialog` owns its own busy state and surfaces the API refusal (409 while an app is
		// registered, or while a worker is settling the placement) inside the dialog.
		async function remove() {
			await api.namespaces.remove({ namespaceId: namespace.id })
			navigate('namespaces')
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

				{/* Only a placement that publishes its own hosts has any; a custom-domain one names none. */}
				{hosts.length > 0 && (
					<section>
						<div className="section-head">
							<Icon name="globe" size={15} />
							<h2>Served hosts</h2>
						</div>
						<Table
							colSpan={3}
							head={
								<tr>
									<th className="grow">Host</th>
									<th>Port</th>
									<th>Taken by</th>
								</tr>
							}
						>
							{hosts.map((entry) => (
								<tr key={entry.host}>
									<td>
										<code>{entry.host}</code>
									</td>
									<td>{entry.port}</td>
									<td>
										{entry.takenBy === undefined
											? <span className="muted">free</span>
											: <Link to="apps/detail" params={{ id: entry.takenBy.appId }}>{entry.takenBy.appId}/{entry.takenBy.environment}</Link>}
									</td>
								</tr>
							))}
						</Table>
					</section>
				)}

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

				{failure !== null && (
					<div className="notice notice-bad" role="alert">
						<Icon name="alert" size={15} />
						<span>
							<strong>
								Last operation failed{failure.code === null ? '.' : ':'} {failure.code !== null && <code>{failure.code}</code>}
							</strong>
							<div className="error-text">{failure.message}</div>
							{failure.hint !== null && <div className="muted small">{failure.hint}</div>}
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

				{canUpdateNamespace(namespace) && (
					<section>
						<div className="section-head">
							<Icon name="schema" size={15} />
							<h2>Provider target</h2>
						</div>
						{editedTarget === null
							? (
								<div className="toolbar">
									<button type="button" onClick={() => setEditedTarget(JSON.stringify(namespaceUpdateSeed(namespace), null, 2))}>
										{namespace.unconfirmedTarget === undefined ? 'Change target' : 'Finish the unconfirmed update'}
									</button>
									<span className="hint">
										Only what the provider changes in place is accepted: on Zerops, the PostgreSQL profile. A payload may name only what changes.
									</span>
								</div>
							)
							: (
								<form onSubmit={updateTarget}>
									<label>
										Target envelope
										<textarea
											required
											rows={12}
											value={editedTarget}
											onChange={(event) => setEditedTarget(event.target.value)}
											autoComplete="off"
											spellCheck={false}
										/>
										<span className="hint">A change the provider cannot apply in place is refused, and the refusal names the supported path.</span>
									</label>
									<div className="toolbar">
										<button type="submit" disabled={updating}>{updating ? 'Applying…' : 'Apply target'}</button>
										<button
											type="button"
											className="ghost"
											disabled={updating}
											onClick={() => {
												setEditedTarget(null)
												setUpdateError(null)
											}}
										>
											Cancel
										</button>
									</div>
								</form>
							)}
						{updateError && <p className="error-text" role="alert">{updateError}</p>}
					</section>
				)}

				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Remove this placement</strong>
						{/* Frees the id so a retry reuses the SAME name the provider's recovery is keyed to. */}
						Frees its id and releases its reservations. Nothing is deleted at the provider.
					</div>
					<span className="spacer" />
					{/* Only a namespace a worker is settling is off limits; a stuck `pending` row must be removable. */}
					<button type="button" className="danger" disabled={namespace.state === 'provisioning'} onClick={() => setConfirmingRemoval(true)}>
						<Icon name="trash" size={14} />
						Remove placement
					</button>
				</div>
				{confirmingRemoval && (
					<ConfirmDialog
						title="Remove placement"
						confirmLabel="Remove placement"
						body={
							<>
								<p>
									Remove{' '}
									<strong>{namespace.id}</strong>? This frees the id and releases its reservations. It is refused while any application environment is
									registered here.
								</p>
								{retained.length > 0 && (
									<>
										<p>These provider resources stay. Removing them is yours to do:</p>
										<ul>
											{retained.map((fact) => <li key={fact.label}>{fact.label}: {fact.value}</li>)}
										</ul>
									</>
								)}
							</>
						}
						onConfirm={remove}
						onClose={() => setConfirmingRemoval(false)}
					/>
				)}
			</>
		)
	})
