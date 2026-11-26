import { useRef, useState } from 'react'
import { api, ApiError, type AppEnvDto, type AppSecretDto } from '../../lib/api'
import { cellAt, type LayeredName, layerLabel, layersByName } from '../../lib/config-layers'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { Status } from '../Status'
import { EmptyState } from '../Table'
import { LayerTable } from './LayerTable'

/** The layer an editor works on: one name on one environment, or (`env` null) on all of them. */
interface SecretLayer {
	readonly row: LayeredName<AppSecretDto>
	readonly env: string | null
}

export function SecretsSection(
	{ appId, secrets, envs, onDone }: { appId: string; secrets: AppSecretDto[]; envs: AppEnvDto[]; onDone: () => void },
) {
	const [open, setOpen] = useState<SecretLayer | null>(null)
	const [adding, setAdding] = useState(false)
	const [saved, setSaved] = useState<string | null>(null)
	/** The cell button that opened the editor: focus goes back to it when the editor closes. */
	const opener = useRef<HTMLButtonElement | null>(null)
	const rows = layersByName(secrets)

	function toggle(row: LayeredName<AppSecretDto>, env: string | null, button: HTMLButtonElement) {
		setSaved(null)
		if (open?.row.name === row.name && open.env === env) {
			close()
			return
		}
		opener.current = button
		setOpen({ row, env })
	}

	function close() {
		setOpen(null)
		opener.current?.focus()
	}

	function done(message: string) {
		if (open !== null) close()
		setAdding(false)
		setSaved(message)
		onDone()
	}

	return (
		<section>
			<div className="section-head">
				<h2>Secrets</h2>
				<span className="spacer" />
				<button
					type="button"
					className="small"
					onClick={() => {
						setSaved(null)
						setAdding(true)
					}}
				>
					<Icon name="plus" size={13} />
					Add secret
				</button>
			</div>
			<p className="section-note">
				Each environment reads its own value or, without one, the value for all environments. Values are write-only: nobody reads them back here.
			</p>
			<p className={saved === null ? 'sr-only' : 'notice saved-note'} role="status">{saved}</p>
			<LayerTable
				rows={rows}
				envs={envs}
				empty={<EmptyState icon="lock" title="No secrets" body="Add a secret to deliver its value to every deploy of this app." />}
				cell={(row, env) => (
					<SecretCell
						row={row}
						env={env}
						open={open?.row.name === row.name && open.env === env}
						onOpen={(button) => toggle(row, env, button)}
					/>
				)}
				after={(row, columns) =>
					open?.row.name === row.name && (
						<SecretLayerEditor
							key={`${row.name}/${open.env ?? '*'}`}
							appId={appId}
							layer={{ row, env: open.env }}
							envs={envs}
							columns={columns}
							onDone={done}
							onClose={close}
						/>
					)}
			/>
			{adding && <AddSecretDialog appId={appId} envs={envs} onDone={done} onClose={() => setAdding(false)} />}
		</section>
	)
}

/** What a layer of a secret says: set (and where), taken from all environments, or missing. */
function SecretCell(
	{ row, env, open, onOpen }: { row: LayeredName<AppSecretDto>; env: string | null; open: boolean; onOpen: (button: HTMLButtonElement) => void },
) {
	const state = secretCellState(row, env)
	return (
		<button
			type="button"
			className="ghost small"
			aria-label={`${row.name} on ${layerLabel(env)}: ${state.words}`}
			aria-expanded={open}
			onClick={(event) => onOpen(event.currentTarget)}
		>
			{state.mark}
		</button>
	)
}

/** A cell's mark and the words a screen reader hears for it. */
export function secretCellState(row: LayeredName<AppSecretDto>, env: string | null): { mark: React.ReactNode; words: string } {
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	if (own !== null && own.storage === 'legacy') {
		return { mark: <Status lamp="stop">set again</Status>, words: 'stored outside the vault, set it again' }
	}
	if (own !== null) return { mark: <Status lamp="ok">set</Status>, words: 'set' }
	if (env === null) return { mark: <span className="muted">not set</span>, words: 'not set' }
	if (cellAt(row, env).kind === 'inherits') return { mark: <span className="muted">from all</span>, words: 'reads the value for all environments' }
	return { mark: <Status lamp="run">missing</Status>, words: 'missing' }
}

/** Where a layer's value is now, in a sentence. */
export function secretWhereabouts(row: LayeredName<AppSecretDto>, env: string | null): string {
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	if (own !== null) {
		if (own.storage === 'vault') return "Set, sealed in Control's vault."
		if (own.storage === 'provider') return `Set, kept by the provider of ${env ?? 'each environment'}.`
		return 'Stored outside the vault, so a deploy cannot read it: set it again.'
	}
	if (env === null) return 'Not set for all environments. A value here reaches every environment without its own.'
	if (row.all !== null) return `Not set on ${env}: it reads the value for all environments. A value here overrides it for ${env}.`
	return `Not set on ${env} or for all environments: a deploy of ${env} has no value for it.`
}

