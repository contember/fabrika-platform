import { createPage, Link, useNavigate } from '@buzola/router'
import type { AppDto, ListResponse, ProvisionApiKeyRequest, ProvisionApiKeyResponse } from '@fabrika/iam/admin'
import { useState } from 'react'
import { GrantComposer, useGrantComposerState } from '../../components/GrantComposer'
import { Icon } from '../../components/Icon'
import { SecretModal } from '../../components/SecretModal'
import { api, ApiError } from '../../lib/api'
import { parseDateTimeLocal } from '../../lib/format'

/**
 * Provision an API key. Its own page rather than a panel above the list: the grant composer is a
 * multi-step decision (app → role or inline actions → scope → expiry) and it deserves the screen.
 *
 * The plaintext key exists exactly once, in the response. So the success modal is shown HERE and the
 * navigation back to the list only happens when the operator dismisses it — leaving early is their
 * explicit choice, not a side effect of routing.
 */
export default createPage()
	.loader(async () => {
		const apps = await api.get<ListResponse<AppDto>>('/apps')
		return { apps: apps.items }
	})
	.route('/access/api-keys/new')
	.render(({ data }) => {
		const navigate = useNavigate()
		const [label, setLabel] = useState('')
		const composer = useGrantComposerState()
		const [expiry, setExpiry] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)
		const [secret, setSecret] = useState<ProvisionApiKeyResponse | null>(null)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			let authorization: ReturnType<typeof composer.build>
			try {
				authorization = composer.build()
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : 'Complete the grant first.')
				return
			}
			setBusy(true)
			try {
				const body: ProvisionApiKeyRequest = {
					label: label.trim(),
					type: 'service',
					...authorization,
					expiresAt: parseDateTimeLocal(expiry),
				}
				setSecret(await api.post<ProvisionApiKeyResponse>('/api-keys', body))
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Provisioning failed.')
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/api-keys" className="back-link">
						<Icon name="chevron-left" size={14} />
						All API keys
					</Link>
					<h1>Provision API key</h1>
					<p className="hint">
						Creates a service principal with a propustka-native <code>px_…</code> key. The key is shown once, here, and never stored.
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<label>
						Label
						<input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="ci-deploy-bot" autoFocus />
						<span className="hint">How this key shows up in the list and in the audit trail.</span>
					</label>
					<GrantComposer apps={data.apps} state={composer} idPrefix="apikey" />
					<label>
						Expires (optional)
						<input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
						<span className="hint">The key expires together with this date. Leave empty for a non-expiring key.</span>
					</label>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Provisioning…' : 'Provision key'}</button>
						<button type="button" onClick={() => navigate('access/api-keys')} disabled={busy}>Cancel</button>
					</div>
				</form>

				{secret && (
					<SecretModal
						title="API key provisioned"
						fields={[{ label: 'API key (propustka-native)', value: secret.apiKey, multiline: true }]}
						onClose={() => navigate('access/api-keys')}
					/>
				)}
			</>
		)
	})
