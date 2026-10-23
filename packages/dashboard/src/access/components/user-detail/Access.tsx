import { Link } from '@buzola/router'
import type { PrincipalDetail, PrincipalGrantDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { SearchField } from '../../../components/SearchField'
import { Status } from '../../../components/Status'
import { EmptyState } from '../../../components/Table'
import { fmtAgo, fmtDate } from '../../../lib/format'
import { api } from '../../lib/api'
import { AppName, useAppNames } from '../../lib/app-names'
import { fmtScope } from '../../lib/format'

export function UserAccess({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [query, setQuery] = useState('')
	const [showExpired, setShowExpired] = useState(false)
	const appNames = useAppNames()
	const now = Date.now() / 1000
	const expired = principal.grants.filter((grant) => grant.expiresAt !== null && grant.expiresAt <= now)
	const grants = principal.grants.filter((grant) =>
		(showExpired || grant.expiresAt === null || grant.expiresAt > now)
		&& [
			grant.app,
			grant.app === null ? 'Platform services' : appNames.get(grant.app),
			grant.roleName,
			grant.roleKey,
			grant.scopeValue,
			...(grant.permissions ?? []),
		].some((value) => value?.toLowerCase().includes(query.toLowerCase()))
	)
	return (
		<>
			<section>
				<div className="section-head">
					<h2>Assigned access</h2>
				</div>
				<p className="section-note">Each assignment belongs to one application and scope. Changes reach existing sign-ins within five minutes.</p>
				{principal.bootstrapMailbox && principal.affiliation === 'internal' && (
					<div className="user-state-note">
						<strong>Installation administrator from configuration</strong>
						<p>
							This address is listed in{' '}
							<code>IAM_BOOTSTRAP_ADMINS</code>. It grants administration of platform services. Application access is assigned separately. An operator
							changes this setting on the installation.
						</p>
					</div>
				)}
				{principal.grants.length > 0 && (
					<div className="filters">
						<SearchField label="Find access" value={query} onChange={setQuery} placeholder="Application, role or scope…" />
						{expired.length > 0 && (
							<button type="button" aria-pressed={showExpired} onClick={() => setShowExpired(!showExpired)}>
								{showExpired ? 'Hide' : 'Show'} expired ({expired.length})
							</button>
						)}
					</div>
				)}
				{grants.length === 0
					? (
						<EmptyState
							title={principal.grants.length === 0 ? 'No assigned access' : 'No access matches this view'}
							body={principal.grants.length === 0
								? 'Add an application role to give this person access.'
								: 'Change the search or include expired assignments.'}
						/>
					)
					: (
						<div className="user-access-list">
							{grants.map((grant) => <AccessAssignment key={grant.id} grant={grant} disabled={principal.status === 'disabled'} onDone={onDone} />)}
						</div>
					)}
			</section>
			<section>
				<div className="section-head">
					<h2>Permissions by application</h2>
				</div>
				<p className="section-note">
					The permissions IAM would include in a new token for each application. Open an application to inspect its actions and their source.
				</p>
				{principal.access.length === 0 && <EmptyState title="No application access yet" />}
				<div className="user-access-list">
					{principal.access.map((access) => (
						<details className="user-access-item" key={access.app}>
							<summary>
								<span className="user-item-title">
									<strong>
										<AppName app={access.app} />
									</strong>
									<span className="muted small">{access.lastSignInAt === null ? 'No sign-in recorded' : `Last signed in ${fmtAgo(access.lastSignInAt)}`}</span>
								</span>
								<Status lamp={access.permissions.length > 0 ? 'ok' : 'idle'}>
									{principal.status === 'disabled'
										? 'Account disabled'
										: access.permissions.length === 0
										? 'No permissions'
										: `${access.permissions.length} permission ${access.permissions.length === 1 ? 'pattern' : 'patterns'}`}
								</Status>
							</summary>
							<div className="user-item-detail">
								{access.permissions.length === 0
									? (
										<p className="muted">
											{principal.status === 'disabled'
												? 'The account must be enabled before its assigned access can be used.'
												: 'No current assignment gives permissions in this application.'}
										</p>
									)
									: (
										<ul className="user-permissions">
											{access.permissions.map((permission, index) => (
												<li key={`${permission.action}:${index}`}>
													<code>{permission.action === '*' ? 'All actions (*)' : permission.action}</code>
													<span>{fmtScope(permission.scope)}</span>
													<span className="muted">{permission.source === 'bootstrap' ? 'Installation configuration' : 'Assigned access'}</span>
												</li>
											))}
										</ul>
									)}
							</div>
						</details>
					))}
				</div>
			</section>
		</>
	)
}

function AccessAssignment({ grant, disabled, onDone }: { grant: PrincipalGrantDto; disabled: boolean; onDone: () => void }) {
	const [confirm, setConfirm] = useState(false)
	const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now() / 1000
	const label = grant.roleName ?? grant.roleKey ?? 'Custom actions'
	const scope = fmtScope(grant.scopeType === null ? null : { type: grant.scopeType, value: grant.scopeValue ?? '' })
	return (
		<div className="user-access-item">
			<div className="user-item-row">
				<div className="user-item-title">
					<strong>{grant.app === null ? 'Platform services' : <AppName app={grant.app} />}</strong>
					<span>
						{label} <span className="muted">· {scope}</span>
					</span>
				</div>
				<Status lamp={expired || disabled ? 'idle' : grant.dangling ? 'stop' : 'ok'}>
					{expired ? 'Expired' : grant.dangling ? 'Role no longer exists' : disabled ? 'Account disabled' : 'Assigned'}
				</Status>
				<div className="user-item-actions">
					{grant.canManage
						? (
							<>
								<Link to="access/users/edit-grant" params={{ id: grant.principalId, grantId: grant.id }} className="btn small">Edit</Link>
								<button type="button" className="small danger" onClick={() => setConfirm(true)}>Remove</button>
							</>
						)
						: <span className="muted small">Outside your administration</span>}
				</div>
			</div>
			<details className="user-access-explanation">
				<summary>
					Permissions and origin<span className="muted small">{grant.expiresAt === null ? 'No expiration' : `Expires ${fmtDate(grant.expiresAt)}`}</span>
				</summary>
				<div className="user-item-detail">
					{grant.dangling && (
						<p className="error-text">This role no longer exists and grants no permissions. Choose another role or remove this assignment.</p>
					)}
					<div className="inline-actions">
						{(grant.permissions ?? grant.rolePermissions).map((action) => (
							<code className="perm-chip" key={action}>{action === '*' ? 'All actions (*)' : action}</code>
						))}
					</div>
					<p className="muted small">Assigned by {grant.grantedByLabel ?? 'the system'} on {fmtDate(grant.createdAt)}.</p>
					{grant.app === null && <p className="muted small">This assignment applies to platform services, not to application environments.</p>}
				</div>
			</details>
			{confirm && (
				<ConfirmDialog
					title="Remove access"
					confirmLabel="Remove access"
					body={
						<p>
							Remove <strong>{label}</strong> in <strong>{scope}</strong>{' '}
							from this user? Other assignments stay. Existing tokens can keep this access for up to five minutes.
						</p>
					}
					onClose={() => setConfirm(false)}
					onConfirm={async () => {
						await api.grants.delete({ id: grant.id })
						onDone()
					}}
				/>
			)}
		</div>
	)
}
