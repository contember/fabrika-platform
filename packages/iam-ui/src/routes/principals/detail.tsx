import { createPage, Link } from '@buzola/router'
import type { GrantDto, PermissionEntry, PrincipalDetail, UpdatePrincipalRequest } from '@fabrika/iam/admin'
import { useState } from 'react'
import { Badge, StatusBadge } from '../../components/Badge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtDate, fmtExpiry, fmtScope } from '../../lib/format'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ principal: await api.get<PrincipalDetail>(`/principals/${params.id}`) }))
	.route('/access/principals/:id')
	.render(({ data, invalidate }) => {
		const { principal } = data

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<h1>{principal.label}</h1>
						<StatusBadge status={principal.status} />
					</div>
					<div className="subtitle">
						<span>{principal.type}</span>
						{principal.email && <span className="dot-sep">{principal.email}</span>}
						{principal.externalId && <span className="dot-sep">{principal.externalId}</span>}
						<span className="dot-sep">created {fmtDate(principal.createdAt)}</span>
					</div>
					<DisableToggle principal={principal} onDone={invalidate} />
				</div>

				<section>
					<h2>Effective permissions</h2>
					<p className="hint">Why this principal has each permission — resolved from grants, group mappings and bootstrap.</p>
					<Table
						colSpan={3}
						isEmpty={principal.permissions.length === 0}
						empty={<EmptyState title="No effective permissions" />}
						head={
							<tr>
								<th>Action</th>
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
						<h2>Grants</h2>
						<span className="spacer" />
						<Link to="access/principals/grant" params={{ id: principal.id }} className="btn small primary">Add grant</Link>
					</div>
					<Table
						colSpan={7}
						isEmpty={principal.grants.length === 0}
						empty={
							<EmptyState
								title="No explicit grants"
								body="This principal only has whatever its group mappings or bootstrap give it."
								action={<Link to="access/principals/grant" params={{ id: principal.id }} className="btn small primary">Add the first grant</Link>}
							/>
						}
						head={
							<tr>
								<th>Role / actions</th>
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
			</>
		)
	})

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
		await api.patch(`/principals/${principal.id}`, body)
		onDone()
	}

	return (
		<>
			<button
				type="button"
				className={disabled ? 'primary' : 'danger'}
				onClick={() => setConfirming(true)}
			>
				{disabled ? 'Enable' : 'Disable'}
			</button>
			{confirming && (
				<ConfirmDialog
					title={disabled ? 'Enable principal' : 'Disable principal'}
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
		</>
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
		await api.del(`/grants/${grant.id}`)
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
			<td>{fmtDate(grant.createdAt)}</td>
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
