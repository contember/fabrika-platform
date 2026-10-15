import { useNavigate } from '@buzola/router'
import { useState } from 'react'
import { api, ApiError, type AppEnvDto, type DeploymentNamespaceDto, type PutAppEnvRequest, type TriggerDeployRequest } from '../../lib/api'
import { CONSOLE_ACTIONS, mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { shortRef } from '../../lib/format'
import { cloudflareArtifactWithConfigPath, cloudflareConfigPath } from '../../lib/manifest-editor'
import { compatibleNamespaces, namespaceAssignmentRequest } from '../../lib/namespaces'
import { type FormProvider, formProvider, type ProviderRegistrationPayload, providerRegistrationPayload } from '../../lib/provider-registration'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'

export function EnvironmentsSection(
	{ appId, envs, namespaces, providerId, onDone }: {
		appId: string
		envs: AppEnvDto[]
		namespaces: DeploymentNamespaceDto[]
		/** The installation's provider; it decides what a new environment's form collects. */
		providerId: string
		onDone: () => void
	},
) {
	const provider = formProvider(providerId)
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
			{provider === null
				? (
					<p className="hint">
						This console has no environment form for provider <code>{providerId}</code>.
					</p>
				)
				: <AddEnvForm appId={appId} existing={envs} namespaces={namespaces} provider={provider} onDone={onDone} />}
		</section>
	)
}

function DeployButton({ appId, env }: { appId: string; env: AppEnvDto }) {
	const access = useConsoleAccess()
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

	if (!mayDo(access, CONSOLE_ACTIONS.DEPLOY_TRIGGER, { app: appId, env: env.env })) return null

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
				provider={null}
				namespaces={namespaces}
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

/** Shared env editor — an inline table row form for both edit and add. */
function EnvForm(
	{ appId, env, initial, provider, namespaces, onDone, onCancel, lockEnv = true }: {
		appId: string
		env: string
		initial: AppEnvDto | null
		/** Decides a NEW environment's fields and envelopes; an edit keeps the stored envelopes. */
		provider: FormProvider | null
		namespaces: DeploymentNamespaceDto[]
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
	const [manifest, setManifest] = useState('')
	const [namespaceId, setNamespaceId] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const addingZerops = initial === null && provider === 'zerops'
	const ready = provider === null ? [] : compatibleNamespaces(appId, { env: envName.trim(), provider }, namespaces)
	const providerFieldsMissing = addingZerops
		? manifest.trim() === '' || namespaceId === ''
		: initialConfigPath !== null && configPath.trim() === ''

	function placement(): ProviderRegistrationPayload | null {
		if (initial !== null) {
			return {
				namespaceId: initial.namespaceId,
				target: initial.target,
				artifact: initialConfigPath === null ? initial.artifact : cloudflareArtifactWithConfigPath(initial.artifact, configPath.trim()),
			}
		}
		return provider === null ? null : providerRegistrationPayload(provider, { configPath, manifest, namespaceId })
	}

	async function save() {
		setError(null)
		let resolved: ProviderRegistrationPayload | null
		try {
			resolved = placement()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Paste a valid fabrika.manifest.json.')
			return
		}
		if (resolved === null) return
		setBusy(true)
		try {
			const body: PutAppEnvRequest = {
				domain: domain.trim() === '' ? null : domain.trim(),
				publicOrigin: publicOrigin.trim() === '' ? null : publicOrigin.trim(),
				triggerRef: triggerRef.trim() === '' ? null : triggerRef.trim(),
				...resolved,
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
				{addingZerops
					? (
						<select aria-label="Placement" required value={namespaceId} onChange={(e) => setNamespaceId(e.target.value)}>
							<option value="">Select a ready namespace</option>
							{ready.map((namespace) => <option key={namespace.id} value={namespace.id}>{namespace.id}</option>)}
						</select>
					)
					: initial?.namespaceId === null || initial === null
					? <span className="muted">unassigned</span>
					: <code>{initial.namespaceId}</code>}
			</td>
			<td>
				{addingZerops
					? (
						<textarea
							required
							rows={4}
							aria-label="Built fabrika manifest"
							value={manifest}
							onChange={(e) => setManifest(e.target.value)}
							placeholder='{ "manifestVersion": 3, … }'
							spellCheck={false}
						/>
					)
					: initial !== null && initialConfigPath === null
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
					disabled={busy || envName.trim() === '' || providerFieldsMissing}
				>
					{busy ? 'Saving…' : 'Save'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddEnvForm(
	{ appId, existing, namespaces, provider, onDone }: {
		appId: string
		existing: AppEnvDto[]
		namespaces: DeploymentNamespaceDto[]
		provider: FormProvider
		onDone: () => void
	},
) {
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
						provider={provider}
						namespaces={namespaces}
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
