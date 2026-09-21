import { useEffect, useState } from 'react'
import { api, type DeviceAuthorizationReceipt } from '../../lib/api'
import { builderRequestError, pairingFailure, revokeBuilderConnection } from '../../lib/builder-authorization'
import { Status } from '../Status'

export function OwnBuilderConnections() {
	const [items, setItems] = useState<DeviceAuthorizationReceipt[]>([])
	const [cursor, setCursor] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [loaded, setLoaded] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function load(before?: string) {
		setBusy(true)
		setError(null)
		try {
			const result = await api.builderPairing.listOwn({ limit: 50, ...(before ? { before } : {}) })
			if (!result.ok) {
				setError(pairingFailure(result.reason))
				return
			}
			setItems((previous) => before ? [...previous, ...result.items] : result.items)
			setCursor(result.nextCursor)
			setLoaded(true)
		} catch (cause) {
			setError(builderRequestError(cause, 'Could not load your connections. Retry when the console is available.'))
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => {
		void load()
	}, [])

	async function revoke(credentialId: string) {
		setBusy(true)
		setError(null)
		const failure = await revokeBuilderConnection(api, credentialId)
		if (failure) {
			setError(failure)
			setBusy(false)
			return
		}
		await load()
	}

	return (
		<section aria-labelledby="own-builder-connections">
			<div className="section-head">
				<h2 id="own-builder-connections">Your builder connections</h2>
				<button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
			</div>
			<p className="hint">
				You can revoke keys you issued here even after losing access to the application. Local disconnect alone does not revoke a key.
			</p>
			{error && <p className="error-text" role="alert">{error}</p>}
			{busy && <p role="status">Loading or updating connections…</p>}
			{loaded && items.length === 0 && <p className="empty">No issued builder connections.</p>}
			{items.length > 0 && (
				<table>
					<thead>
						<tr>
							<th className="grow">Application / credential</th>
							<th>Expires</th>
							<th>Status</th>
						</tr>
					</thead>
					<tbody>
						{items.map((item) => (
							<tr key={item.credentialId}>
								<td>
									<strong>{item.consent.scope.value}</strong>
									<div className="muted small">
										Credential ID: <code>{item.credentialId}</code>
									</div>
								</td>
								<td>{new Date(item.consent.keyExpiresAt * 1000).toLocaleString()}</td>
								<td>
									<Status lamp={item.revokedAt !== null ? 'stop' : item.consent.keyExpiresAt * 1000 <= Date.now() ? 'idle' : 'ok'}>
										{item.revokedAt !== null ? 'Revoked' : item.consent.keyExpiresAt * 1000 <= Date.now() ? 'Expired' : 'Active'}
									</Status>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Load more</button>}
			{items.some((item) => item.revokedAt === null) && (
				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Revoke a builder key</strong>Existing access tokens can remain valid until their short expiry.
					</div>
					{items.filter((item) => item.revokedAt === null).map((item) => (
						<button
							type="button"
							className="danger"
							key={item.credentialId}
							disabled={busy}
							onClick={() => void revoke(item.credentialId)}
							aria-label={`Revoke builder credential ${item.credentialId}`}
						>
							Revoke {item.consent.scope.value} ({item.credentialId})
						</button>
					))}
				</div>
			)}
		</section>
	)
}
