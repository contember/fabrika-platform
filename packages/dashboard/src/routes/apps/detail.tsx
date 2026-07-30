import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { RunStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import {
	api,
	ApiError,
	type AppDto,
	type AppEnvDto,
	type AppSecretDto,
	type AppVarDto,
	type CursorList,
	type DeploymentNamespaceDto,
	type DeploymentNamespaceListResponse,
	type ListResponse,
	type PutAppEnvRequest,
	type PutAppSecretRequest,
	type PutAppVarRequest,
	type RunDto,
	type SetSecretValueRequest,
	type TriggerDeployRequest,
} from '../../lib/api'
import { fmtAgo, fmtDate, qs, shortRef, shortSha } from '../../lib/format'
import { compatibleNamespaces, namespaceAssignmentRequest } from '../../lib/namespaces'

// App detail — the per-app registry + operations view: its meta, its environments (each with a
// Deploy button + edit/delete), its secret references (names + layer + vault ref, values never shown),
// and the most recent runs for this app. Add/edit/delete go through the manage actions on `/api/apps/:id/*`.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [app, envs, secrets, vars, runs, namespaces] = await Promise.all([
			api.get<AppDto>(`/apps/${params.id}`),
			api.get<ListResponse<AppEnvDto>>(`/apps/${params.id}/envs`),
			api.get<ListResponse<AppSecretDto>>(`/apps/${params.id}/secrets`),
			api.get<ListResponse<AppVarDto>>(`/apps/${params.id}/vars`),
			api.get<CursorList<RunDto>>(`/runs${qs({ app: params.id, limit: 10 })}`),
			api.get<DeploymentNamespaceListResponse>('/namespaces'),
		])
		return { app, envs: envs.items, secrets: secrets.items, vars: vars.items, runs: runs.items, namespaces: namespaces.items }
	})
	.route('/apps/:id')
	.render(({ data, invalidate }) => {
		const { app, envs, secrets, vars, runs, namespaces } = data
		const [confirming, setConfirming] = useState(false)
		const navigate = useNavigate()

		async function deleteApp() {
			await api.del(`/apps/${app.id}`)
			navigate('apps')
		}

		return (
			<>
				<div className="page-head">
					<Link to="apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						All applications
					</Link>
					<h1>{app.id}</h1>
					<div className="subtitle">
						<code>{app.repoUrl}</code>
						<span className="dot-sep">
							default branch <code>{app.defaultBranch}</code>
						</span>
						<span className="dot-sep">created {fmtDate(app.createdAt)}</span>
					</div>
				</div>

				<section>
					<div className="section-head">
						<Icon name="bolt" size={15} />
						<h2>Build config</h2>
					</div>
					<div className="detail-grid">
						<Field label="Worker dir" value={app.workerDir} mono />
						<Field label="Build command" value={app.buildCmd} mono />
						<InstallationIdField app={app} onDone={invalidate} />
					</div>
				</section>

				<section>
					<div className="section-head">
						<Icon name="bay" size={15} />
						<h2>Environments</h2>
					</div>
					<Table
						colSpan={6}
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
								<th>Trigger ref</th>
								<th>Placement</th>
								<th>Provider config</th>
								<th />
							</tr>
						}
					>
						{envs.map((env) => <EnvRow key={env.env} appId={app.id} env={env} namespaces={namespaces} onDone={invalidate} />)}
					</Table>
					<AddEnvForm appId={app.id} existing={envs} onDone={invalidate} />
				</section>

				<section>
					<div className="section-head">
						<Icon name="lock" size={15} />
						<h2>Secrets</h2>
					</div>
					<p className="section-note">
						Secret <strong>references</strong> deployed with this app. The <code>*</code>{' '}
						layer applies to every env; an env-specific entry overrides it. Values live in the vault — only names and refs are shown.
					</p>
					<Table
						colSpan={4}
						isEmpty={secrets.length === 0}
						empty={<EmptyState icon="lock" title="No secrets referenced" body="Add a reference to pull a vault value into every deploy of this app." />}
						head={
							<tr>
								<th>Name</th>
								<th>Layer</th>
								<th className="grow">Value ref</th>
								<th />
							</tr>
						}
					>
						{secrets.map((secret) => <SecretRow key={`${secret.env ?? '*'}/${secret.name}`} appId={app.id} secret={secret} onDone={invalidate} />)}
					</Table>
					<AddSecretForm appId={app.id} envs={envs} onDone={invalidate} />
				</section>

				<section>
					<div className="section-head">
						<Icon name="schema" size={15} />
						<h2>Vars</h2>
					</div>
					<p className="section-note">
						Non-secret config <strong>vars</strong> deployed with this app. The <code>*</code>{' '}
						layer applies to every env; an env-specific entry overrides it. Vars are plaintext — values are shown.
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
						{vars.map((v) => <VarRow key={`${v.env ?? '*'}/${v.name}`} appId={app.id} appVar={v} onDone={invalidate} />)}
					</Table>
					<AddVarForm appId={app.id} envs={envs} onDone={invalidate} />
				</section>

				<section>
					<div className="section-head">
						<Icon name="runs" size={15} />
						<h2>Recent runs</h2>
						<span className="spacer" />
						<Link to="runs" className="card-link">
							All runs
							<Icon name="chevron-right" size={13} />
						</Link>
					</div>
					<Table
						colSpan={5}
						isEmpty={runs.length === 0}
						empty={<EmptyState icon="runs" title="No runs for this app yet" body="Deploy an environment above, or push to its trigger ref." />}
						head={
							<tr>
								<th>Status</th>
								<th>Env</th>
								<th className="grow">Ref</th>
								<th>Commit</th>
								<th>Started</th>
							</tr>
						}
					>
						{runs.map((run) => (
							<tr key={run.id}>
								<td>
									<Link to="runs/detail" params={{ id: run.id }}>
										<RunStatus status={run.status} />
									</Link>
								</td>
								<td>{run.env}</td>
								<td>
									<code>{shortRef(run.ref)}</code>
								</td>
								<td>
									<code>{shortSha(run.commitSha)}</code>
								</td>
								<td className="muted small nowrap" title={fmtDate(run.createdAt)}>{fmtAgo(run.createdAt)}</td>
							</tr>
						))}
					</Table>
				</section>

				{
					/* Past everything you might have come here to do — not in the page head, where every other
				    screen puts its constructive CTA. */
				}
				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Delete this app</strong>
						Removes its environments and secret references. Run history is kept.
					</div>
					<span className="spacer" />
					<button type="button" className="danger" onClick={() => setConfirming(true)}>
						<Icon name="trash" size={14} />
						Delete app
					</button>
				</div>
				{confirming && (
					<ConfirmDialog
						title="Delete app"
						confirmLabel="Delete app"
						body={
							<p>
								Delete app <strong>{app.id}</strong> and all its environments and secrets? Run history is kept.
							</p>
						}
						onConfirm={deleteApp}
						onClose={() => setConfirming(false)}
					/>
				)}
			</>
		)
	})

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
	return (
		<div>
			<h4>{label}</h4>
			{value === null ? <span className="muted">—</span> : mono ? <code>{value}</code> : value}
		</div>
	)
}

