import { createPage, Link } from '@buzola/router'
import type { ApiKeyDto, GrantDto, ListResponse, RotateApiKeyResponse } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { SecretModal } from '../../components/SecretModal'
import { StatusLamp } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtExpiry, fmtScope } from '../../lib/format'

export default createPage()
	.loader(async () => {
		const apiKeys = await api.get<ListResponse<ApiKeyDto>>('/api-keys')
		return { apiKeys: apiKeys.items }
	})
	.route('/access/api-keys')
	.render(({ data, invalidate }) => {
		const grantSummary = (grants: GrantDto[]) => {
			if (grants.length === 0) return <span className="muted">no grants</span>
			return grants.map((g) => {
				const scopeLabel = fmtScope(g.scopeType === null ? null : { type: g.scopeType, value: g.scopeValue ?? '' })
				const auth = g.roleKey ?? (g.permissions ?? []).join(', ')
				return (
					<div key={g.id} className="grant-chip">
						<code>{auth}</code> <span className="muted">@ {g.app ?? 'all apps'} · {scopeLabel}</span>
					</div>
				)
			})
		}

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>API keys</h1>
							<p className="hint">
								Service principals issued a propustka-native API key (<code>px_…</code>), resolved directly by propustka. The key is shown once at creation
								and never stored.
							</p>
						</div>
						<Link to="access/api-keys/new" className="btn primary">
							<Icon name="plus" />
							Provision key
						</Link>
					</div>
				</div>

				<Table
					colSpan={4}
					isEmpty={data.apiKeys.length === 0}
					empty={
						<EmptyState
							title="No API keys provisioned yet"
							action={<Link to="access/api-keys/new" className="btn small primary">Provision the first one</Link>}
						/>
					}
					head={
						<tr>
							<th className="grow">Label</th>
							<th>Status</th>
							<th className="grow">Role / scope · expiry</th>
							<th />
						</tr>
					}
				>
					{data.apiKeys.map((key) => (
						<tr key={key.principalId}>
							<td>{key.label}</td>
							<td>
								<StatusLamp status={key.status} />
							</td>
							<td>
								{grantSummary(key.grants)}
								{key.grants.length > 0 && (
									<div className="muted small">
										expires: {key.grants.map((g) => fmtExpiry(g.expiresAt)).join(', ')}
									</div>
								)}
							</td>
							<td className="row-actions">
								<RotateButton apiKey={key} />
								<RevokeButton apiKey={key} onDone={invalidate} />
							</td>
						</tr>
					))}
				</Table>
			</>
		)
	})

function RotateButton({ apiKey }: { apiKey: ApiKeyDto }) {
	const [confirming, setConfirming] = useState(false)
	const [secret, setSecret] = useState<RotateApiKeyResponse | null>(null)

	async function rotate() {
		const result = await api.post<RotateApiKeyResponse>(`/api-keys/${apiKey.principalId}/rotate`)
		setSecret(result)
	}

	return (
		<>
			<button type="button" className="small" onClick={() => setConfirming(true)}>
				Rotate
			</button>
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

function RevokeButton({ apiKey, onDone }: { apiKey: ApiKeyDto; onDone: () => void }) {
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
