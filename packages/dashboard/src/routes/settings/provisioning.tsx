import { createPage } from '@buzola/router'
import type { ScimSettingsDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { CopyField } from '../../access/components/CopyField'
import { SecretModal } from '../../access/components/SecretModal'
import { api as iam } from '../../access/lib/api'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { fmtDate } from '../../lib/format'

/**
 * SCIM provisioning by the organization's identity provider (ADR-0091). IAM keeps the one token; the page shows the
 * tenant URL, creates or rotates the token (shown once) and removes it.
 */
export default createPage()
	.loader(async () => ({ current: await iam.scim.get() }))
	.route('/settings/provisioning')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Provisioning</h1>
				<p className="hint">
					Your identity provider creates, updates and removes people here over SCIM. A person it deactivates or deletes is signed out at once.
				</p>
			</div>
			<ProvisioningEditor current={data.current} onChanged={invalidate} />
		</>
	))

type Pending = 'rotate' | 'revoke' | null

export function ProvisioningEditor({ current, onChanged }: { current: ScimSettingsDto; onChanged: () => void }) {
	const [pending, setPending] = useState<Pending>(null)
	const [issued, setIssued] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)

	async function rotate() {
		const answer = await iam.scim.rotateToken()
		setIssued(answer.token)
		onChanged()
	}

	async function createFirst() {
		setBusy(true)
		setFailure(null)
		try {
			await rotate()
		} catch {
			setFailure('The token could not be created.')
		}
		setBusy(false)
	}

	return (
		<>
			<section aria-labelledby="provisioning-connection">
				<h2 id="provisioning-connection">Connection</h2>
				<CopyField label="Tenant URL" value={current.endpoint} />
				<p className="hint">
					In Microsoft Entra ID: Enterprise application → Provisioning, mode Automatic, the tenant URL above and the token as the secret. Map users only;
					group provisioning is not supported.
				</p>
				{current.configured
					? (
						<p>
							A token is set, created {current.createdAt === null ? '' : fmtDate(current.createdAt)}. It is not shown again; rotate it to get a new one.
						</p>
					)
					: <p className="notice" role="status">No token is set, so every provisioning request is refused.</p>}
				{failure !== null && <p className="error-text" role="alert">{failure}</p>}
				<div className="form-actions">
					{current.configured
						? <button type="button" onClick={() => setPending('rotate')}>Rotate token</button>
						: <button type="button" className="primary" disabled={busy} onClick={() => void createFirst()}>{busy ? 'Creating…' : 'Create token'}</button>}
				</div>
			</section>
			{current.configured && (
				<section className="danger-zone" aria-labelledby="provisioning-revoke">
					<h2 id="provisioning-revoke">Remove the token</h2>
					<p className="hint">The identity provider can no longer create, change or remove anyone. People already provisioned stay as they are.</p>
					<button type="button" className="danger" onClick={() => setPending('revoke')}>Remove token</button>
				</section>
			)}
			{pending === 'rotate' && (
				<ConfirmDialog
					title="Rotate the provisioning token"
					confirmLabel="Rotate token"
					body={<p>The current token stops working at once. Provisioning fails until the new one is entered in the identity provider.</p>}
					onConfirm={rotate}
					onClose={() => setPending(null)}
				/>
			)}
			{pending === 'revoke' && (
				<ConfirmDialog
					title="Remove the provisioning token"
					confirmLabel="Remove token"
					body={<p>Every provisioning request is refused from now on.</p>}
					onConfirm={async () => {
						await iam.scim.revokeToken()
						onChanged()
					}}
					onClose={() => setPending(null)}
				/>
			)}
			{issued !== null && (
				<SecretModal
					title="Provisioning token"
					fields={[{ label: 'Secret token', value: issued, multiline: true }]}
					note={<p>Enter it in the identity provider's provisioning settings as the secret token.</p>}
					onClose={() => setIssued(null)}
				/>
			)}
		</>
	)
}
