import { useState } from 'react'
import { api, ApiError, type AppEnvDto, type AppVarDto, type PutAppVarRequest } from '../../lib/api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'

export function VariablesSection(
	{ appId, vars, envs, onDone }: { appId: string; vars: AppVarDto[]; envs: AppEnvDto[]; onDone: () => void },
) {
	return (
		<section>
			<div className="section-head">
				<Icon name="schema" size={15} />
				<h2>Vars</h2>
			</div>
			<p className="section-note">
				Non-secret config <strong>vars</strong> deployed with this app. The <code>*</code>{' '}
				layer applies to every env; an env-specific entry overrides it. Vars are plaintext, so their values are shown.
			</p>
			<Table
				colSpan={4}
				isEmpty={vars.length === 0}
				empty={<EmptyState icon="schema" title="No vars set" body="Plaintext config the app reads from its environment at run time." />}
				head={
					<tr>
						<th>Name</th>
						<th>Layer</th>
						<th className="grow">Value</th>
						<th />
					</tr>
				}
			>
				{vars.map((v) => <VarRow key={`${v.env ?? '*'}/${v.name}`} appId={appId} appVar={v} onDone={onDone} />)}
			</Table>
			<AddVarForm appId={appId} envs={envs} onDone={onDone} />
		</section>
	)
}

function VarRow({ appId, appVar, onDone }: { appId: string; appVar: AppVarDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		await api.apps.variables.delete({ appId, name: appVar.name, env: appVar.env })
		onDone()
	}

	return (
		<tr>
			<td>
				<code>{appVar.name}</code>
			</td>
			<td>{appVar.env === null ? <span className="muted">* (all envs)</span> : appVar.env}</td>
			<td>
				<code>{appVar.value}</code>
			</td>
			<td className="row-actions">
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete var"
						confirmLabel="Delete"
						body={
							<p>
								Delete var <strong>{appVar.name}</strong> ({appVar.env ?? 'all envs'})?
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

function AddVarForm({ appId, envs, onDone }: { appId: string; envs: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	/** '' = the all-env (*) layer; otherwise an env name. */
	const [env, setEnv] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const body: PutAppVarRequest = {
				name: name.trim(),
				value,
				env: env === '' ? null : env,
			}
			await api.apps.variables.put({ appId, variable: body })
			setName('')
			setValue('')
			setEnv('')
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
					Add var
				</button>
			</div>
		)
	}

	return (
		<form className="panel form inline" onSubmit={submit}>
			<label>
				Name
				<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="LOG_LEVEL" autoComplete="off" />
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
				<input required value={value} onChange={(e) => setValue(e.target.value)} placeholder="info" autoComplete="off" />
			</label>
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add var'}</button>
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</form>
	)
}
