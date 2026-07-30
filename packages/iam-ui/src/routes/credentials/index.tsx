import { createPage, Link } from '@buzola/router'
import type { ApiKeyDto, GrantDto, ListResponse, RotateApiKeyResponse, ShareLinkListItem } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { SecretModal } from '../../components/SecretModal'
import { PrincipalStatus, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtExpiry, fmtScope, shareLinkState } from '../../lib/format'

// Every non-human way in, on one page. Both kinds are `px_…` credentials resolved by propustka and both
// are shown exactly once at issue; they differ in what they are bound to. An API key belongs to a
// service principal — a machine with a name in the audit trail. A share link belongs to nobody: it
// carries a frozen set of (action, scope) pairs and is normally issued by an app on a user's behalf, so
// this page is where you audit and revoke them rather than where they are minted day to day.
//
// Two sections, two constructive steps — so neither button is filled. This page has no single primary.

export default createPage()
	.loader(async () => {
		const [apiKeys, shareLinks] = await Promise.all([
			api.get<ListResponse<ApiKeyDto>>('/api-keys'),
			api.get<ListResponse<ShareLinkListItem>>('/share-links'),
		])
		return { apiKeys: apiKeys.items, shareLinks: shareLinks.items }
	})
	.route('/access/credentials')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Credentials</h1>
				<p className="hint">
					The ways in that are not a person signing in. Both kinds are <code>px_…</code> tokens matched by <code>permits()</code>{' '}
					at use time, and the plaintext is shown once at issue and never stored.
				</p>
			</div>

			<section>
				<div className="section-head">
					<Icon name="key" size={15} />
					<h2>API keys</h2>
					<span className="spacer" />
					<Link to="access/credentials/keys/new" className="btn small">
						<Icon name="plus" size={13} />
						Provision key
					</Link>
				</div>
				<p className="section-note">Bound to a service principal, so everything the key does is attributed to a name in the audit trail.</p>
				{/* A key's name and what it may do are one fact, so they share a cell — as two columns they fought over the same slack. */}
				<Table
					colSpan={3}
					isEmpty={data.apiKeys.length === 0}
					empty={
						<EmptyState
							title="No API keys provisioned yet"
							body="Provisioning a key creates the service principal that owns it — CI, a cron job, another service."
							action={<Link to="access/credentials/keys/new" className="btn small">Provision the first one</Link>}
						/>
					}
					head={
						<tr>
							<th className="grow">Service</th>
							<th>Status</th>
							<th />
						</tr>
					}
				>
					{data.apiKeys.map((key) => <ApiKeyRow key={key.principalId} apiKey={key} onDone={invalidate} />)}
				</Table>
			</section>

			<section>
				<div className="section-head">
					<Icon name="link" size={15} />
					<h2>Share links</h2>
					<span className="spacer" />
					<Link to="access/credentials/links/new" className="btn small">
						<Icon name="plus" size={13} />
						Issue link
					</Link>
				</div>
				<p className="section-note">
					Anonymous and revocable. Apps issue most of these on a user's behalf; either way you can only delegate what you hold yourself.
				</p>
				<Table
					colSpan={4}
					isEmpty={data.shareLinks.length === 0}
					empty={
						<EmptyState
							title="No share links issued"
							body="Nothing here yet — including anything an app would have issued through the API."
							action={<Link to="access/credentials/links/new" className="btn small">Issue one by hand</Link>}
						/>
					}
					head={
						<tr>
							<th className="grow">Share link</th>
							<th>Expires</th>
							<th>Status</th>
							<th />
						</tr>
					}
				>
					{data.shareLinks.map((link) => <ShareLinkRow key={link.id} link={link} onDone={invalidate} />)}
				</Table>
			</section>
		</>
	))

