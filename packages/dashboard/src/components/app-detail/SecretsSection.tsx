import { useState } from 'react'
import { api, ApiError, type AppEnvDto, type AppSecretDto, type PutAppSecretRequest, type SetSecretValueRequest } from '../../lib/api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'

export function SecretsSection(
	{ appId, secrets, envs, onDone }: { appId: string; secrets: AppSecretDto[]; envs: AppEnvDto[]; onDone: () => void },
) {
	return (
		<section>
			<div className="section-head">
				<Icon name="lock" size={15} />
				<h2>Secrets</h2>
			</div>
			<p className="section-note">
				Secrets deployed with this app. The <code>*</code>{' '}
				layer applies to every env; an env-specific entry overrides it. Values are write-only: only names and where each value is kept are shown.
			</p>
			<Table
				colSpan={4}
				isEmpty={secrets.length === 0}
				empty={<EmptyState icon="lock" title="No secrets" body="Add a secret to deliver its value to every deploy of this app." />}
				head={
					<tr>
						<th>Name</th>
						<th>Layer</th>
						<th className="grow">Stored in</th>
						<th />
					</tr>
				}
			>
				{secrets.map((secret) => <SecretRow key={`${secret.env ?? '*'}/${secret.name}`} appId={appId} secret={secret} onDone={onDone} />)}
			</Table>
			<AddSecretForm appId={appId} envs={envs} onDone={onDone} />
		</section>
	)
}

function SecretRow({ appId, secret, onDone }: { appId: string; secret: AppSecretDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [settingValue, setSettingValue] = useState(false)
	/** A vault value is rotated in place; anything else is set afresh. */
	const inVault = secret.storage === 'vault'

	async function remove() {
		await api.apps.secrets.delete({ appId, name: secret.name, env: secret.env })
		onDone()
	}

	if (settingValue) {
		return (
			<SetSecretValueRow
				appId={appId}
				secret={secret}
				rotate={inVault}
				onDone={() => {
					setSettingValue(false)
					onDone()
				}}
				onCancel={() => setSettingValue(false)}
			/>
		)
	}

	return (
		<tr>
			<td>
				<code>{secret.name}</code>
			</td>
			<td>{secret.env === null ? <span className="muted">* (all envs)</span> : secret.env}</td>
			<td>
				<SecretStorage secret={secret} />
			</td>
			<td className="row-actions">
				<button type="button" className="small" onClick={() => setSettingValue(true)}>{inVault ? 'Rotate' : 'Set value'}</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete secret"
						confirmLabel="Delete"
						body={
							<p>
								Delete secret <strong>{secret.name}</strong> ({secret.env ?? 'all envs'})?
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}

function SecretStorage({ secret }: { secret: AppSecretDto }) {
	if (secret.storage === 'vault') return <code>{secret.valueRef}</code>
	if (secret.storage === 'provider') return <span className="muted">Provider-managed</span>
	return <span className="error-text small">Stored outside the vault. Set it again</span>
}

/**
 * Inline write-only setter for an app secret's VALUE. PUT (set) stores a fresh vault entry and upserts
 * the `vault:<id>` ref onto the (app, env, name) row; PATCH (rotate) re-encrypts the existing entry.
 * The value is sent once and never read back; the field clears on success. `env` rides the body.
 */
function SetSecretValueRow(
	{ appId, secret, rotate, onDone, onCancel }: { appId: string; secret: AppSecretDto; rotate: boolean; onDone: () => void; onCancel: () => void },
) {
	const [value, setValue] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: SetSecretValueRequest = { value, env: secret.env }
			// PUT sets a new vault entry; PATCH rotates the value behind the existing vault ref.
			const input = { appId, name: secret.name, value: body.value, env: body.env }
			await (rotate ? api.vault.rotate(input) : api.vault.set(input))
			setValue('')
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<tr>
			<td>
				<code>{secret.name}</code>
			</td>
			<td>{secret.env === null ? <span className="muted">* (all envs)</span> : secret.env}</td>
			<td>
				<input
					type="password"
					aria-label="Secret value"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={rotate ? 'New value' : 'Secret value'}
					autoComplete="off"
				/>
				<span className="hint">Stored encrypted in the vault. Never shown again.</span>
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td className="row-actions">
				<button type="button" className="primary small" onClick={save} disabled={busy || value === ''}>
					{busy ? 'Saving…' : rotate ? 'Rotate' : 'Set'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddSecretForm({ appId, envs, onDone }: { appId: string; envs: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	/** '' = the all-env (*) layer; otherwise an env name. */
	const [env, setEnv] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function reset() {
		setName('')
		setValue('')
		setEnv('')
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const body: PutAppSecretRequest = { name: name.trim(), value, env: env === '' ? null : env }
			await api.apps.secrets.put({ appId, secret: body })
			reset()
			setOpen(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
		} finally {
			setBusy(false)
		}
	}

	if (!open) {
		return (
			<div className="add-row">
				<button type="button" className="small" onClick={() => setOpen(true)}>
					<Icon name="plus" size={13} />
					Add secret
				</button>
			</div>
		)
	}

	return (
		<form className="panel form inline" onSubmit={submit}>
			<label>
				Name
				<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_KEY" autoComplete="off" />
			</label>
			<label>
				Layer
				<select value={env} onChange={(e) => setEnv(e.target.value)}>
					<option value="">* (all envs)</option>
					{envs.map((e) => <option key={e.env} value={e.env}>{e.env}</option>)}
				</select>
			</label>
			<label>
				Value
				<input type="password" required value={value} onChange={(e) => setValue(e.target.value)} placeholder="Secret value" autoComplete="off" />
				<span className="hint">Stored encrypted. Never shown again.</span>
			</label>
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add secret'}</button>
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</form>
	)
}
