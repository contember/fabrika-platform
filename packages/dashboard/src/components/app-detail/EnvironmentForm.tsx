import { useEffect, useId, useRef, useState } from 'react'
import { api, ApiError, type AppEnvDto, type DeploymentNamespaceDto, type PutAppEnvRequest } from '../../lib/api'
import { editableTriggerRef } from '../../lib/format'
import { cloudflareArtifactWithConfigPath, cloudflareConfigPath } from '../../lib/manifest-editor'
import { compatibleNamespaces } from '../../lib/namespaces'
import { type FormProvider, type ProviderRegistrationPayload, providerRegistrationPayload } from '../../lib/provider-registration'

/** A single editor for the environment's addresses, cross-origin pages and deployment settings. */
export function EnvironmentForm(
	{ appId, initial, existing, provider, namespaces, onDone, onCancel, onDelete }: {
		appId: string
		initial: AppEnvDto | null
		existing: AppEnvDto[]
		/** New environments use the installation's provider; edits preserve their stored envelopes. */
		provider: FormProvider | null
		namespaces: DeploymentNamespaceDto[]
		onDone: () => void
		onCancel: () => void
		onDelete?: () => void
	},
) {
	const id = useId()
	const firstInput = useRef<HTMLInputElement>(null)
	const [envName, setEnvName] = useState(initial?.env ?? (existing.length === 0 ? 'prod' : ''))
	const [domain, setDomain] = useState(initial?.domain ?? '')
	const [publicOrigin, setPublicOrigin] = useState(initial?.publicOrigin ?? '')
	const [crossOrigins, setCrossOrigins] = useState(initial?.crossOrigins.join('\n') ?? '')
	const [triggerRef, setTriggerRef] = useState(editableTriggerRef(initial?.triggerRef ?? ''))
	const initialConfigPath = initial === null ? 'fabrika.config.ts' : cloudflareConfigPath(initial.artifact)
	const [configPath, setConfigPath] = useState(initialConfigPath ?? '')
	const [manifest, setManifest] = useState('')
	const [namespaceId, setNamespaceId] = useState(initial?.namespaceId ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const addingZerops = initial === null && provider === 'zerops'
	const ready = compatibleNamespaces(appId, { env: envName.trim(), provider: initial?.provider ?? provider ?? '' }, namespaces)
	const currentPlacementMissing = initial?.namespaceId != null && !ready.some((namespace) => namespace.id === initial.namespaceId)
	const duplicateName = initial === null && existing.some((environment) => environment.env === envName.trim())
	const providerFieldsMissing = addingZerops
		? manifest.trim() === '' || !ready.some((namespace) => namespace.id === namespaceId)
		: initialConfigPath !== null && configPath.trim() === ''
	const cannotSave = busy || envName.trim() === '' || duplicateName || providerFieldsMissing

	useEffect(() => firstInput.current?.focus(), [])

	function placement(): ProviderRegistrationPayload | null {
		if (initial !== null) {
			return {
				namespaceId: namespaceId === '' ? null : namespaceId,
				target: initial.target,
				artifact: initialConfigPath === null ? initial.artifact : cloudflareArtifactWithConfigPath(initial.artifact, configPath.trim()),
			}
		}
		return provider === null ? null : providerRegistrationPayload(provider, { configPath, manifest, namespaceId })
	}

	async function save() {
		if (cannotSave) return
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
				crossOrigins: crossOrigins.split(/\r?\n/).map((origin) => origin.trim()).filter((origin) => origin !== ''),
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
		<form
			className="form environment-form"
			aria-label={initial === null ? 'New environment' : `Edit ${initial.env} environment`}
			aria-busy={busy}
			onSubmit={(event) => {
				event.preventDefault()
				void save()
			}}
		>
			<fieldset className="environment-fields" disabled={busy}>
				{initial === null && (
					<div className="environment-name-field">
						<label htmlFor={`${id}-name`}>Environment name</label>
						<input
							ref={firstInput}
							id={`${id}-name`}
							value={envName}
							onChange={(event) => {
								setEnvName(event.target.value)
								setNamespaceId('')
							}}
							placeholder="stage"
							required
							aria-invalid={duplicateName}
							aria-describedby={`${id}-name-hint`}
						/>
						<p className={duplicateName ? 'error-text small' : 'hint'} id={`${id}-name-hint`}>
							{duplicateName
								? 'This environment already exists. Choose another name.'
								: 'Identifies the deployment target, for example prod or stage. It cannot be renamed later.'}
						</p>
					</div>
				)}
				<div className="environment-form-grid">
					<div className="environment-field-group">
						<h4>Application address</h4>
						<div>
							<label htmlFor={`${id}-domain`}>Routing domain</label>
							<input
								ref={initial === null ? undefined : firstInput}
								id={`${id}-domain`}
								value={domain}
								onChange={(event) => setDomain(event.target.value)}
								placeholder="app.example.com"
								aria-describedby={`${id}-domain-hint`}
							/>
							<p className="hint" id={`${id}-domain-hint`}>The hostname the proxy routes to this app. No https://, port or path.</p>
						</div>
						<div>
							<label htmlFor={`${id}-origin`}>Public URL</label>
							<input
								type="url"
								id={`${id}-origin`}
								value={publicOrigin}
								onChange={(event) => setPublicOrigin(event.target.value)}
								placeholder={domain.trim() === '' ? 'https://app.example.com' : `https://${domain.trim()}`}
								aria-describedby={`${id}-origin-hint`}
							/>
							<p className="hint" id={`${id}-origin-hint`}>
								The browser-facing address used for sign-in redirects, app links and health checks. Include http:// or https://, with no path.
							</p>
						</div>
					</div>
					<div className="environment-field-group">
						<h4>Requests from other websites</h4>
						<div>
							<label htmlFor={`${id}-cross-origins`}>
								Cross-origin pages <span className="environment-field-meta">Optional</span>
							</label>
							<textarea
								id={`${id}-cross-origins`}
								rows={4}
								value={crossOrigins}
								onChange={(event) => setCrossOrigins(event.target.value)}
								placeholder={'https://www.example.com\nhttp://localhost:5173'}
								spellCheck={false}
								aria-describedby={`${id}-cross-origins-purpose ${id}-cross-origins-hint`}
							/>
							<p className="hint" id={`${id}-cross-origins-purpose`}>
								Websites whose pages may call API endpoints that the app explicitly opens to this list.
							</p>
							<p className="hint" id={`${id}-cross-origins-hint`}>
								One origin per line, up to 16. Include https:// (http:// for local development), with no path or wildcard. Do not list this app's own domain.
								Leave empty for no listed websites.
							</p>
						</div>
					</div>
				</div>
				<div className="environment-field-group environment-deployment-fields">
					<h4>Deployment</h4>
					<div className="environment-form-grid">
						<div>
							<label htmlFor={`${id}-trigger`}>
								Auto-deploy from <span className="environment-field-meta">Optional</span>
							</label>
							<input
								id={`${id}-trigger`}
								value={triggerRef}
								onChange={(event) => setTriggerRef(event.target.value)}
								placeholder="deploy/prod"
								aria-describedby={`${id}-trigger-hint`}
							/>
							<p className="hint" id={`${id}-trigger-hint`}>
								A Git branch, such as deploy/prod, or a tag ref, such as refs/tags/v*. New commits or matching tags trigger a deploy. Leave empty for manual
								deploys only.
							</p>
						</div>
						{(initial !== null || addingZerops) && (
							<div>
								<label htmlFor={`${id}-placement`}>Placement</label>
								<select
									id={`${id}-placement`}
									required={addingZerops}
									value={namespaceId}
									onChange={(event) => setNamespaceId(event.target.value)}
									aria-describedby={`${id}-placement-hint`}
								>
									{(initial === null || initial.namespaceId === null) && <option value="">{addingZerops ? 'Select a ready placement' : 'Unassigned'}</option>}
									{currentPlacementMissing && initial?.namespaceId != null && <option value={initial.namespaceId}>{initial.namespaceId} (current)</option>}
									{ready.map((namespace) => (
										<option key={namespace.id} value={namespace.id}>{namespace.id}{namespace.exclusiveAppId === null ? '' : ' (exclusive)'}</option>
									))}
								</select>
								<p className="hint" id={`${id}-placement-hint`}>
									{ready.length === 0 && namespaceId === ''
										? 'No ready placement matches this environment name and provider.'
										: 'The infrastructure that runs this environment.'}
									{initial !== null && ' Can only change before the first successful deploy, with no deploy in progress.'}
								</p>
							</div>
						)}
					</div>
					{addingZerops
						? (
							<div>
								<label htmlFor={`${id}-manifest`}>Built Fabrika manifest</label>
								<textarea
									id={`${id}-manifest`}
									required
									rows={4}
									value={manifest}
									onChange={(event) => setManifest(event.target.value)}
									placeholder='{ "manifestVersion": 3, … }'
									spellCheck={false}
									aria-describedby={`${id}-manifest-hint`}
								/>
								<p className="hint" id={`${id}-manifest-hint`}>
									Paste the contents of fabrika.manifest.json from the app's build. It describes the services and resources to register on Zerops.
								</p>
							</div>
						)
						: initial !== null && initialConfigPath === null
						? (
							<p className="hint">
								Provider configuration: {initial.provider}, artifact version {initial.artifact.version}. Managed by the app's deployment manifest.
							</p>
						)
						: (
							<div>
								<label htmlFor={`${id}-config`}>Config path</label>
								<input
									id={`${id}-config`}
									required
									value={configPath}
									onChange={(event) => setConfigPath(event.target.value)}
									placeholder="fabrika.config.ts"
									aria-describedby={`${id}-config-hint`}
								/>
								<p className="hint" id={`${id}-config-hint`}>
									The Fabrika configuration file used to deploy this environment, relative to the app's working directory.
								</p>
							</div>
						)}
				</div>
			</fieldset>
			{error && <p className="error-text environment-form-error" role="alert">{error}</p>}
			<div className="environment-form-actions">
				{onDelete && <button type="button" className="danger" disabled={busy} onClick={onDelete}>Delete environment</button>}
				<div className="environment-actions">
					<button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
					<button type="submit" className="primary" disabled={cannotSave}>
						{busy ? 'Saving…' : initial === null ? 'Create environment' : 'Save changes'}
					</button>
				</div>
			</div>
		</form>
	)
}
