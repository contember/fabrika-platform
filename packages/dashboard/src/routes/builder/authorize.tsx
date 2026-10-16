import { createPage, Link } from '@buzola/router'
import type { BuilderApprovalState } from '@fabrika/control-contract'
import { useEffect, useState } from 'react'
import { BuilderApplicationSelection } from '../../components/builder/BuilderApplicationSelection'
import { OwnBuilderConnections } from '../../components/builder/OwnBuilderConnections'
import { Icon } from '../../components/Icon'
import {
	api,
	ApiError,
	type AppDto,
	type BuilderConnectionEnvironmentDto,
	type BuilderConnectionReceiptDto,
	type DeviceAuthorizationRequest,
} from '../../lib/api'
import {
	approvalProof,
	approveBuilderSelection,
	builderRequestError,
	clearBuilderApproval,
	pairingFailure,
	readBuilderApproval,
	START_AGAIN,
} from '../../lib/builder-authorization'

export default createPage().route('/builder/authorize').render(() => <BuilderAuthorization />)

interface Selection {
	app: AppDto
	environment: BuilderConnectionEnvironmentDto
}

export function BuilderAuthorization() {
	const [approval, setApproval] = useState<BuilderApprovalState | null>(null)
	const [request, setRequest] = useState<DeviceAuthorizationRequest | null>(null)
	const [selection, setSelection] = useState<Selection | null>(null)
	const [receipt, setReceipt] = useState<BuilderConnectionReceiptDto | null>(null)
	const [locked, setLocked] = useState(false)
	const [busy, setBusy] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [origin, setOrigin] = useState('<console-origin>')

	function finish(message: string) {
		const cleared = clearBuilderApproval(() => window.sessionStorage)
		setApproval(null)
		setRequest(null)
		setNotice(message)
		if (!cleared) setError('The decision completed, but tab storage could not be cleared. Close this tab before starting another connection.')
	}

	async function resume() {
		setBusy(true)
		setError(null)
		const stored = readBuilderApproval(() => window.sessionStorage)
		if (!stored.ok) {
			setApproval(null)
			setRequest(null)
			// Opened from the account menu: nothing is pending, and the page lists the person's connections.
			if (stored.missing !== true) setError(stored.message)
			setBusy(false)
			return
		}
		setApproval(stored.state)
		try {
			const inspected = await api.builderPairing.inspect(approvalProof(stored.state))
			if (!inspected.ok) {
				setRequest(null)
				setError(pairingFailure(inspected.reason))
				if (inspected.reason === 'expired' || inspected.reason === 'invalid_attempt') finish(pairingFailure(inspected.reason))
				return
			}
			try {
				const saved = await api.builderConnections.getReceipt({ attemptId: stored.state.attemptId })
				setReceipt(saved)
				setSelection({ app: saved.app, environment: saved.environment })
				setLocked(true)
				setNotice('A connection receipt already exists. Review the frozen selection and retry approval. The application is not recreated.')
			} catch (cause) {
				if (!(cause instanceof ApiError && cause.httpStatus === 404)) throw cause
			}
			setRequest(inspected.request)
		} catch (cause) {
			setRequest(null)
			setError(builderRequestError(cause, 'Could not inspect the pending connection or recover its receipt. Retry before it expires.'))
		} finally {
			setBusy(false)
		}
	}

	useEffect(() => {
		setOrigin(window.location.origin)
		void resume()
	}, [])
	useEffect(() => {
		if (!approval) return
		const timeout = window.setTimeout(() => {
			finish(`The connection expired. ${START_AGAIN}`)
		}, Math.max(0, approval.expiresAt * 1000 - Date.now()))
		return () => window.clearTimeout(timeout)
	}, [approval])

	async function approve() {
		if (!approval || !selection || !request) return
		if (approval.expiresAt * 1000 <= Date.now()) {
			finish(`The connection expired. ${START_AGAIN}`)
			return
		}
		setBusy(true)
		setError(null)
		setLocked(true)
		try {
			const result = await approveBuilderSelection(
				api,
				{
					...approvalProof(approval),
					appId: selection.app.id,
					environment: selection.environment,
				},
				(saved) => {
					setReceipt(saved)
					setSelection({ app: saved.app, environment: saved.environment })
					setNotice('Receipt saved. Approval is still pending; the application and placement remain available for recovery.')
				},
				receipt ? undefined : () => {
					setLocked(false)
					setNotice(
						'The selection was rejected and no accessible receipt was found. Change selection to reload the current environment or correct its placement, then review it again.',
					)
				},
			)
			if (!result.ok) {
				setError(pairingFailure(result.reason))
				if (result.reason === 'expired' || result.reason === 'invalid_attempt') finish(pairingFailure(result.reason))
				return
			}
			finish(
				`Approved. Return to your local builder to complete the connection. The machine key expires ${
					new Date(result.consent.keyExpiresAt * 1000).toLocaleString()
				}. Only the local daemon can redeem it.`,
			)
		} catch (cause) {
			setError(
				builderRequestError(
					cause,
					'Connection approval was not confirmed. The app remains registered and a receipt may already be saved. Retry this exact selection or reload to recover its receipt; do not create a duplicate app.',
				),
			)
		} finally {
			setBusy(false)
		}
	}

	async function deny() {
		if (!approval) return
		setBusy(true)
		setError(null)
		try {
			const result = await api.builderPairing.deny(approvalProof(approval))
			if (!result.ok) {
				setError(pairingFailure(result.reason))
				if (result.reason === 'expired' || result.reason === 'invalid_attempt') finish(pairingFailure(result.reason))
				return
			}
			finish('Connection denied. Any application or receipt already created remains registered. Return to your local builder to start again if needed.')
		} catch (cause) {
			setError(builderRequestError(cause, 'Denial was not confirmed. Retry or let the connection expire.'))
		} finally {
			setBusy(false)
		}
	}

	return (
		<>
			<div className="page-head">
				<Link to="apps" className="back-link">
					<Icon name="chevron-left" size={14} />Applications
				</Link>
				<h1>Connect a local builder</h1>
				<p className="hint">Review the application and initial placement, then authorize your local daemon.</p>
			</div>
			{notice && <p role="status">{notice}</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			{busy && <p role="status">Checking or saving the connection…</p>}
			{!request && approval && <button type="button" disabled={busy} onClick={() => void resume()}>Retry pending connection</button>}
			{request && approval && (
				<>
					<p className="hint">This request expires {new Date(request.expiresAt * 1000).toLocaleString()}.</p>
					{!selection && !busy && <BuilderApplicationSelection onSelect={(app, environment) => setSelection({ app, environment })} />}
					{selection && (
						<>
							<BuilderConsentReview app={selection.app} environment={selection.environment} keyLifetimeSeconds={request.keyLifetimeSeconds} />
							{receipt && (
								<p role="status">Receipt saved for {receipt.app.id} / {receipt.environment.env}. This is deployment intent, not a resource reservation.</p>
							)}
							<p className="hint">The application remains registered even if you deny or approval fails.</p>
							<div className="form-actions">
								<button className="primary" type="button" disabled={busy} onClick={() => void approve()}>
									{busy ? 'Saving…' : locked ? 'Retry approval of this selection' : 'Approve connection'}
								</button>
								{!locked && <button type="button" disabled={busy} onClick={() => setSelection(null)}>Change selection</button>}
							</div>
						</>
					)}
				</>
			)}
			{approval && (
				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Deny this connection</strong>No machine key will be issued for a denied request.
					</div>
					<button type="button" className="danger" disabled={busy} onClick={() => void deny()}>Deny connection</button>
				</div>
			)}
			<section className="panel">
				<h2>Continue from your checkout</h2>
				<p>
					In your local repository, initialize with <code>fabrika builder init --url={origin}</code>. For an existing builder project, run{' '}
					<code>fabrika builder connect --url={origin}</code>.
				</p>
				<p className="hint">
					Return to the local dashboard opened by the CLI. Keep using the same checkout and application ID for subsequent work. The console does not open
					an assumed localhost port.
				</p>
			</section>
			<OwnBuilderConnections />
		</>
	)
}

export function BuilderConsentReview({ app, environment, keyLifetimeSeconds }: Selection & { keyLifetimeSeconds: number }) {
	return (
		<section className="panel" aria-labelledby="builder-consent">
			<h2 id="builder-consent">Review builder access</h2>
			<dl className="detail-grid">
				<div>
					<dt>Application</dt>
					<dd>{app.id}</dd>
				</div>
				<div>
					<dt>Repository</dt>
					<dd>{app.repoUrl}</dd>
				</div>
				<div>
					<dt>Environment</dt>
					<dd>{environment.env}</dd>
				</div>
				<div>
					<dt>Namespace</dt>
					<dd>{environment.namespaceId ?? 'None (null)'}</dd>
				</div>
				<div>
					<dt>Domain</dt>
					<dd>{environment.domain ?? 'None (null)'}</dd>
				</div>
				<div>
					<dt>Public origin</dt>
					<dd>{environment.publicOrigin ?? 'None (null)'}</dd>
				</div>
				<div>
					<dt>Trigger ref</dt>
					<dd>{environment.triggerRef ?? 'Manual-only (null)'}</dd>
				</div>
			</dl>
			<p>
				The builder receives <code>app.manage</code>, <code>deploy.trigger</code> and <code>deploy.read</code> for <strong>{app.id}</strong>.
			</p>
			<p>
				<strong>app.manage includes deleting the application and managing all its environments.</strong>{' '}
				Access is app-wide, not limited to the initial environment above.
			</p>
			<p>
				The key expires {keyLifetimeSeconds / 86400}{' '}
				days after approval (at most 30 days). You can revoke it below. Only your local daemon receives the key; it is never shown in the browser.
			</p>
		</section>
	)
}