/**
 * The GitHub installation id, editable in place: "Detect" auto-resolves it from the installed GitHub App
 * (server-side, by repo URL), "Edit" sets it manually. Needed to clone a private repo — a null here makes
 * fabrika treat the app as public and the clone fails.
 */
function InstallationIdField({ app, onDone }: { app: AppDto; onDone: () => void }) {
	const [editing, setEditing] = useState(false)
	const [value, setValue] = useState(app.githubInstallationId === null ? '' : String(app.githubInstallationId))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function patch(body: { githubInstallationId: number } | { resolveInstallationId: true }) {
		setBusy(true)
		setError(null)
		try {
			await api.patch(`/apps/${app.id}`, body)
			setEditing(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<div>
			<h4>GitHub installation id</h4>
			{editing
				? (
					<div className="row-actions">
						<input
							type="number"
							min="1"
							aria-label="GitHub installation id"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="12345678"
						/>
						<button
							type="button"
							className="primary small"
							disabled={busy || value.trim() === ''}
							onClick={() => patch({ githubInstallationId: Number(value.trim()) })}
						>
							{busy ? 'Saving…' : 'Save'}
						</button>
						<button type="button" className="small" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
					</div>
				)
				: (
					<div className="row-actions">
						{app.githubInstallationId === null ? <span className="muted">—</span> : <code>{String(app.githubInstallationId)}</code>}
						<button type="button" className="small" disabled={busy} onClick={() => patch({ resolveInstallationId: true })}>
							{busy ? 'Detecting…' : 'Detect'}
						</button>
						<button type="button" className="small" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
					</div>
				)}
			{error && <div className="error-text small">{error}</div>}
		</div>
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
			const run = await api.post<RunDto>('/deploy', body)
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
		await api.del(`/apps/${appId}/envs/${env.env}`)
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
			await api.put(`/apps/${appId}/envs/${environment.env}`, body)
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
				triggerRef: triggerRef.trim() === '' ? null : triggerRef.trim(),
				namespaceId: initial?.namespaceId ?? null,
				target: initial?.target ?? { provider: 'cloudflare', version: 1, payload: {} },
				artifact: initial === null
					? { provider: 'cloudflare', version: 1, payload: { configPath: configPath.trim() } }
					: initialConfigPath === null
					? initial.artifact
					: cloudflareArtifactWithConfigPath(initial.artifact, configPath.trim()),
			}
			await api.put(`/apps/${appId}/envs/${envName.trim()}`, body)
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

function SecretRow({ appId, secret, onDone }: { appId: string; secret: AppSecretDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [settingValue, setSettingValue] = useState(false)
	/** The value lives in the vault when the ref has the `vault:` prefix; PATCH rotates it in place. */
	const inVault = secret.valueRef.startsWith('vault:')

	async function remove() {
		await api.del(`/apps/${appId}/secrets/${secret.name}${qs({ env: secret.env })}`)
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
				<code>{secret.valueRef}</code>
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

/**
 * Inline write-only setter for an app secret's VALUE. PUT (set) stores a fresh vault entry and upserts
 * the `vault:<id>` ref onto the (app, env, name) row; PATCH (rotate) re-encrypts the existing entry.
 * The value is sent once and never read back — the field clears on success. `env` rides the body.
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
			const path = `/apps/${appId}/secrets/${secret.name}/value`
			// PUT sets a new vault entry; PATCH rotates the value behind the existing vault ref.
			await (rotate ? api.patch(path, body) : api.put(path, body))
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

/** How a freshly-added secret gets its value: as a raw vault value, or as a reference. */
type AddSecretMode = 'vault' | 'ref'

function AddSecretForm({ appId, envs, onDone }: { appId: string; envs: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)
	/** Default to entering a raw value stored in the vault; 'ref' registers a reference instead. */
	const [mode, setMode] = useState<AddSecretMode>('vault')
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	const [valueRef, setValueRef] = useState('')
	/** '' = the all-env (*) layer; otherwise an env name. */
	const [env, setEnv] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function reset() {
		setName('')
		setValue('')
		setValueRef('')
		setEnv('')
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const layer = env === '' ? null : env
			if (mode === 'vault') {
				// Stores the value encrypted in the vault and creates/upserts the `vault:<id>` row.
				const body: SetSecretValueRequest = { value, env: layer }
				await api.put(`/apps/${appId}/secrets/${name.trim()}/value`, body)
			} else {
				const body: PutAppSecretRequest = { name: name.trim(), valueRef: valueRef.trim(), env: layer }
				await api.put(`/apps/${appId}/secrets`, body)
			}
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
				Source
				<select value={mode} onChange={(e) => setMode(e.target.value === 'ref' ? 'ref' : 'vault')}>
					<option value="vault">Vault value</option>
					<option value="ref">Reference</option>
				</select>
			</label>
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
			{mode === 'vault'
				? (
					<label>
						Value
						<input type="password" required value={value} onChange={(e) => setValue(e.target.value)} placeholder="Secret value" autoComplete="off" />
						<span className="hint">Stored encrypted in the vault. Never shown again.</span>
					</label>
				)
				: (
					<label>
						Value ref
						<input required value={valueRef} onChange={(e) => setValueRef(e.target.value)} placeholder="env:STRIPE_KEY" autoComplete="off" />
					</label>
				)}
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add secret'}</button>
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</form>
	)
}

function VarRow({ appId, appVar, onDone }: { appId: string; appVar: AppVarDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		await api.del(`/apps/${appId}/vars/${appVar.name}${qs({ env: appVar.env })}`)
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
			await api.put(`/apps/${appId}/vars`, body)
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
