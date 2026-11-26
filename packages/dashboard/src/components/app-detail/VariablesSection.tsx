import { useRef, useState } from 'react'
import { api, ApiError, type AppEnvDto, type AppVarDto, type PutAppVarRequest } from '../../lib/api'
import { cellAt, type LayeredName, layerLabel, layersByName } from '../../lib/config-layers'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { EmptyState } from '../Table'
import { LayerTable } from './LayerTable'

/** The layer an editor works on: one name on one environment, or (`env` null) on all of them. */
interface VarLayer {
	readonly row: LayeredName<AppVarDto>
	readonly env: string | null
}

export function VariablesSection(
	{ appId, vars, envs, onDone }: { appId: string; vars: AppVarDto[]; envs: AppEnvDto[]; onDone: () => void },
) {
	const [open, setOpen] = useState<VarLayer | null>(null)
	const [adding, setAdding] = useState(false)
	const [saved, setSaved] = useState<string | null>(null)
	/** The cell button that opened the editor: focus goes back to it when the editor closes. */
	const opener = useRef<HTMLButtonElement | null>(null)
	const rows = layersByName(vars)

	function toggle(row: LayeredName<AppVarDto>, env: string | null, button: HTMLButtonElement) {
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
				<h2>Variables</h2>
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
					Add variable
				</button>
			</div>
			<p className="section-note">
				Plain configuration the app reads at run time, shown in clear to everyone who manages it. Each environment reads its own value or, without one,
				the value for all environments. A token or password goes in Secrets.
			</p>
			<p className={saved === null ? 'sr-only' : 'notice saved-note'} role="status">{saved}</p>
			<LayerTable
				rows={rows}
				envs={envs}
				empty={<EmptyState icon="schema" title="No variables" body="Plain configuration the app reads from its environment at run time." />}
				cell={(row, env) => (
					<VarCell
						row={row}
						env={env}
						open={open?.row.name === row.name && open.env === env}
						onOpen={(button) => toggle(row, env, button)}
					/>
				)}
				after={(row, columns) =>
					open?.row.name === row.name && (
						<VarLayerEditor
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
			{adding && <AddVarDialog appId={appId} envs={envs} onDone={done} onClose={() => setAdding(false)} />}
		</section>
	)
}

function VarCell(
	{ row, env, open, onOpen }: { row: LayeredName<AppVarDto>; env: string | null; open: boolean; onOpen: (button: HTMLButtonElement) => void },
) {
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	const inherits = own === null && env !== null && cellAt(row, env).kind === 'inherits'
	const words = own !== null ? own.value : inherits ? 'reads the value for all environments' : 'not set'
	return (
		<button
			type="button"
			className="small"
			aria-label={`${row.name} on ${layerLabel(env)}: ${words}`}
			aria-expanded={open}
			onClick={(event) => onOpen(event.currentTarget)}
		>
			{own !== null
				? <code className="layer-value" title={own.value}>{own.value}</code>
				: <span className="muted">{inherits ? 'from all' : 'not set'}</span>}
		</button>
	)
}

/** What deleting a variable's layer leaves the environments with. */
export function varDeleteConsequence(row: LayeredName<AppVarDto>, env: string | null, envs: readonly AppEnvDto[]): string {
	if (env !== null) return row.all !== null ? `${env} then reads the value for all environments.` : `${env} then has no value for it.`
	const losing = envs.filter((candidate) => !row.byEnv.has(candidate.env)).map((candidate) => candidate.env)
	return losing.length === 0 ? 'Every environment has its own value, so none loses it.' : `Then ${losing.join(', ')} has no value for it.`
}

function takesEffect(env: string | null): string {
	return env === null ? 'Each environment without its own value reads it from its next deploy.' : `${env} reads it from its next deploy.`
}

/** One layer's value, edited in a row under its name: change it, or delete it after a confirmation. */
function VarLayerEditor(
	{ appId, layer, envs, columns, onDone, onClose }: {
		appId: string
		layer: VarLayer
		envs: readonly AppEnvDto[]
		columns: number
		onDone: (message: string) => void
		onClose: () => void
	},
) {
	const { row, env } = layer
	const own = env === null ? row.all : row.byEnv.get(env) ?? null
	const where = layerLabel(env)
	const [value, setValue] = useState(own?.value ?? '')
	/** Stores a value Control would refuse as looking like a credential. */
	const [notSecret, setNotSecret] = useState(false)
	const [deleting, setDeleting] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		const variable: PutAppVarRequest = { name: row.name, value, env, ...(notSecret ? { notSecret: true } : {}) }
		try {
			await api.apps.variables.put({ appId, variable })
			onDone(`${row.name} on ${where} saved. ${takesEffect(env)}`)
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	const now = own !== null
		? null
		: env === null
		? 'Not set for all environments. A value here reaches every environment without its own.'
		: row.all !== null
		? `Not set on ${env}: it reads ${row.all.value} from all environments. A value here overrides it for ${env}.`
		: `Not set on ${env} or for all environments.`

	return (
		<tr className="layer-editor">
			<td colSpan={columns}>
				<form className="form" onSubmit={save} onKeyDown={(event) => event.key === 'Escape' && !busy && !deleting && onClose()}>
					<p>
						<strong>{row.name} on {where}</strong> {now !== null && <span className="muted">{now}</span>}
					</p>
					<label>
						Value
						<input required autoFocus value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
						<span className="hint">{takesEffect(env)}</span>
					</label>
					<label className="checkbox">
						<input type="checkbox" checked={notSecret} onChange={(event) => setNotSecret(event.target.checked)} />
						Not a secret (store it even if it looks like a credential)
					</label>
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy || value === '' || value === own?.value}>{busy ? 'Saving…' : 'Save'}</button>
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
						title="Delete variable"
						confirmLabel="Delete"
						body={
							<p>
								Delete <strong>{row.name}</strong> on {where}? {varDeleteConsequence(row, env, envs)}
							</p>
						}
						onConfirm={async () => {
							await api.apps.variables.delete({ appId, name: row.name, env })
							onDone(`${row.name} on ${where} deleted.`)
						}}
						onClose={() => setDeleting(false)}
					/>
				)}
			</td>
		</tr>
	)
}

function AddVarDialog(
	{ appId, envs, onDone, onClose }: { appId: string; envs: readonly AppEnvDto[]; onDone: (message: string) => void; onClose: () => void },
) {
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	/** '' = the layer for all environments; otherwise an environment's name. */
	const [layer, setLayer] = useState('')
	const [notSecret, setNotSecret] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		const env = layer === '' ? null : layer
		const variable: PutAppVarRequest = { name: name.trim(), value, env, ...(notSecret ? { notSecret: true } : {}) }
		try {
			await api.apps.variables.put({ appId, variable })
			onDone(`${name.trim()} added for ${layerLabel(env)}. ${takesEffect(env)}`)
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<Modal title="Add a variable" onClose={busy ? undefined : onClose}>
			<form className="form" onSubmit={submit}>
				<label>
					Name
					<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="LOG_LEVEL" autoComplete="off" />
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
					<input required value={value} onChange={(event) => setValue(event.target.value)} placeholder="info" autoComplete="off" />
				</label>
				<label className="checkbox">
					<input type="checkbox" checked={notSecret} onChange={(event) => setNotSecret(event.target.checked)} />
					Not a secret (store it even if it looks like a credential)
				</label>
				<div className="form-actions">
					<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add variable'}</button>
					<button type="button" onClick={onClose} disabled={busy}>Cancel</button>
				</div>
				{error !== null && <p className="error-text" role="alert">{error}</p>}
			</form>
		</Modal>
	)
}
