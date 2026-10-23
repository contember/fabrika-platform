import type { PrincipalDetail } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { fmtDate } from '../../../lib/format'
import { useAdministration } from '../../lib/administration'
import { api } from '../../lib/api'

export function UserAccount({ principal, onDone }: { principal: PrincipalDetail; onDone: () => void }) {
	const [action, setAction] = useState<'toggle' | 'promote' | null>(null)
	const administration = useAdministration()
	const disabled = principal.status === 'disabled'
	return (
		<>
			<section>
				<div className="section-head">
					<h2>Account details</h2>
				</div>
				<dl className="detail-grid user-account-facts">
					<div>
						<dt>Email</dt>
						<dd>{principal.email ?? 'Not recorded'}</dd>
					</div>
					<div>
						<dt>Affiliation</dt>
						<dd>{principal.affiliation === 'external' ? 'External, password sign-in and external roles only' : 'Internal'}</dd>
					</div>
					<div>
						<dt>Created</dt>
						<dd>{fmtDate(principal.createdAt)}</dd>
					</div>
					<div>
						<dt>Activated</dt>
						<dd>{principal.activatedAt === null ? 'Not yet activated' : fmtDate(principal.activatedAt)}</dd>
					</div>
					{principal.disabledAt !== null && (
						<div>
							<dt>Disabled</dt>
							<dd>{fmtDate(principal.disabledAt)}</dd>
						</div>
					)}
					<div>
						<dt>User ID</dt>
						<dd>
							<code>{principal.id}</code>
						</dd>
					</div>
					<div>
						<dt>Identity provider ID</dt>
						<dd>
							<code>{principal.externalId ?? 'Not linked'}</code>
						</dd>
					</div>
				</dl>
			</section>
			{!principal.management.account && (
				<p className="user-state-note">
					This person has access outside your administration. An installation administrator manages their account and sign-ins.
				</p>
			)}
			{principal.affiliation === 'external' && administration.kind === 'installation' && (
				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Make this person internal</strong>Allows organization sign-in and internal roles. Ends their sign-ins and outstanding password links.
					</div>
					<button type="button" className="danger" onClick={() => setAction('promote')}>Make internal</button>
				</div>
			)}
			<div className="danger-zone">
				<div className="danger-zone-copy">
					<strong>{disabled ? 'Enable account' : 'Disable account'}</strong>
					{disabled
						? 'Restore assigned access. Existing unexpired sign-ins can work again too.'
						: 'Block this account while keeping its access assignments. Existing tokens expire within five minutes.'}
				</div>
				<button type="button" className={disabled ? '' : 'danger'} disabled={!principal.management.account} onClick={() => setAction('toggle')}>
					{disabled ? 'Enable account' : 'Disable account'}
				</button>
			</div>
			{action !== null && (
				<ConfirmDialog
					title={action === 'promote' ? 'Make user internal' : disabled ? 'Enable account' : 'Disable account'}
					confirmLabel={action === 'promote' ? 'Make internal' : disabled ? 'Enable account' : 'Disable account'}
					onClose={() => setAction(null)}
					body={action === 'promote'
						? (
							<>
								<p>
									Make <strong>{principal.label}</strong>{' '}
									internal? They can then receive internal roles and use organization sign-in. All existing sign-ins and password links end. This cannot be
									undone.
								</p>
								{principal.bootstrapMailbox && (
									<p className="error-text">This address is an installation administrator in configuration. Making it internal activates that authority.</p>
								)}
							</>
						)
						: (
							<p>
								{disabled ? 'Enable' : 'Disable'} <strong>{principal.label}</strong>? {disabled
									? 'Their assigned access becomes available again, including through existing unexpired sign-ins.'
									: 'Their assignments stay, but new tokens will be refused. Existing tokens can remain valid for up to five minutes.'}
							</p>
						)}
					onConfirm={async () => {
						if (action === 'promote') await api.principals.promote({ principalId: principal.id })
						else await api.principals.update({ principalId: principal.id, disabled: !disabled })
						onDone()
					}}
				/>
			)}
		</>
	)
}
