import { createPage, Link, useNavigate } from '@buzola/router'
import type { CreateGrantRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { GrantComposer, useGrantComposerState } from '../../../access/components/GrantComposer'
import { grantTargets, useAdministration } from '../../../access/lib/administration'
import { api } from '../../../access/lib/api'
import { parseDateTimeLocal } from '../../../access/lib/format'
import { Icon } from '../../../components/Icon'
import { ApiError } from '../../../lib/api'

/**
 * Add one grant to a principal. Its own page: composing a grant is a decision with four parts, and
 * hanging it under the two tables on the detail page buried it below the fold.
 */
export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [principal, apps] = await Promise.all([
			api.principals.get({ principalId: params.id }),
			api.apps.list(),
		])
		return { principal, apps: apps.items }
	})
	.route('/access/users/:id/grants/new')
	.render(({ data }) => {
		const { principal, apps } = data
		const navigate = useNavigate()
		const composer = useGrantComposerState()
		const targets = grantTargets(apps, useAdministration())
		const [expiry, setExpiry] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		function back() {
			navigate('access/users/detail', { params: { id: principal.id } })
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
				const body: CreateGrantRequest = { principalId: principal.id, ...authorization, expiresAt: parseDateTimeLocal(expiry) }
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
					<Link to="access/users/detail" params={{ id: principal.id }} className="back-link">
						<Icon name="chevron-left" size={14} />
						Back to user
					</Link>
					<h1>Add access</h1>
					<p className="hint">
						Choose the application and role for <strong>{principal.label}</strong>.
					</p>
				</div>

				<form className="panel form" onSubmit={submit} onChange={() => setError(null)}>
					<GrantComposer apps={targets.apps} crossApp={targets.crossApp} state={composer} idPrefix="grant" expiry={expiry} onExpiryChange={setExpiry} />
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Adding access…' : 'Add access'}</button>
						<button type="button" onClick={back} disabled={busy}>Cancel</button>
					</div>
				</form>
			</>
		)
	})
