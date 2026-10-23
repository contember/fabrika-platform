import { createPage, Link } from '@buzola/router'
import type { PasswordActionDelivery, PermissionEntry, PrincipalDetail, SessionDto, UpdatePrincipalRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Badge } from '../../../access/components/Badge'
import { GrantRow, GrantTableHead } from '../../../access/components/GrantRow'
import { SecretModal } from '../../../access/components/SecretModal'
import { useAdministration } from '../../../access/lib/administration'
import { api } from '../../../access/lib/api'
import { AppName } from '../../../access/lib/app-names'
import { fmtExpiry, fmtScope } from '../../../access/lib/format'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { Icon } from '../../../components/Icon'
import { Chip, PrincipalStatus, Status } from '../../../components/Status'
import { EmptyState, Table } from '../../../components/Table'
import { ApiError } from '../../../lib/api'
import { fmtAgo, fmtDate } from '../../../lib/format'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({
		principal: await api.principals.get({ principalId: params.id }),
		sessions: await api.sessions.list({ principalId: params.id }),
	}))
	.route('/access/users/:id')
	.render(({ data, invalidate }) => {
		const { principal } = data
		const administration = useAdministration()
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
						{principal.affiliation === 'external' && <Chip title="A person from outside the organization">external</Chip>}
					</div>
					<div className="subtitle">
						<span>{identity[0] ?? principal.id}</span>
						{identity.slice(1).map((value) => <span key={value} className="dot-sep">{value}</span>)}
						<span className="dot-sep">joined {fmtDate(principal.createdAt)}</span>
					</div>
				</div>

				<Authentication principal={principal} onDone={invalidate} />

				<Sessions principalId={principal.id} sessions={data.sessions.items} onDone={invalidate} />

				<section>
					<div className="section-head">
						<Icon name="shield" size={15} />
						<h2>Effective permissions</h2>
					</div>
					<p className="section-note">Why this user has each permission, resolved from grants, group mappings and bootstrap.</p>
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
						<h2>Assigned access</h2>
						<span className="spacer" />
						<Link to="access/users/grant" params={{ id: principal.id }} className="btn small primary">Add access</Link>
					</div>
					<Table
						colSpan={7}
						isEmpty={principal.grants.length === 0}
						empty={
							<EmptyState
								title="No assigned access"
								body="They only have whatever their group mappings or bootstrap give them."
								action={<Link to="access/users/grant" params={{ id: principal.id }} className="btn small">Add access</Link>}
							/>
						}
						head={<GrantTableHead />}
					>
						{principal.grants.map((grant) => <GrantRow key={grant.id} grant={grant} onDone={invalidate} />)}
					</Table>
				</section>

				{principal.affiliation === 'external' && administration.kind === 'installation' && (
					<PromoteToInternal principal={principal} onDone={invalidate} />
				)}

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
				? await api.passwords.issueEnrollment({ principalId: principal.id })
				: await api.passwords.issueReset({ principalId: principal.id })
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
			await api.passwords.disable({ principalId: principal.id })
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

/**
 * Open sessions, and the two ways to end one.
 *
 * Disabling the user was the only lever an operator had here, and it locks the person out. Revoking
 * an IAM session also ends every app session derived from it; the app rows keep their own
 * `active` status because the cascade happens at lookup, so the table says which parent each one
 * hangs off rather than pretending the child was rewritten.
 */
function Sessions({ principalId, sessions, onDone }: { principalId: string; sessions: SessionDto[]; onDone: () => void }) {
	const [confirmAll, setConfirmAll] = useState(false)
	const live = sessions.filter((session) => session.status === 'active')

	async function revokeAll() {
		await api.sessions.revokeAll({ principalId })
		setConfirmAll(false)
		onDone()
	}

	return (
		<section>
			<div className="section-head">
				<Icon name="clock" size={15} />
				<h2>Sessions</h2>
				<span className="spacer" />
				{live.length > 0 && <button type="button" className="btn small danger" onClick={() => setConfirmAll(true)}>Revoke all</button>}
			</div>
			<p className="section-note">
				Browser sign-ins. Revoking an IAM session also ends every app session derived from it; the user can sign in again.
			</p>
			<Table
				colSpan={6}
				isEmpty={sessions.length === 0}
				empty={<EmptyState title="No sessions" body="This user has not signed in, or every session has been pruned." />}
				head={
					<tr>
						<th className="grow">Signed in</th>
						<th>Method</th>
						<th>App</th>
						<th>Expires</th>
						<th>State</th>
						<th />
					</tr>
				}
			>
				{sessions.map((session) => <SessionRow key={session.id} session={session} onDone={onDone} />)}
			</Table>
			{confirmAll && (
				<ConfirmDialog
					title="Revoke every session"
					confirmLabel="Revoke all"
					body={<p>End all {live.length} open sessions? The user keeps their account and can sign in again.</p>}
					onConfirm={revokeAll}
					onClose={() => setConfirmAll(false)}
				/>
			)}
		</section>
	)
}

function SessionRow({ session, onDone }: { session: SessionDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function revoke() {
		await api.sessions.revoke({ id: session.id })
		onDone()
	}

	return (
		<tr>
			<td className="muted small nowrap" title={fmtDate(session.createdAt)}>{fmtAgo(session.createdAt)}</td>
			<td>{session.authenticationMethod}</td>
			<td>
				{session.app === null
					? <span className="muted">IAM</span>
					: (
						<Chip title={session.parentSessionId === null ? undefined : `Derived from session ${session.parentSessionId}`}>
							<AppName app={session.app} />
						</Chip>
					)}
			</td>
			<td className="nowrap">{fmtExpiry(session.expiresAt)}</td>
			<td>
				<Status lamp={session.status === 'active' ? 'ok' : 'idle'}>{session.status}</Status>
			</td>
			<td className="row-actions">
				{session.status === 'active' && <button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>}
				{confirming && (
					<ConfirmDialog
						title="Revoke session"
						confirmLabel="Revoke"
						body={
							<p>
								End this session? {session.app === null
									? 'Every app session derived from it ends with it.'
									: 'Only this app session ends; the IAM sign-in it came from stays open.'}
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

function PromoteToInternal({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function promote() {
		await api.principals.promote({ principalId: principal.id })
		onDone()
	}

	return (
		<div className="danger-zone">
			<div className="danger-zone-copy">
				<strong>Make this user internal</strong>
				An external user holds only roles an application declares external, and signs in by password only.
			</div>
			<span className="spacer" />
			<button type="button" className="danger" onClick={() => setConfirming(true)}>Make internal</button>
			{confirming && (
				<ConfirmDialog
					title="Make user internal"
					confirmLabel="Make internal"
					body={
						<>
							<p>
								Make <strong>{principal.label}</strong>{' '}
								internal? They may then hold any role, and an OIDC login with their address may claim the account. Every session they hold ends and pending
								password links stop working. This cannot be undone.
							</p>
							{principal.bootstrapMailbox && (
								<p className="error-text" role="alert">
									This address is listed in IAM_BOOTSTRAP_ADMINS: once internal, this user is an installation admin.
								</p>
							)}
						</>
					}
					onConfirm={promote}
					onClose={() => setConfirming(false)}
				/>
			)}
		</div>
	)
}

function DisableToggle({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const disabled = principal.status === 'disabled'

	async function toggle() {
		const body: UpdatePrincipalRequest = { disabled: !disabled }
		await api.principals.update({ principalId: principal.id, ...body })
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