/** What deleting a layer leaves the environments with. */
export function secretDeleteConsequence(row: LayeredName<AppSecretDto>, env: string | null, envs: readonly AppEnvDto[]): string {
	if (env !== null) return row.all !== null ? `${env} then reads the value for all environments.` : `A deploy of ${env} then has no value for it.`
	const losing = envs.filter((candidate) => !row.byEnv.has(candidate.env)).map((candidate) => candidate.env)
	return losing.length === 0 ? 'Every environment has its own value, so none loses it.' : `Then a deploy of ${losing.join(', ')} has no value for it.`
}

/** How a new value for a layer is written: a vault value is rotated in place; anything else is set afresh. */
export function secretWrite(row: LayeredName<AppSecretDto>, env: string | null): 'rotate' | 'set' {
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	return own?.storage === 'vault' ? 'rotate' : 'set'
}

/** When a new value reaches the environments. */
function takesEffect(env: string | null): string {
	return env === null ? 'Each environment without its own value reads it from its next deploy.' : `${env} reads it from its next deploy.`
}

/** One layer's value, edited in a row under its name: set or rotate it, or delete it after a confirmation. */
function SecretLayerEditor(
	{ appId, layer, envs, columns, onDone, onClose }: {
		appId: string
		layer: SecretLayer
		envs: readonly AppEnvDto[]
		columns: number
		onDone: (message: string) => void
		onClose: () => void
	},
) {
	const { row, env } = layer
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	const rotate = secretWrite(row, env) === 'rotate'
	const [value, setValue] = useState('')
	const [deleting, setDeleting] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const where = layerLabel(env)

	async function save(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		const input = { appId, name: row.name, value, env }
		try {
			await (rotate ? api.vault.rotate(input) : api.vault.set(input))
			onDone(`${row.name} on ${where}: new value saved. ${takesEffect(env)}`)
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<tr className="layer-editor">
			<td colSpan={columns}>
				<form className="form" onSubmit={save} onKeyDown={(event) => event.key === 'Escape' && !busy && !deleting && onClose()}>
					<p>
						<strong>{row.name} on {where}</strong> <span className="muted">{secretWhereabouts(row, env)}</span>
					</p>
					<label>
						{rotate ? 'New value' : 'Secret value'}
						<input type="password" required autoFocus value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" />
						<span className="hint">Never shown again. {takesEffect(env)}</span>
					</label>
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy || value === ''}>{busy ? 'Saving…' : rotate ? 'Rotate' : 'Set'}</button>
						<button type="button" onClick={onClose} disabled={busy}>Cancel</button>
						{own !== null && (
							<>
								<span className="spacer" />
								<button type="button" className="danger ghost" onClick={() => setDeleting(true)} disabled={busy}>Delete…</button>
							</>
						)}
					</div>
					{error !== null && <p className="error-text" role="alert">{error}</p>}
				</form>
				{deleting && (
					<ConfirmDialog
						title="Delete secret"
						confirmLabel="Delete"
						body={
							<p>
								Delete <strong>{row.name}</strong> on {where}? {secretDeleteConsequence(row, env, envs)}
							</p>
						}
						onConfirm={async () => {
							await api.apps.secrets.delete({ appId, name: row.name, env })
							onDone(`${row.name} on ${where} deleted.`)
						}}
						onClose={() => setDeleting(false)}
					/>
				)}
			</td>
		</tr>
	)
}

function AddSecretDialog(
	{ appId, envs, onDone, onClose }: { appId: string; envs: readonly AppEnvDto[]; onDone: (message: string) => void; onClose: () => void },
) {
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	/** '' = the layer for all environments; otherwise an environment's name. */
	const [layer, setLayer] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		const env = layer === '' ? null : layer
		try {
			await api.apps.secrets.put({ appId, secret: { name: name.trim(), value, env } })
			onDone(`${name.trim()} added for ${layerLabel(env)}. ${takesEffect(env)}`)
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<Modal title="Add a secret" onClose={busy ? undefined : onClose}>
			<form className="form" onSubmit={submit}>
				<label>
					Name
					<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="STRIPE_KEY" autoComplete="off" />
				</label>
				<label>
					Environment
					<select value={layer} onChange={(event) => setLayer(event.target.value)}>
						<option value="">All environments</option>
						{envs.map((env) => <option key={env.env} value={env.env}>{env.env}</option>)}
					</select>
				</label>
				<label>
					Value
					<input type="password" required value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" />
					<span className="hint">Never shown again.</span>
				</label>
				<div className="form-actions">
					<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add secret'}</button>
					<button type="button" onClick={onClose} disabled={busy}>Cancel</button>
				</div>
				{error !== null && <p className="error-text" role="alert">{error}</p>}
			</form>
		</Modal>
	)
}
