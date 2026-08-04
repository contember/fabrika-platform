import { createPage, Link } from '@buzola/router'
import type { GrantDto, PasswordActionDelivery, PermissionEntry, PrincipalDetail, UpdatePrincipalRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Badge } from '../../components/Badge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { SecretModal } from '../../components/SecretModal'
import { Chip, PrincipalStatus, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError } from '../../lib/api'
import { fmtAgo, fmtDate, fmtExpiry, fmtScope } from '../../lib/format'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ principal: await api.principals.get({ id: params.id }) }))
	.route('/access/users/:id')
	.render(({ data, invalidate }) => {
		const { principal } = data
		// An invited user's label IS their email, so printing both under the title says one thing twice.
		const identity = [principal.email, principal.externalId].filter((value): value is string => value !== null && value !== principal.label)

		return (
			<>
				<div className="page-head">
					<Link to="access/users" className="back-link">
						<Icon name="chevron-left" size={14} />
						All users
					</Link>
					<div className="page-head-row">
						<h1>{principal.label}</h1>
						<PrincipalStatus status={principal.status} />
						{/* Every row on this page is a user; a `service` here was reached by id, so say so. */}
						{principal.type !== 'user' && <Chip>{principal.type}</Chip>}
					</div>
					<div className="subtitle">
						<span>{identity[0] ?? principal.id}</span>
						{identity.slice(1).map((value) => <span key={value} className="dot-sep">{value}</span>)}
						<span className="dot-sep">joined {fmtDate(principal.createdAt)}</span>
					</div>
				</div>

				<Authentication principal={principal} onDone={invalidate} />

				<section>
					<div className="section-head">
						<Icon name="shield" size={15} />
						<h2>Effective permissions</h2>
					</div>
					<p className="section-note">Why this user has each permission — resolved from grants, group mappings and bootstrap.</p>
					<Table
						colSpan={3}
						isEmpty={principal.permissions.length === 0}
						empty={<EmptyState title="No effective permissions" />}
						head={
							<tr>
								<th className="grow">Action</th>
								<th>Scope</th>
								<th>Source</th>
							</tr>
						}
					>
						{principal.permissions.map((perm, i) => (
							<tr key={`${perm.action}:${fmtScope(perm.scope)}:${perm.source}:${i}`}>
								<td>
									<code>{perm.action}</code>
								</td>
								<td>{fmtScope(perm.scope)}</td>
								<td>
									<SourceBadge source={perm.source} />
								</td>
							</tr>
						))}
					</Table>
				</section>

				<section>
					<div className="section-head">
						<Icon name="key" size={15} />
						<h2>Grants</h2>
						<span className="spacer" />
						<Link to="access/users/grant" params={{ id: principal.id }} className="btn small primary">Add grant</Link>
					</div>
					<Table
						colSpan={7}
						isEmpty={principal.grants.length === 0}
						empty={
							<EmptyState
								title="No explicit grants"
								body="They only have whatever their group mappings or bootstrap give them."
								action={<Link to="access/users/grant" params={{ id: principal.id }} className="btn small">Add the first grant</Link>}
							/>
						}
						head={
							<tr>
								<th className="grow">Role / actions</th>
								<th>App</th>
								<th>Scope</th>
								<th>Expires</th>
								<th>Granted by</th>
								<th>Created</th>
								<th />
							</tr>
						}
					>
						{principal.grants.map((grant) => <GrantRow key={grant.id} grant={grant} onDone={invalidate} />)}
					</Table>
				</section>

				<DisableToggle principal={principal} onDone={invalidate} />
			</>
		)
	})

