import { createPage, Link, useNavigate } from '@buzola/router'
import type { IssuedShareLinkResponse, IssueShareLinkRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { SecretModal } from '../../components/SecretModal'
import { api, ApiError } from '../../lib/api'
import { parseDateTimeLocal } from '../../lib/format'

interface GrantRow {
	action: string
	/** Scope dimension; both-or-neither with `scopeValue` (both empty = global). */
	scopeType: string
	scopeValue: string
}

const EMPTY_ROW: GrantRow = { action: '', scopeType: '', scopeValue: '' }

/**
 * Issue an anonymous, revocable share link. Its own page: the grant table grows a row at a time, so
 * the form has no fixed height — exactly the shape that reads badly stacked above a list.
 *
 * The token exists once, in the response, so the success modal is shown here and dismissing it is
 * what navigates away.
 */
export default createPage()
	.route('/access/credentials/links/new')
	.render(() => {
		const navigate = useNavigate()
		const [rows, setRows] = useState<GrantRow[]>([{ ...EMPTY_ROW }])
		const [label, setLabel] = useState('')
		const [expiry, setExpiry] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)
		const [token, setToken] = useState<IssuedShareLinkResponse | null>(null)

		function updateRow(index: number, patch: Partial<GrantRow>) {
			setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
		}
		function addRow() {
			setRows((prev) => [...prev, { ...EMPTY_ROW }])
		}
		function removeRow(index: number) {
			setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
		}

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)

			const grants = rows
				.map((row) => ({
					action: row.action.trim(),
					scopeType: row.scopeType.trim(),
					scopeValue: row.scopeValue.trim(),
				}))
				.filter((row) => row.action !== '' || row.scopeType !== '' || row.scopeValue !== '')
			if (grants.length === 0) {
				setError('Add at least one grant.')
				return
			}
			if (grants.some((g) => g.action === '')) {
				setError('Each grant needs an action.')
				return
			}
			if (grants.some((g) => (g.scopeType === '') !== (g.scopeValue === ''))) {
				setError('A scope needs both a dimension and a value, or leave both empty for a global grant.')
				return
			}

			const expiresAt = parseDateTimeLocal(expiry)
			const body: IssueShareLinkRequest = {
				grants: grants.map((g) => ({
					action: g.action,
					scope: g.scopeType === '' ? null : { type: g.scopeType, value: g.scopeValue },
				})),
				...(label.trim() === '' ? {} : { label: label.trim() }),
				...(expiresAt === null ? {} : { expiresAt }),
			}

			setBusy(true)
			try {
				setToken(await api.shareLinks.issue(body))
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Issue failed.')
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/credentials" className="back-link">
						<Icon name="chevron-left" size={14} />
						All credentials
					</Link>
					<h1>Issue share link</h1>
					<p className="hint">
						An anonymous, revocable <code>px_</code> credential granting specific <code>(action, scope)</code>{' '}
						pairs. You can only delegate what you hold yourself.
					</p>
				</div>

				<form className="panel form wide" onSubmit={submit}>
					<div className="grant-rows">
						<div className="grant-rows-head">
							<span>Action</span>
							<span>Scope dimension (optional)</span>
							<span>Scope value</span>
							<span />
						</div>
						{rows.map((row, i) => (
							<div className="grant-row" key={i}>
								<input
									aria-label="Action"
									value={row.action}
									onChange={(e) => updateRow(i, { action: e.target.value })}
									placeholder="report.read"
								/>
								<input
									aria-label="Scope dimension"
									value={row.scopeType}
									onChange={(e) => updateRow(i, { scopeType: e.target.value })}
									placeholder="tenant"
								/>
								<input
									aria-label="Scope value"
									value={row.scopeValue}
									onChange={(e) => updateRow(i, { scopeValue: e.target.value })}
									placeholder="acme"
								/>
								<button type="button" className="small" onClick={() => removeRow(i)} disabled={rows.length === 1}>
									Remove
								</button>
							</div>
						))}
						<button type="button" className="small" onClick={addRow}>+ Add grant</button>
						<p className="hint">
							Each grant is matched by <code>permits()</code> at use time. Leave both scope fields empty for a global grant.
						</p>
					</div>
					<label>
						Label (optional)
						<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Q3 report share" />
					</label>
					<label>
						Expires (optional)
						<input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
					</label>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>{busy ? 'Issuing…' : 'Issue share link'}</button>
						<button type="button" onClick={() => navigate('access/credentials')} disabled={busy}>Cancel</button>
					</div>
				</form>

				{token && (
					<SecretModal
						title="Share link issued"
						fields={[{ label: 'Token', value: token.token, multiline: true }]}
						note={
							<p className="hint">
								Hand this token to the holder over a trusted channel. It is the only secret — anyone with it can perform the granted actions.
							</p>
						}
						onClose={() => navigate('access/credentials')}
					/>
				)}
			</>
		)
	})
