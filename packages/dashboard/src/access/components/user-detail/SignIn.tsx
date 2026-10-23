import { Link } from '@buzola/router'
import type { CursorList, PasswordActionDelivery, PrincipalDetail, SessionDto, SessionList, UserConnectionDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { Status } from '../../../components/Status'
import { EmptyState } from '../../../components/Table'
import { ApiError } from '../../../lib/api'
import { fmtAgo, fmtDate } from '../../../lib/format'
import { api } from '../../lib/api'
import { AppName } from '../../lib/app-names'
import { SecretModal } from '../SecretModal'

const propagation = 'Previously issued tokens can remain valid for up to five minutes.'
const methodLabels = { oidc: 'Organization sign-in', password: 'Email and password', local_dev: 'Local development' }
const sessionReasons = {
	revoked: 'Signed out',
	expired: 'Expired',
	parent_ended: 'Parent sign-in ended',
	account_disabled: 'Account disabled',
	method_disabled: 'Sign-in method disabled',
}

export function UserSignIn({ principal, sessions, connections, before, connectionsBefore, onDone }: {
	principal: PrincipalDetail
	sessions: SessionList
	connections: CursorList<UserConnectionDto> | null
	before: string | undefined
	connectionsBefore: string | undefined
	onDone: () => void
}) {
	const [confirmAll, setConfirmAll] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	return (
		<>
			{!principal.management.account && (
				<p className="user-state-note">
					An installation administrator manages sign-ins for this person because their access extends outside your administration.
				</p>
			)}
			<Authentication principal={principal} onDone={onDone} />
			<section>
				<div className="section-head">
					<h2>Browser sign-ins</h2>
					<span className="spacer" />
					<button type="button" className="small danger" disabled={!principal.management.account} onClick={() => setConfirmAll(true)}>
						Sign out everywhere
					</button>
				</div>
				<p className="section-note">Each sign-in includes its connected application sessions. Ending it also ends those sessions. {propagation}</p>
				{notice && <p className="notice" role="status">{notice}</p>}
				{sessions.items.length === 0 && (
					<EmptyState title="No sign-ins on record" body="Old sign-ins are cleaned up automatically. The Activity tab holds the retained history." />
				)}
				<div className="user-access-list">
					{sessions.items.map((session) => (
						<div className="user-access-item" key={session.id}>
							<SessionLine session={session} canManage={principal.management.account} onDone={onDone} />
							{sessions.applications.some((child) => child.parentSessionId === session.id) && (
								<details className="user-session-apps">
									<summary>Connected applications ({sessions.applications.filter((child) => child.parentSessionId === session.id).length})</summary>
									{sessions.applications.filter((child) => child.parentSessionId === session.id).map((child) => (
										<SessionLine key={child.id} session={child} canManage={principal.management.account} onDone={onDone} />
									))}
								</details>
							)}
						</div>
					))}
				</div>
				<div className="pager">
					{before && (
						<Link className="btn" to="access/users/detail" params={{ id: principal.id, tab: 'sign-in', connectionsBefore }}>
							Latest sign-ins
						</Link>
					)}
					<span className="pull" />
					{sessions.nextCursor && (
						<Link className="btn" to="access/users/detail" params={{ id: principal.id, tab: 'sign-in', before: sessions.nextCursor, connectionsBefore }}>
							Older sign-ins
						</Link>
					)}
				</div>
			</section>
			{connections && (
				<section>
					<div className="section-head">
						<h2>Connected clients</h2>
					</div>
					<p className="section-note">OAuth clients this person authorized to act on their behalf. Disconnecting stops token renewal. {propagation}</p>
					{connections.items.length === 0 && <EmptyState title="No connected clients on record" />}
					<div className="user-access-list">
						{connections.items.map((connection) => <Connection key={connection.id} connection={connection} onDone={onDone} />)}
					</div>
					<div className="pager">
						{connectionsBefore && (
							<Link className="btn" to="access/users/detail" params={{ id: principal.id, tab: 'sign-in', before }}>Latest connections</Link>
						)}
						<span className="pull" />
						{connections.nextCursor && (
							<Link
								className="btn"
								to="access/users/detail"
								params={{ id: principal.id, tab: 'sign-in', before, connectionsBefore: connections.nextCursor }}
							>
								Older connections
							</Link>
						)}
					</div>
				</section>
			)}
			{confirmAll && (
				<ConfirmDialog
					title="Sign out everywhere"
					confirmLabel="Sign out everywhere"
					body={
						<p>
							End every browser sign-in for{' '}
							<strong>{principal.label}</strong>, including those on other pages? They keep their account and can sign in again. {propagation}
						</p>
					}
					onClose={() => setConfirmAll(false)}
					onConfirm={async () => {
						const result = await api.sessions.revokeAll({ principalId: principal.id })
						setNotice(result.revoked === 0 ? 'There were no remaining sessions to end.' : 'All browser sign-ins have been ended.')
						onDone()
					}}
				/>
			)}
		</>
	)
}

function Authentication({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [manual, setManual] = useState<Extract<PasswordActionDelivery, { delivery: 'manual' }> | null>(null)
	const [confirmDisable, setConfirmDisable] = useState(false)
	const { oidc, password } = principal.authentication
	const latest = password.latestAction
	const external = principal.affiliation === 'external'
	const organizationAvailable = !external && oidc.state !== 'unavailable'
	const passwordAction = password.state === 'enabled' ? 'reset' : 'enrollment'
	async function issue() {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			const result = passwordAction === 'reset'
				? await api.passwords.issueReset({ principalId: principal.id })
				: await api.passwords.issueEnrollment({ principalId: principal.id })
			if (result.delivery === 'manual') setManual(result)
			else {setNotice(
					`The ${passwordAction === 'reset' ? 'reset' : 'setup'} link was emailed to ${result.email}. It expires ${fmtDate(result.expiresAt)}.`,
				)}
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Could not issue the password link.')
		} finally {
			setBusy(false)
		}
	}
	return (
		<section>
			<div className="section-head">
				<h2>Sign-in methods</h2>
			</div>
			<div className="authentication-grid">
				<div className="authentication-method">
					<div>
						<strong>Organization sign-in</strong>
						<p>
							{external
								? 'External people sign in with a password only.'
								: oidc.state === 'unavailable'
								? 'Not enabled on this installation.'
								: oidc.state === 'linked'
								? 'Linked to the organization’s identity provider (OpenID Connect).'
								: 'Available. This person has not linked their organization identity yet.'}
						</p>
					</div>
					<Status lamp={!external && oidc.state === 'linked' ? 'ok' : 'idle'}>
						{external ? 'Not available' : oidc.state === 'linked' ? 'Linked' : oidc.state === 'unlinked' ? 'Not linked yet' : 'Not available'}
					</Status>
				</div>
				<div className="authentication-method">
					<div>
						<strong>Email and password</strong>
						<p>
							{password.state === 'unavailable'
								? 'Not enabled on this installation.'
								: password.state === 'enabled'
								? 'A password is set. A reset link lets the person choose a new one.'
								: password.state === 'pending'
								? 'Waiting for the person to set their password.'
								: 'Send a setup link to let the person choose their password.'}
						</p>
					</div>
					<Status lamp={password.state === 'enabled' ? 'ok' : password.state === 'pending' ? 'run' : 'idle'}>
						{password.state === 'enabled'
							? 'Password set'
							: password.state === 'pending'
							? 'Setup pending'
							: password.state === 'unavailable'
							? 'Not available'
							: 'Not enabled'}
					</Status>
				</div>
			</div>
			{password.state !== 'unavailable' && (
				<div className="user-password-actions">
					<div className="user-item-actions">
						<button type="button" disabled={busy || principal.status === 'disabled' || !principal.management.passwordLinks} onClick={issue}>
							{busy ? 'Issuing link…' : `${password.delivery === 'email' ? 'Send' : 'Create'} ${passwordAction === 'reset' ? 'reset' : 'setup'} link`}
						</button>
						{(password.state === 'enabled' || password.state === 'pending') && (
							<button
								type="button"
								className="danger"
								disabled={busy || !principal.management.account}
								onClick={() => setConfirmDisable(true)}
							>
								Disable password sign-in
							</button>
						)}
					</div>
					<p className="hint">
						{!principal.management.passwordLinks && principal.management.account
							? 'Email delivery is not configured. Ask an installation administrator to issue the link.'
							: password.delivery === 'email'
							? 'Links go to the person’s email. A new link replaces the previous link for the same action.'
							: 'Email delivery is not configured. The link is shown once for you to send to the person.'}
					</p>
					{latest && (
						<p className="hint">
							Last {latest.purpose === 'reset' ? 'reset' : 'setup'} link issued {fmtDate(latest.createdAt)}. {latest.closedAt !== null
								? 'This link has been used or closed.'
								: latest.expiresAt <= Date.now() / 1000
								? 'This link has expired.'
								: `Valid until ${fmtDate(latest.expiresAt)}${principal.status === 'disabled' ? ', but the account is disabled' : ''}.`}
						</p>
					)}
				</div>
			)}
			{notice && <p className="notice" role="status">{notice}</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			{manual && (
				<SecretModal
					title="Password link created"
					fields={[{ label: 'Password link', value: manual.url, multiline: true }]}
					note={<p className="hint">Send this link to the person over a trusted channel. It expires {fmtDate(manual.expiresAt)}.</p>}
					onClose={() => setManual(null)}
				/>
			)}
			{confirmDisable && (
				<ConfirmDialog
					title="Disable password sign-in"
					confirmLabel="Disable password sign-in"
					body={
						<p>
							Remove this person’s password and end their password sessions?{' '}
							{organizationAvailable ? 'Organization sign-ins stay available.' : 'They will need a new password setup link to sign in again.'} {propagation}
						</p>
					}
					onClose={() => setConfirmDisable(false)}
					onConfirm={async () => {
						await api.passwords.disable({ principalId: principal.id })
						setNotice(
							organizationAvailable
								? 'Password sign-in disabled. Organization sign-ins are unaffected.'
								: 'Password sign-in disabled. Send a new setup link to restore it.',
						)
						onDone()
					}}
				/>
			)}
		</section>
	)
}

function SessionLine({ session, canManage, onDone }: { session: SessionDto; canManage: boolean; onDone: () => void }) {
	const [confirm, setConfirm] = useState(false)
	return (
		<div className="user-item-row">
			<div className="user-item-title">
				<strong>{session.app === null ? methodLabels[session.authenticationMethod] : <AppName app={session.app} />}</strong>
				<span className="muted small" title={fmtDate(session.createdAt)}>
					Signed in {fmtAgo(session.createdAt)} · expires {fmtDate(session.expiresAt)}
				</span>
			</div>
			<Status lamp={session.unavailableReason === null ? 'ok' : 'idle'}>
				{session.unavailableReason === null ? 'Active' : sessionReasons[session.unavailableReason]}
			</Status>
			{session.status === 'active' && session.unavailableReason !== 'parent_ended' && (
				<button
					type="button"
					className="small danger"
					disabled={!canManage}
					onClick={() => setConfirm(true)}
				>
					Sign out
				</button>
			)}
			{confirm && (
				<ConfirmDialog
					title="End sign-in"
					confirmLabel="Sign out"
					body={
						<p>
							{session.parentSessionId === null
								? 'End this sign-in and every application session connected to it?'
								: 'End only this application session? The person can return using their organization or password sign-in.'} {propagation}
						</p>
					}
					onClose={() => setConfirm(false)}
					onConfirm={async () => {
						await api.sessions.revoke({ id: session.id })
						onDone()
					}}
				/>
			)}
		</div>
	)
}

function Connection({ connection, onDone }: { connection: UserConnectionDto; onDone: () => void }) {
	const [confirm, setConfirm] = useState(false)
	return (
		<div className="user-access-item">
			<div className="user-item-row">
				<div className="user-item-title">
					<strong>
						<AppName app={connection.app} />
					</strong>
					<span className="muted small">{connection.clientId}</span>
				</div>
				<Status lamp={connection.status === 'active' ? 'ok' : 'idle'}>{connection.status}</Status>
				{connection.status !== 'revoked' && connection.status !== 'expired' && (
					<button
						type="button"
						className="small danger"
						onClick={() => setConfirm(true)}
					>
						Disconnect
					</button>
				)}
			</div>
			<details className="user-access-explanation">
				<summary>Connection details</summary>
				<div className="user-item-detail">
					<p>{connection.resource}</p>
					<p>Scopes: {connection.scopes.join(', ')}</p>
					<p className="muted small">Authorized {fmtDate(connection.createdAt)} · expires {fmtDate(connection.expiresAt)}</p>
					{connection.status === 'unavailable' && <p className="hint">The account, original sign-in or OAuth service is unavailable.</p>}
				</div>
			</details>
			{confirm && (
				<ConfirmDialog
					title="Disconnect client"
					confirmLabel="Disconnect"
					body={<p>Revoke this client’s authorization? The person must authorize it again to reconnect. {propagation}</p>}
					onClose={() => setConfirm(false)}
					onConfirm={async () => {
						await api.connections.revoke({ id: connection.id })
						onDone()
					}}
				/>
			)}
		</div>
	)
}
