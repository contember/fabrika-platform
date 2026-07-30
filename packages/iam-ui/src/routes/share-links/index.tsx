import { createPage, Link } from '@buzola/router'
import type { ListResponse, ShareLinkListItem } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtExpiry } from '../../lib/format'

type LinkStatus = 'active' | 'expired' | 'revoked'

function linkStatus(link: ShareLinkListItem): LinkStatus {
	if (link.revokedAt !== null) return 'revoked'
	// expiresAt is epoch-seconds (backend `unixepoch()`), so compare in seconds.
	if (link.expiresAt !== null && link.expiresAt <= Date.now() / 1000) return 'expired'
	return 'active'
}

export default createPage()
	.loader(async () => {
		const shareLinks = await api.get<ListResponse<ShareLinkListItem>>('/share-links')
		return { shareLinks: shareLinks.items }
	})
	.route('/access/share-links')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<div>
						<h1>Share links</h1>
						<p className="hint">
							Anonymous, revocable <code>px_</code> credentials granting specific <code>(action, scope)</code> permissions — matched by{' '}
							<code>permits()</code> at use time, like any other token. The plaintext is shown once at issue and never stored.
						</p>
					</div>
					<Link to="access/share-links/new" className="btn primary">
						<Icon name="plus" />
						Issue link
					</Link>
				</div>
			</div>

			<Table
				colSpan={5}
				isEmpty={data.shareLinks.length === 0}
				empty={
					<EmptyState
						title="No share links issued yet"
						action={<Link to="access/share-links/new" className="btn small primary">Issue the first one</Link>}
					/>
				}
				head={
					<tr>
						<th>Label</th>
						<th className="grow">Grants</th>
						<th>Expires</th>
						<th>Status</th>
						<th />
					</tr>
				}
			>
				{data.shareLinks.map((link) => <ShareLinkRow key={link.id} link={link} onDone={invalidate} />)}
			</Table>
		</>
	))

function ShareLinkRow({ link, onDone }: { link: ShareLinkListItem; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const status = linkStatus(link)
	const lamp = status === 'active' ? 'ok' : status === 'revoked' ? 'stop' : 'idle'

	async function revoke() {
		await api.del(`/share-links/${link.id}`)
		onDone()
	}

	return (
		<tr>
			<td>{link.label ?? <span className="muted">—</span>}</td>
			<td>
				{link.grants.map((g, i) => (
					<div key={`${g.action}:${g.scope?.type ?? ''}:${g.scope?.value ?? ''}:${i}`} className="grant-chip">
						<code>{g.action}</code>
						{g.scope
							? (
								<>
									{' '}
									<span className="muted">on</span> <code>{g.scope.type}={g.scope.value}</code>
								</>
							)
							: (
								<>
									{' '}
									<span className="muted">(global)</span>
								</>
							)}
					</div>
				))}
			</td>
			<td className="nowrap">{fmtExpiry(link.expiresAt)}</td>
			<td>
				<Status lamp={lamp}>{status}</Status>
			</td>
			<td className="row-actions">
				{status !== 'revoked' && <button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>}
				{confirming && (
					<ConfirmDialog
						title="Revoke share link"
						confirmLabel="Revoke"
						body={
							<p>
								Revoke the share link <strong>{link.label ?? link.id}</strong>? Effective immediately.
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