/** An API key's grants: what it may do, where, and until when. Rendered inside the row's muted line. */
function GrantSummary({ grants }: { grants: GrantDto[] }) {
	if (grants.length === 0) return <span title="This key authenticates but resolves to zero permissions.">no grants</span>
	return (
		<>
			{grants.map((grant) => {
				const scope = fmtScope(grant.scopeType === null ? null : { type: grant.scopeType, value: grant.scopeValue ?? '' })
				return (
					<div key={grant.id} className="grant-chip">
						<code>{grant.roleKey ?? (grant.permissions ?? []).join(', ')}</code> on {grant.app ?? 'all apps'} · {scope} · expires{' '}
						{fmtExpiry(grant.expiresAt).toLowerCase()}
					</div>
				)
			})}
		</>
	)
}

function ApiKeyRow({ apiKey, onDone }: { apiKey: ApiKeyDto; onDone: () => void }) {
	return (
		<tr>
			<td>
				{apiKey.label}
				<div className="muted small">
					<GrantSummary grants={apiKey.grants} />
				</div>
			</td>
			<td>
				<PrincipalStatus status={apiKey.status} />
			</td>
			<td className="row-actions">
				<RotateButton apiKey={apiKey} />
				<RevokeKeyButton apiKey={apiKey} onDone={onDone} />
			</td>
		</tr>
	)
}

function RotateButton({ apiKey }: { apiKey: ApiKeyDto }) {
	const [confirming, setConfirming] = useState(false)
	const [secret, setSecret] = useState<RotateApiKeyResponse | null>(null)

	async function rotate() {
		setSecret(await api.post<RotateApiKeyResponse>(`/api-keys/${apiKey.principalId}/rotate`))
	}

	return (
		<>
			<button type="button" className="small" onClick={() => setConfirming(true)}>Rotate</button>
			{confirming && (
				<ConfirmDialog
					title="Rotate key"
					confirmLabel="Rotate"
					body={
						<p>
							Rotate the key for <strong>{apiKey.label}</strong>? The old key stops working immediately.
						</p>
					}
					onConfirm={rotate}
					onClose={() => setConfirming(false)}
				/>
			)}
			{secret && (
				<SecretModal
					title="Key rotated"
					fields={[{ label: 'API key (propustka-native)', value: secret.apiKey, multiline: true }]}
					onClose={() => setSecret(null)}
				/>
			)}
		</>
	)
}

function RevokeKeyButton({ apiKey, onDone }: { apiKey: ApiKeyDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function revoke() {
		await api.del(`/api-keys/${apiKey.principalId}`)
		onDone()
	}

	return (
		<>
			<button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>
			{confirming && (
				<ConfirmDialog
					title="Revoke API key"
					confirmLabel="Revoke"
					body={
						<p>
							Revoke <strong>{apiKey.label}</strong>? This deletes its grants and credential immediately — any caller using it stops working.
						</p>
					}
					onConfirm={revoke}
					onClose={() => setConfirming(false)}
				/>
			)}
		</>
	)
}

function ShareLinkRow({ link, onDone }: { link: ShareLinkListItem; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const state = shareLinkState(link)

	async function revoke() {
		await api.del(`/share-links/${link.id}`)
		onDone()
	}

	return (
		<tr>
			<td>
				{link.label ?? <span className="muted">unlabelled</span>}
				<div className="muted small">
					{link.grants.map((grant, i) => (
						<div key={`${grant.action}:${grant.scope?.type ?? ''}:${grant.scope?.value ?? ''}:${i}`} className="grant-chip">
							<code>{grant.action}</code> on {grant.scope === null ? 'everything' : `${grant.scope.type} = ${grant.scope.value}`}
						</div>
					))}
				</div>
			</td>
			<td className="nowrap">{fmtExpiry(link.expiresAt)}</td>
			<td>
				<Status lamp={state === 'active' ? 'ok' : state === 'revoked' ? 'stop' : 'idle'}>{state}</Status>
			</td>
			<td className="row-actions">
				{state !== 'revoked' && <button type="button" className="danger small" onClick={() => setConfirming(true)}>Revoke</button>}
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
