import { createPage, Link, useNavigate } from '@buzola/router'
import type { AppDto, CreateGrantRequest, ListResponse, PrincipalDetail } from '@fabrika/iam-contract'
import { useState } from 'react'
import { GrantComposer, useGrantComposerState } from '../../components/GrantComposer'
import { Icon } from '../../components/Icon'
import { api, ApiError } from '../../lib/api'
import { parseDateTimeLocal } from '../../lib/format'

/**
 * Add one grant to a principal. Its own page: composing a grant is a decision with four parts, and
 * hanging it under the two tables on the detail page buried it below the fold.
 */
export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [principal, apps] = await Promise.all([
			api.get<PrincipalDetail>(`/principals/${params.id}`),
			api.get<ListResponse<AppDto>>('/apps'),
		])
		return { principal, apps: apps.items }
	})
	.route('/access/users/:id/grants/new')
	.render(({ data }) => {
		const { principal, apps } = data
		const navigate = useNavigate()
		const composer = useGrantComposerState()
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
				await api.post('/grants', body)
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
					<h1>Add grant</h1>
					<p className="hint">
						Granting to <strong>{principal.label}</strong>. Takes effect immediately and is audited.
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<GrantComposer apps={apps} state={composer} idPrefix="grant" />
					<label>
						Expires (optional)
						<input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
						<span className="hint">Leave empty for a grant that does not expire.</span>
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
