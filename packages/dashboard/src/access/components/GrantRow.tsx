import { Link } from '@buzola/router'
import type { ApiKeyGrantDto, GrantDto, GrantRequestDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { pendingOf } from '../../components/PendingGrant'
import { fmtAgo, fmtDate } from '../../lib/format'
import { api } from '../lib/api'
import { AppName } from '../lib/app-names'
import { fmtExpiry, fmtScope } from '../lib/format'
import { Badge } from './Badge'

/** The head of a grant table, for the rows `GrantRow` renders. */
export function GrantTableHead() {
	return (
		<tr>
			<th className="grow">Role / actions</th>
			<th>App</th>
			<th>Scope</th>
			<th>Expires</th>
			<th>Granted by</th>
			<th>Created</th>
			<th />
		</tr>
	)
}

/** One grant of an API key, with its edit and revoke. IAM decides whether the caller may change it. */
export function GrantRow({ grant, editable, onDone }: { grant: ApiKeyGrantDto; editable: boolean; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [pending, setPending] = useState<GrantRequestDto | null>(null)
	const scopeLabel = fmtScope(grant.scopeType === null ? null : { type: grant.scopeType, value: grant.scopeValue ?? '' })

	async function revoke() {
		const request = pendingOf(await api.grants.delete({ id: grant.id }))
		setPending(request)
		if (request === null) onDone()
	}

	return (
		<tr>
			<td>
				<GrantAuthorizationCell grant={grant} />
			</td>
			<td>{grant.app ? <AppName app={grant.app} /> : <span className="muted">All apps</span>}</td>
			<td>{scopeLabel}</td>
			<td className="nowrap">{fmtExpiry(grant.expiresAt)}</td>
			<td>{grant.grantedByLabel ?? <span className="muted">none</span>}</td>
			<td className="muted small nowrap" title={fmtDate(grant.createdAt)}>{fmtAgo(grant.createdAt)}</td>
			<td className="row-actions">
				{editable && (
					<Link to="access/credentials/keys/edit-grant" params={{ id: grant.principalId, grantId: grant.id }} className="btn small">
						Edit
					</Link>
				)}
				{pending
					? <span className="muted small">Revocation waits for approval</span>
					: <button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>}
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

/** Render a grant's authorization: a named role, or its inline action set. */
function GrantAuthorizationCell({ grant }: { grant: GrantDto }) {
	if (grant.roleKey !== null) {
		return (
			<>
				<code>{grant.roleKey}</code>
				{grant.dangling && (
					<Badge tone="bad" title="This role_key no longer resolves to a known role, so it grants zero permissions.">
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
