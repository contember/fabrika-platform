import { RpcError } from '@fabrika/app'
import type { GrantRequestDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { api } from '../../access/lib/api'
import { fmtDate } from '../../lib/format'
import {
	ADMIN_ROLE,
	SELF_ADMIN_EXPIRIES,
	selfAdminExpiresAt,
	type SelfAdminExpiry,
	type SelfAdminState,
	type SelfAdminTarget,
} from '../../lib/self-admin'
import { ConfirmDialog } from '../ConfirmDialog'
import { PendingGrantNotice, pendingOf } from '../PendingGrant'
import { Chip } from '../Status'

/**
 * Your own Admin in each environment of this application, for an IAM administrator. The button issues an ordinary grant
 * of the built-in `admin` to yourself through `grants.create`, so IAM checks and audits it like any other.
 */
export function AdminAccessSection({ state, onDone }: { state: SelfAdminState | null; onDone: () => void }) {
	if (state === null || state.targets.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<h2>Your admin access</h2>
			</div>
			<p className="section-note">
				In every environment, not only the one chosen above. Admin holds every action of the application there; granting it to yourself is an ordinary
				grant, audited like any other.
			</p>
			<ul className="self-admin">
				{state.targets.map((target) => <SelfAdminRow key={target.app} principalId={state.principalId} target={target} onDone={onDone} />)}
			</ul>
		</section>
	)
}

function SelfAdminRow({ principalId, target, onDone }: { principalId: string; target: SelfAdminTarget; onDone: () => void }) {
	const [expiry, setExpiry] = useState<SelfAdminExpiry>('none')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<GrantRequestDto | null>(null)
	const [confirmingRevoke, setConfirmingRevoke] = useState(false)
	const held = target.held

	async function grant() {
		setBusy(true)
		setError(null)
		try {
			const expiresAt = selfAdminExpiresAt(expiry, Math.floor(Date.now() / 1000))
			const request = pendingOf(
				await api.grants.create({ principalId, app: target.app, roleKey: ADMIN_ROLE, ...(expiresAt === null ? {} : { expiresAt }) }),
			)
			setPending(request)
			if (request === null) onDone()
		} catch (cause) {
			setError(cause instanceof RpcError ? cause.message : 'Granting Admin failed.')
		} finally {
			setBusy(false)
		}
	}

	return (
		<li>
			<Chip>{target.env}</Chip>
			<div>
				{pending !== null
					? <PendingGrantNotice request={pending} />
					: held !== null
					? (
						<div className="toolbar">
							<span>You hold Admin{held.until === null ? '' : ` until ${fmtDate(held.until)}`}.</span>
							<button type="button" className="danger small" aria-label={`Revoke my Admin on ${target.env}`} onClick={() => setConfirmingRevoke(true)}>
								Revoke
							</button>
						</div>
					)
					: (
						<div className="toolbar">
							<select
								aria-label={`Admin on ${target.env} expires`}
								value={expiry}
								disabled={busy}
								onChange={(event) => setExpiry(parseExpiry(event.target.value))}
							>
								{SELF_ADMIN_EXPIRIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
							</select>
							<button type="button" disabled={busy} aria-label={`Grant me Admin on ${target.env}`} onClick={() => void grant()}>
								Grant me Admin
							</button>
						</div>
					)}
				{error && <div className="error-text small" role="alert">{error}</div>}
			</div>
			{confirmingRevoke && held !== null && (
				<ConfirmDialog
					title="Revoke your Admin"
					confirmLabel="Revoke"
					body={
						<p>
							Revoke your Admin on{' '}
							<strong>{target.env}</strong>? You keep what your other grants give you there. A token you already hold can keep Admin for up to five minutes.
						</p>
					}
					onClose={() => setConfirmingRevoke(false)}
					onConfirm={async () => {
						const request = pendingOf(await api.grants.delete({ id: held.grantId }))
						setPending(request)
						if (request === null) onDone()
					}}
				/>
			)}
		</li>
	)
}

function parseExpiry(value: string): SelfAdminExpiry {
	return SELF_ADMIN_EXPIRIES.find((option) => option.value === value)?.value ?? 'none'
}
