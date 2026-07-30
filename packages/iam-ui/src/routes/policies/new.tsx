import { createPage, Link, useNavigate } from '@buzola/router'
import type { AppSchemaDto, CreatePolicyRequest } from '@fabrika/iam/admin'
import { useState } from 'react'
import { ActionPicker } from '../../components/ActionPicker'
import { Icon } from '../../components/Icon'
import { api, ApiError } from '../../lib/api'

/**
 * Create a custom policy for one app. Policies are per-app, so the app arrives in `?app=` — reached
 * from the policies list, which already has the app selected. Its own page because the action picker
 * is a long scrolling catalog, not a field.
 */
export default createPage()
	.params({ app: 'string' })
	.loader(async ({ params }) => {
		const schema = await api.get<AppSchemaDto>(`/apps/${encodeURIComponent(params.app)}/schema`)
		return { app: params.app, actions: schema.actions }
	})
	.route('/access/policies/new')
	.render(({ data }) => {
		const navigate = useNavigate()
		const [key, setKey] = useState('')
		const [name, setName] = useState('')
		const [description, setDescription] = useState('')
		const [permissions, setPermissions] = useState<string[]>([])
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		function back() {
			navigate('access/policies', { params: { app: data.app } })
		}

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			if (permissions.length === 0) {
				setError('Pick at least one action.')
				return
			}
			setBusy(true)
			try {
				const body: CreatePolicyRequest = {
					key: key.trim(),
					name: name.trim(),
					...(description.trim() === '' ? {} : { description: description.trim() }),
					permissions,
				}
				await api.post(`/apps/${encodeURIComponent(data.app)}/policies`, body)
				back()
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Create failed.')
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/policies" params={{ app: data.app }} className="back-link">
						<Icon name="chevron-left" size={14} />
						All policies
					</Link>
					<h1>Create policy</h1>
					<p className="hint">
						A named permission set for <code>{data.app}</code>, built from its action catalog. Grantable like any role.
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<label>
						Key
						<input value={key} onChange={(e) => setKey(e.target.value)} required placeholder="report-publisher" autoFocus />
						<span className="hint">The stable identifier grants refer to. Lowercase, no spaces.</span>
					</label>
					<label>
						Name
						<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Report publisher" />
					</label>
					<label>
						Description (optional)
						<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Can read and publish reports" />
					</label>
					<ActionPicker actions={data.actions} value={permissions} onChange={setPermissions} idPrefix="new-policy-action" />
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create policy'}</button>
						<button type="button" onClick={back} disabled={busy}>Cancel</button>
					</div>
				</form>
			</>
		)
	})
