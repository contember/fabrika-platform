import { createPage, Link, useNavigate } from '@buzola/router'
import type { CreateGrantRequest, InviteRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { GrantComposer, useGrantComposerState } from '../../components/GrantComposer'
import { Icon } from '../../components/Icon'
import { api, ApiError } from '../../lib/api'
import { parseDateTimeLocal } from '../../lib/format'

/**
 * Pre-create an invited user, optionally with their first grant. Its own page because the optional
 * grant turns this from one field into a full composer, and a form that changes size under you inside
 * a list is worse than a page you navigated to on purpose.
 */
export default createPage()
	.loader(async () => {
		const apps = await api.apps.list()
		return { apps: apps.items }
	})
	.route('/access/users/new')
	.render(({ data }) => {
		const navigate = useNavigate()
		const [email, setEmail] = useState('')
		const [withGrant, setWithGrant] = useState(false)
		const composer = useGrantComposerState()
		const [expiry, setExpiry] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)

			let authorization: ReturnType<typeof composer.build> | null = null
			if (withGrant) {
				try {
					authorization = composer.build()
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : 'Complete the grant, or uncheck "also grant a role".')
					return
				}
			}

			setBusy(true)
			try {
				const invited = await api.principals.invite({ email } satisfies InviteRequest)
				if (authorization !== null) {
					const body: CreateGrantRequest = {
						principalId: invited.id,
						...authorization,
						expiresAt: parseDateTimeLocal(expiry),
					}
					await api.grants.create(body)
				}
				navigate('access/users/detail', { params: { id: invited.id } })
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Invite failed.')
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/users" className="back-link">
						<Icon name="chevron-left" size={14} />
						All users
					</Link>
					<h1>Invite user</h1>
					<p className="hint">
						Pre-creates the user so you can grant a role before their first login. For team-wide pre-authorization, use group mappings instead.
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<label>
						Email
						<input
							type="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="person@example.com"
							autoFocus
						/>
						<span className="hint">Matched against the identity the IdP returns at first login.</span>
					</label>
					<label className="checkbox">
						<input type="checkbox" checked={withGrant} onChange={(e) => setWithGrant(e.target.checked)} />
						Also grant a role now
					</label>
					{withGrant && (
						<div className="nested">
							<GrantComposer apps={data.apps} state={composer} idPrefix="invite" />
							<label>
								Expires (optional)
								<input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
							</label>
						</div>
					)}
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Inviting…' : 'Invite user'}</button>
						<button type="button" onClick={() => navigate('access/users')} disabled={busy}>Cancel</button>
					</div>
				</form>
			</>
		)
	})
