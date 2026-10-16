import { createPage, Link, useNavigate } from '@buzola/router'
import type { CreateGrantRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { GrantComposer, useGrantComposerState } from '../../../../access/components/GrantComposer'
import { api } from '../../../../access/lib/api'
import { parseDateTimeLocal } from '../../../../access/lib/format'
import { keyGrantTargets } from '../../../../access/lib/key-grants'
import { Icon } from '../../../../components/Icon'
import { ApiError } from '../../../../lib/api'

/** Add one grant to an API key, with the composer provisioning uses. The key keeps its secret. */
export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [apiKey, apps] = await Promise.all([
			api.apiKeys.get({ principalId: params.id }),
			api.apps.list(),
		])
		return { apiKey, apps: apps.items }
	})
	.route('/access/credentials/keys/:id/grants/new')
	.render(({ data }) => {
		const { apiKey } = data
		const navigate = useNavigate()
		const composer = useGrantComposerState()
		const targets = keyGrantTargets(data.apps, apiKey.credential)
		const [expiry, setExpiry] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		function back() {
			navigate('access/credentials/keys/detail', { params: { id: apiKey.principalId } })
		}

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
				const body: CreateGrantRequest = { principalId: apiKey.principalId, ...authorization, expiresAt: parseDateTimeLocal(expiry) }
				await api.grants.create(body)
				back()
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Grant failed.')
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
					<h1>Add grant</h1>
					<p className="hint">
						Granting to the key <strong>{apiKey.label}</strong>. It applies at the key's next token exchange and is audited.
						{!targets.crossApp && ' The key mints tokens for one app, so the grant names that app.'}
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<GrantComposer apps={targets.apps} crossApp={targets.crossApp} state={composer} idPrefix="key-grant" />
					<label>
						Expires (optional)
						<input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
						<span className="hint">Leave empty for a grant that lasts as long as the key.</span>
					</label>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Granting…' : 'Add grant'}</button>
						<button type="button" onClick={back} disabled={busy}>Cancel</button>
					</div>
				</form>
			</>
		)
	})
