import { useNavigate } from '@buzola/router'
import { useState } from 'react'
import { api, ApiError, type AppEnvDto, type DeploymentNamespaceDto, type PutAppEnvRequest, type TriggerDeployRequest } from '../../lib/api'
import { shortRef } from '../../lib/format'
import { compatibleNamespaces, namespaceAssignmentRequest } from '../../lib/namespaces'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'

export function EnvironmentsSection(
	{ appId, envs, namespaces, onDone }: {
		appId: string
		envs: AppEnvDto[]
		namespaces: DeploymentNamespaceDto[]
		onDone: () => void
	},
) {
	return (
		<section>
			<div className="section-head">
				<Icon name="bay" size={15} />
				<h2>Environments</h2>
			</div>
			<Table
				colSpan={7}
				isEmpty={envs.length === 0}
				empty={
					<EmptyState
						icon="bay"
						title="No environments yet"
						body="An environment binds this app to a namespace and a domain. It is what a deploy targets."
					/>
				}
				head={
					<tr>
						<th>Env</th>
						<th className="grow">Domain</th>
						<th className="grow">Public origin</th>
						<th>Trigger ref</th>
						<th>Placement</th>
						<th>Provider config</th>
						<th />
					</tr>
				}
			>
				{envs.map((env) => <EnvRow key={env.env} appId={appId} env={env} namespaces={namespaces} onDone={onDone} />)}
			</Table>
			<AddEnvForm appId={appId} existing={envs} onDone={onDone} />
		</section>
	)
}

function DeployButton({ appId, env }: { appId: string; env: AppEnvDto }) {
	const navigate = useNavigate()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function deploy() {
		setBusy(true)
		setError(null)
		try {
			const body: TriggerDeployRequest = { appId, env: env.env }
			const run = await api.deploy(body)
			navigate('runs/detail', { params: { id: run.id } })
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Deploy failed.')
			setBusy(false)
		}
	}

	return (
		<>
			<button type="button" className="accent small" onClick={deploy} disabled={busy}>
				<Icon name="bolt" size={12} />
				{busy ? 'Deploying…' : 'Deploy'}
			</button>
			{error && <div className="error-text small">{error}</div>}
		</>
	)
}

