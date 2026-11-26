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
				grant, audited and revoked under your account.
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
					: target.held !== null
					? <span>You hold Admin{target.held.until === null ? '' : ` until ${fmtDate(target.held.until)}`}.</span>
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
		</li>
	)
}

function parseExpiry(value: string): SelfAdminExpiry {
	return SELF_ADMIN_EXPIRIES.find((option) => option.value === value)?.value ?? 'none'
}
