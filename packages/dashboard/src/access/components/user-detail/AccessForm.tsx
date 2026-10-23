import { Link, useNavigate } from '@buzola/router'
import type { AppDto, PrincipalDetail, PrincipalGrantDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Icon } from '../../../components/Icon'
import { ApiError } from '../../../lib/api'
import { grantTargets, useAdministration } from '../../lib/administration'
import { api } from '../../lib/api'
import { parseDateTimeLocal } from '../../lib/format'
import { GrantComposer, useGrantComposerState } from '../GrantComposer'

export function UserAccessForm({ principal, apps, grant }: { principal: PrincipalDetail; apps: AppDto[]; grant?: PrincipalGrantDto }) {
	const navigate = useNavigate()
	const composer = useGrantComposerState(grant)
	const targets = grantTargets(apps, useAdministration())
	const [expiry, setExpiry] = useState(() => {
		if (grant?.expiresAt == null) return ''
		const date = new Date(grant.expiresAt * 1000)
		return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
	})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	function back() {
		navigate('access/users/detail', { params: { id: principal.id, tab: 'access' } })
	}
	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setError(null)
		try {
			const authorization = composer.build()
			const expiresAt = parseDateTimeLocal(expiry)
			if (expiry !== '' && (expiresAt === null || expiresAt <= Date.now() / 1000)) {
				throw new Error('Choose an expiration in the future, or leave it empty.')
			}
			setBusy(true)
			if (grant) {
				const { app, ...changes } = authorization
				await api.grants.update({ id: grant.id, ...changes, expiresAt })
			} else await api.grants.create({ principalId: principal.id, ...authorization, expiresAt })
			back()
		} catch (cause) {
			setError(cause instanceof ApiError || cause instanceof Error ? cause.message : 'Could not save access.')
			setBusy(false)
		}
	}
	return (
		<>
			<div className="page-head">
				<Link to="access/users/detail" params={{ id: principal.id, tab: 'access' }} className="back-link">
					<Icon name="chevron-left" size={14} />Back to user
				</Link>
				<h1>{grant ? 'Edit access' : 'Add access'}</h1>
				<p className="hint">
					Choose the role and scope for <strong>{principal.label}</strong>. Changes are audited and reach existing sign-ins within five minutes.
				</p>
			</div>
			{grant && !grant.canManage
				? <p className="user-state-note">This access is outside your administration.</p>
				: (
					<form className="panel form" onSubmit={submit} onChange={() => setError(null)}>
						<GrantComposer
							apps={targets.apps}
							crossApp={targets.crossApp}
							state={composer}
							idPrefix="user-access"
							expiry={expiry}
							onExpiryChange={setExpiry}
							fixedApp={grant !== undefined}
							externalOnly={principal.affiliation === 'external'}
						/>
						{principal.status === 'disabled' && (
							<p className="hint">This account is disabled. Saved access becomes usable only after the account is enabled.</p>
						)}
						{error && <p className="error-text" role="alert">{error}</p>}
						<div className="form-actions">
							<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : grant ? 'Save access' : 'Add access'}</button>
							<button type="button" disabled={busy} onClick={back}>Cancel</button>
						</div>
					</form>
				)}
		</>
	)
}
