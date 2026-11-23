import { Link, useNavigate } from '@buzola/router'
import type { ApiKeyGrantDto, AppDto, GetApiKeyResponse } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { ApiError } from '../../lib/api'
import { api } from '../lib/api'
import { submittedExpiry, toDateTimeLocal } from '../lib/format'
import { keyGrantTargets } from '../lib/key-grants'
import { GrantComposer, useGrantComposerState } from './GrantComposer'

/**
 * Add a grant to an API key, or edit one in place (`grants.update`: its app stays). The key keeps its secret; the
 * change applies at the key's next token exchange and IAM audits it.
 */
export function KeyGrantForm({ apiKey, apps, grant }: { apiKey: GetApiKeyResponse; apps: AppDto[]; grant?: ApiKeyGrantDto }) {
	const navigate = useNavigate()
	const composer = useGrantComposerState(grant)
	const targets = keyGrantTargets(apps, apiKey.credential)
	const [expiry, setExpiry] = useState(() => grant?.expiresAt == null ? '' : toDateTimeLocal(grant.expiresAt))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function back() {
		navigate('access/credentials/keys/detail', { params: { id: apiKey.principalId } })
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setError(null)
		try {
			const authorization = composer.build()
			const expiresAt = submittedExpiry(expiry, grant?.expiresAt)
			if (expiry !== '' && (expiresAt === null || expiresAt <= Date.now() / 1000)) {
				throw new Error('Choose an expiration in the future, or leave it empty.')
			}
			setBusy(true)
			if (grant) {
				const { app: _app, ...changes } = authorization
				await api.grants.update({ id: grant.id, ...changes, expiresAt })
			} else await api.grants.create({ principalId: apiKey.principalId, ...authorization, expiresAt })
			back()
		} catch (cause) {
			setError(cause instanceof ApiError || cause instanceof Error ? cause.message : 'Could not save the grant.')
			setBusy(false)
		}
	}

	return (
		<>
			<div className="page-head">
				<Link to="access/credentials/keys/detail" params={{ id: apiKey.principalId }} className="back-link">
					<Icon name="chevron-left" size={14} />
					Back to key
				</Link>
				<h1>{grant ? 'Edit grant' : 'Add grant'}</h1>
				<p className="hint">
					{grant ? 'Changing a grant of' : 'Granting to'} the key{' '}
					<strong>{apiKey.label}</strong>. It applies at the key's next token exchange and is audited.
					{!grant && !targets.crossApp && ' The key mints tokens for one app, so the grant names that app.'}
				</p>
			</div>

			<form className="panel form" onSubmit={submit} onChange={() => setError(null)}>
				<GrantComposer
					apps={targets.apps}
					crossApp={targets.crossApp}
					state={composer}
					idPrefix="key-grant"
					expiry={expiry}
					onExpiryChange={setExpiry}
					expiryHint="Without an expiration, access lasts as long as the key."
					fixedApp={grant !== undefined}
				/>
				{error && <p className="error-text" role="alert">{error}</p>}
				<div className="form-actions">
					<button type="submit" className="primary" disabled={busy}>
						{busy ? 'Saving…' : grant ? 'Save grant' : 'Add grant'}
					</button>
					<button type="button" onClick={back} disabled={busy}>Cancel</button>
				</div>
			</form>
		</>
	)
}