function Authentication({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [busy, setBusy] = useState<'enrollment' | 'reset' | 'disable' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [manual, setManual] = useState<{ purpose: 'Enrollment' | 'Reset'; result: PasswordActionDelivery } | null>(null)
	const [confirmDisable, setConfirmDisable] = useState(false)
	const oidc = principal.authentication.oidc.state
	const password = principal.authentication.password.state

	async function issue(purpose: 'enrollment' | 'reset') {
		setBusy(purpose)
		setError(null)
		setNotice(null)
		try {
			const result = purpose === 'enrollment'
				? await api.passwords.issueEnrollment({ id: principal.id })
				: await api.passwords.issueReset({ id: principal.id })
			if (result.delivery === 'manual') {
				setManual({ purpose: purpose === 'enrollment' ? 'Enrollment' : 'Reset', result })
			} else {
				setNotice(`${purpose === 'enrollment' ? 'Enrollment' : 'Reset'} email sent to ${result.email}.`)
			}
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : `Could not issue the ${purpose} link.`)
		} finally {
			setBusy(null)
		}
	}

	async function disable() {
		setBusy('disable')
		setError(null)
		setNotice(null)
		try {
			await api.passwords.disable({ id: principal.id })
			setNotice('Password authentication disabled. Existing OIDC sessions remain active.')
			setConfirmDisable(false)
			onDone()
		} finally {
			setBusy(null)
		}
	}

	return (
		<section>
			<div className="section-head">
				<Icon name="lock" size={15} />
				<h2>Authentication</h2>
			</div>
			<p className="section-note">Methods available to this user. Password access is opt-in per user.</p>
			<div className="authentication-grid">
				<div className="authentication-method">
					<div>
						<strong>OpenID Connect</strong>
						<p>{oidcDescription(oidc)}</p>
					</div>
					<Status lamp={oidc === 'linked' ? 'ok' : 'idle'}>{oidc}</Status>
				</div>
				<div className="authentication-method">
					<div>
						<strong>Password</strong>
						<p>{passwordDescription(password)}</p>
					</div>
					<div className="authentication-actions">
						<Status lamp={password === 'enabled' ? 'ok' : password === 'pending' ? 'run' : 'idle'}>{password}</Status>
						{password === 'disabled' && (
							<button
								type="button"
								className="small primary"
								disabled={busy !== null || principal.status === 'disabled'}
								onClick={() => issue('enrollment')}
							>
								{busy === 'enrollment' ? 'Issuing…' : 'Enable password'}
							</button>
						)}
						{password === 'pending' && (
							<>
								<button
									type="button"
									className="small primary"
									disabled={busy !== null || principal.status === 'disabled'}
									onClick={() => issue('enrollment')}
								>
									{busy === 'enrollment' ? 'Issuing…' : 'Resend enrollment'}
								</button>
								<button type="button" className="small danger" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
									Disable
								</button>
							</>
						)}
						{password === 'enabled' && (
							<>
								<button
									type="button"
									className="small"
									disabled={busy !== null || principal.status === 'disabled'}
									onClick={() => issue('reset')}
								>
									{busy === 'reset' ? 'Issuing…' : 'Send reset'}
								</button>
								<button type="button" className="small danger" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
									Disable
								</button>
							</>
						)}
					</div>
				</div>
			</div>
			{notice && (
				<p className="notice" role="status">
					<Icon name="check" size={15} />
					{notice}
				</p>
			)}
			{error && <p className="error-text" role="alert">{error}</p>}
			{manual?.result.delivery === 'manual' && (
				<SecretModal
					title={`${manual.purpose} link issued`}
					fields={[{ label: `${manual.purpose} URL`, value: manual.result.url, multiline: true }]}
					note={<p className="hint">Send this URL over a trusted channel. It expires {fmtExpiry(manual.result.expiresAt)}.</p>}
					onClose={() => setManual(null)}
				/>
			)}
			{confirmDisable && (
				<ConfirmDialog
					title="Disable password authentication"
					confirmLabel={busy === 'disable' ? 'Disabling…' : 'Disable password'}
					body={<p>Remove this user's password credential and revoke their password sessions? OIDC sessions remain active.</p>}
					onConfirm={disable}
					onClose={() => setConfirmDisable(false)}
				/>
			)}
		</section>
	)
}

function oidcDescription(state: PrincipalDetail['authentication']['oidc']['state']): string {
	if (state === 'unavailable') return 'OIDC login is disabled for this IAM installation.'
	if (state === 'linked') return 'The user has signed in through the configured identity provider.'
	return 'Available globally, but this user has not linked an identity-provider subject.'
}

function passwordDescription(state: PrincipalDetail['authentication']['password']['state']): string {
	if (state === 'unavailable') return 'Password login is disabled for this IAM installation.'
	if (state === 'enabled') return 'The user can sign in with their email and password.'
	if (state === 'pending') return 'Enrollment was enabled, but the user has not set a password yet.'
	return 'The user cannot sign in with a password.'
}

function SourceBadge({ source }: { source: PermissionEntry['source'] }) {
	if (source === 'bootstrap') return <Badge tone="warn" title="From IAM_BOOTSTRAP_ADMINS">bootstrap</Badge>
	if (source === 'grant') return <Badge tone="neutral">grant</Badge>
	return <Badge tone="muted" title="From an IdP group mapping">{source}</Badge>
}

function DisableToggle({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const disabled = principal.status === 'disabled'

	async function toggle() {
		const body: UpdatePrincipalRequest = { disabled: !disabled }
		await api.principals.update({ id: principal.id, ...body })
		onDone()
	}

	return (
		<div className="danger-zone">
			<div className="danger-zone-copy">
				<strong>{disabled ? 'Enable this user' : 'Disable this user'}</strong>
				{disabled
					? 'Their grants take effect again immediately.'
					: 'They keep every grant but resolve to zero permissions until re-enabled.'}
			</div>
			<span className="spacer" />
			<button
				type="button"
				className={disabled ? 'primary' : 'danger'}
				onClick={() => setConfirming(true)}
			>
				{disabled ? 'Enable' : 'Disable'}
			</button>
			{confirming && (
				<ConfirmDialog
					title={disabled ? 'Enable user' : 'Disable user'}
					confirmLabel={disabled ? 'Enable' : 'Disable'}
					body={
						<p>
							{disabled ? 'Re-enable ' : 'Disable '}
							<strong>{principal.label}</strong>
							{disabled
								? '? Their permissions take effect again.'
								: '? They keep their grants but resolve to zero permissions until re-enabled.'}
						</p>
					}
					onConfirm={toggle}
					onClose={() => setConfirming(false)}
				/>
			)}
		</div>
	)
}

/** Render a grant's authorization: a named role, or its inline action set. */
function GrantAuthorizationCell({ grant }: { grant: GrantDto }) {
	if (grant.roleKey !== null) {
		return (
			<>
				<code>{grant.roleKey}</code>
				{grant.dangling && (
					<Badge tone="bad" title="This role_key no longer resolves to a known role — it grants zero permissions.">
						dangling
					</Badge>
				)}
			</>
		)
	}
	return (
		<span className="inline-actions">
			{(grant.permissions ?? []).map((p) => <code key={p} className="perm-chip">{p}</code>)}
		</span>
	)
}

function GrantRow({ grant, onDone }: { grant: GrantDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const scopeLabel = fmtScope(grant.scopeType === null ? null : { type: grant.scopeType, value: grant.scopeValue ?? '' })

	async function revoke() {
		await api.grants.delete({ id: grant.id })
		onDone()
	}

	return (
		<tr>
			<td>
				<GrantAuthorizationCell grant={grant} />
			</td>
			<td>{grant.app ? <code>{grant.app}</code> : <span className="muted">All apps</span>}</td>
			<td>{scopeLabel}</td>
			<td>{fmtExpiry(grant.expiresAt)}</td>
			<td>{grant.grantedBy ?? <span className="muted">—</span>}</td>
			<td className="muted small nowrap" title={fmtDate(grant.createdAt)}>{fmtAgo(grant.createdAt)}</td>
			<td className="row-actions">
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>
				{confirming && (
					<ConfirmDialog
						title="Revoke grant"
						confirmLabel="Revoke"
						body={
							<p>
								Revoke this grant scoped to <strong>{scopeLabel}</strong>? This is immediate and audited.
							</p>
						}
						onConfirm={revoke}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}