function EnvRow(
	{ appId, env, namespaces, onDone }: {
		appId: string
		env: AppEnvDto
		namespaces: DeploymentNamespaceDto[]
		onDone: () => void
	},
) {
	const [editing, setEditing] = useState(false)
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		await api.apps.environments.delete({ appId, env: env.env })
		onDone()
	}

	if (editing) {
		return (
			<EnvForm
				appId={appId}
				env={env.env}
				initial={env}
				onDone={() => {
					setEditing(false)
					onDone()
				}}
				onCancel={() => setEditing(false)}
			/>
		)
	}

	return (
		<tr>
			<td>
				<strong>{env.env}</strong>
			</td>
			<td>{env.domain === null ? <span className="muted">—</span> : env.domain}</td>
			<td>{env.publicOrigin === null ? <span className="muted">—</span> : <code>{env.publicOrigin}</code>}</td>
			<td>{env.triggerRef === null ? <span className="muted">manual-only</span> : <code>{shortRef(env.triggerRef)}</code>}</td>
			<td>
				<NamespaceAssignment appId={appId} environment={env} namespaces={namespaces} onDone={onDone} />
			</td>
			<td>
				<ProviderConfig environment={env} />
			</td>
			<td className="row-actions">
				<DeployButton appId={appId} env={env} />
				<button type="button" className="small" onClick={() => setEditing(true)}>Edit</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete environment"
						confirmLabel="Delete"
						body={
							<p>
								Delete environment <strong>{env.env}</strong> of <strong>{appId}</strong>?
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

function ProviderConfig({ environment }: { environment: AppEnvDto }) {
	const configPath = cloudflareConfigPath(environment.artifact)
	return configPath === null
		? <code>{environment.provider}@{environment.artifact.version}</code>
		: <code>{configPath}</code>
}

function NamespaceAssignment(
	{ appId, environment, namespaces, onDone }: {
		appId: string
		environment: AppEnvDto
		namespaces: DeploymentNamespaceDto[]
		onDone: () => void
	},
) {
	const compatible = compatibleNamespaces(appId, environment, namespaces)
	const currentIsCompatible = environment.namespaceId === null || compatible.some((namespace) => namespace.id === environment.namespaceId)
	const [selected, setSelected] = useState(environment.namespaceId ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function assign() {
		setBusy(true)
		setError(null)
		try {
			const body = namespaceAssignmentRequest(environment, selected === '' ? null : selected)
			await api.apps.environments.put({ appId, env: environment.env, environment: body })
			setBusy(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Placement assignment failed.')
			setBusy(false)
		}
	}

	return (
		<div className="namespace-assignment">
			<div className="row-actions">
				<select
					aria-label={`Placement for ${environment.env}`}
					value={selected}
					disabled={busy}
					onChange={(event) => setSelected(event.target.value)}
				>
					{environment.namespaceId === null && <option value="">Unassigned</option>}
					{!currentIsCompatible && environment.namespaceId !== null && (
						<option value={environment.namespaceId} disabled>{environment.namespaceId} (not compatible)</option>
					)}
					{compatible.map((namespace) => (
						<option key={namespace.id} value={namespace.id}>
							{namespace.id}
							{namespace.exclusiveAppId === null ? '' : ' (exclusive)'}
						</option>
					))}
				</select>
				<button
					type="button"
					className="small"
					disabled={busy || selected === (environment.namespaceId ?? '')}
					onClick={assign}
				>
					{busy ? 'Assigning…' : 'Assign'}
				</button>
			</div>
			{compatible.length === 0 && environment.namespaceId === null && <div className="hint">No compatible ready placement.</div>}
			{error && <div className="error-text small" role="alert">{error}</div>}
		</div>
	)
}

function cloudflareConfigPath(envelope: AppEnvDto['artifact']): string | null {
	if (
		envelope.provider !== 'cloudflare'
		|| envelope.version !== 1
		|| typeof envelope.payload !== 'object'
		|| envelope.payload === null
		|| Array.isArray(envelope.payload)
	) {
		return null
	}
	const configPath = envelope.payload['configPath']
	return typeof configPath === 'string' ? configPath : null
}

function cloudflareArtifactWithConfigPath(envelope: AppEnvDto['artifact'], configPath: string): AppEnvDto['artifact'] {
	if (
		envelope.provider !== 'cloudflare'
		|| envelope.version !== 1
		|| typeof envelope.payload !== 'object'
		|| envelope.payload === null
		|| Array.isArray(envelope.payload)
	) {
		return envelope
	}
	return { ...envelope, payload: { ...envelope.payload, configPath } }
}

/** Shared env editor — an inline table row form for both edit and add. */
function EnvForm(
	{ appId, env, initial, onDone, onCancel, lockEnv = true }: {
		appId: string
		env: string
		initial: AppEnvDto | null
		onDone: () => void
		onCancel: () => void
		lockEnv?: boolean
	},
) {
	const [envName, setEnvName] = useState(env)
	const [domain, setDomain] = useState(initial?.domain ?? '')
	const [publicOrigin, setPublicOrigin] = useState(initial?.publicOrigin ?? '')
	const [triggerRef, setTriggerRef] = useState(initial?.triggerRef ?? '')
	const initialConfigPath = initial === null ? 'fabrika.config.ts' : cloudflareConfigPath(initial.artifact)
	const [configPath, setConfigPath] = useState(initialConfigPath ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: PutAppEnvRequest = {
				domain: domain.trim() === '' ? null : domain.trim(),
				publicOrigin: publicOrigin.trim() === '' ? null : publicOrigin.trim(),
				triggerRef: triggerRef.trim() === '' ? null : triggerRef.trim(),
				namespaceId: initial?.namespaceId ?? null,
				target: initial?.target ?? { provider: 'cloudflare', version: 1, payload: {} },
				artifact: initial === null
					? { provider: 'cloudflare', version: 1, payload: { configPath: configPath.trim() } }
					: initialConfigPath === null
					? initial.artifact
					: cloudflareArtifactWithConfigPath(initial.artifact, configPath.trim()),
			}
			await api.apps.environments.put({ appId, env: envName.trim(), environment: body })
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<tr>
			<td>
				{lockEnv
					? <strong>{envName}</strong>
					: <input aria-label="Env" value={envName} onChange={(e) => setEnvName(e.target.value)} placeholder="stage" />}
			</td>
			<td>
				<input aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="store.acme.com" />
			</td>
			<td>
				<input
					type="url"
					aria-label="Public origin"
					value={publicOrigin}
					onChange={(e) => setPublicOrigin(e.target.value)}
					placeholder="https://store.acme.com"
				/>
			</td>
			<td>
				<input aria-label="Trigger ref" value={triggerRef} onChange={(e) => setTriggerRef(e.target.value)} placeholder="refs/heads/main" />
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td>
				{initial?.namespaceId === null || initial === null ? <span className="muted">unassigned</span> : <code>{initial.namespaceId}</code>}
			</td>
			<td>
				{initial !== null && initialConfigPath === null
					? <code>{initial.provider}@{initial.artifact.version}</code>
					: (
						<input
							required
							aria-label="Config path"
							value={configPath}
							onChange={(e) => setConfigPath(e.target.value)}
							placeholder="fabrika.config.ts"
						/>
					)}
			</td>
			<td className="row-actions">
				<button
					type="button"
					className="primary small"
					onClick={save}
					disabled={busy || envName.trim() === '' || (initialConfigPath !== null && configPath.trim() === '')}
				>
					{busy ? 'Saving…' : 'Save'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddEnvForm({ appId, existing, onDone }: { appId: string; existing: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)

	if (!open) {
		return (
			<div className="add-row">
				<button type="button" className="small" onClick={() => setOpen(true)}>
					<Icon name="plus" size={13} />
					Add environment
				</button>
			</div>
		)
	}

	return (
		<div className="table-wrap inline-add">
			<table>
				<tbody>
					<EnvForm
						appId={appId}
						env={existing.length === 0 ? 'prod' : ''}
						initial={null}
						lockEnv={false}
						onDone={() => {
							setOpen(false)
							onDone()
						}}
						onCancel={() => setOpen(false)}
					/>
				</tbody>
			</table>
		</div>
	)
}
