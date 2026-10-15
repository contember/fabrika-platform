import { useEffect, useState } from 'react'
import { api, type BuilderConnectionEnvironmentDto, type DeploymentNamespaceDetailDto, type DeploymentNamespaceDto } from '../../lib/api'
import { builderRequestError } from '../../lib/builder-authorization'
import { installationDiscovery } from '../../lib/session'

export function BuilderPlacement({ appId, existingNames, onSelect }: {
	appId: string
	existingNames: string[]
	onSelect: (environment: BuilderConnectionEnvironmentDto) => void
}) {
	const [env, setEnv] = useState('prod')
	const [namespaces, setNamespaces] = useState<DeploymentNamespaceDto[]>([])
	const [provider, setProvider] = useState<string | null>(null)
	const [namespace, setNamespace] = useState<DeploymentNamespaceDetailDto | null>(null)
	const [domain, setDomain] = useState('')
	const [customDomain, setCustomDomain] = useState(false)
	const [publicOrigin, setPublicOrigin] = useState('')
	const [triggerRef, setTriggerRef] = useState('')
	const [busy, setBusy] = useState(true)
	const [error, setError] = useState<string | null>(null)

	async function load() {
		setBusy(true)
		setError(null)
		try {
			const discovery = await installationDiscovery()
			if (!discovery) throw new Error('discovery unavailable')
			setProvider(discovery.provider)
			const result = await api.namespaces.list()
			setNamespaces(result.items)
		} catch (cause) {
			setError(
				`${
					builderRequestError(cause, 'Could not load prepared namespaces or installation details.')
				} New placement requires namespace.manage with the current API. Ask the operator for a ready placement; no broader grants are added here.`,
			)
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => {
		void load()
	}, [])

	const ready = namespaces.filter((item) =>
		item.state === 'ready' && item.env === env && item.provider === provider
		&& (item.exclusiveAppId === null || item.exclusiveAppId === appId)
	)

	async function chooseNamespace(id: string) {
		setNamespace(null)
		setDomain('')
		setCustomDomain(false)
		if (!id) return
		setBusy(true)
		setError(null)
		try {
			const detail = await api.namespaces.get({ namespaceId: id })
			if (
				detail.state !== 'ready' || detail.env !== env || detail.provider !== provider
				|| (detail.exclusiveAppId !== null && detail.exclusiveAppId !== appId)
			) {
				setError('That namespace is no longer compatible. Refresh the prepared placements.')
			} else setNamespace(detail)
		} catch (cause) {
			setError(builderRequestError(cause, 'Could not read the namespace. Check namespace.manage with the operator and retry.'))
		} finally {
			setBusy(false)
		}
	}

	return (
		<form
			className="panel form"
			onSubmit={(event) => {
				event.preventDefault()
				if (!namespace || existingNames.includes(env)) return
				onSelect({
					env,
					namespaceId: namespace.id,
					domain: domain.trim() || null,
					publicOrigin: publicOrigin.trim() || null,
					triggerRef: triggerRef.trim() || null,
				})
			}}
		>
			<h3>New environment intent</h3>
			<p className="hint">
				The operator prepares namespaces, source connections and custom domains. This selection reserves no resources and creates no environment until the
				local builder has code.
			</p>
			<fieldset disabled={busy}>
				<label>
					Environment<input
						required
						pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
						value={env}
						onChange={(event) => {
							setEnv(event.target.value)
							setNamespace(null)
							setDomain('')
						}}
					/>
				</label>
				{existingNames.includes(env) && <p className="error-text">This environment already exists. Select it above to preserve its current placement.</p>}
				<label>
					Prepared namespace<select required value={namespace?.id ?? ''} onChange={(event) => void chooseNamespace(event.target.value)}>
						<option value="">Select a ready namespace</option>
						{ready.map((item) => <option key={item.id} value={item.id}>{item.id} ({item.provider})</option>)}
					</select>
				</label>
				{!busy && !error && ready.length === 0 && (
					<p className="hint">No ready namespace matches this provider, environment and application. Ask the operator to prepare one.</p>
				)}
				<label>
					Namespace host<select
						value={customDomain ? '__custom' : domain}
						onChange={(event) => {
							setCustomDomain(event.target.value === '__custom')
							setDomain(event.target.value === '__custom' ? '' : event.target.value)
						}}
					>
						<option value="">None (null)</option>
						{namespace?.hosts?.filter((host) => !host.takenBy).map((host) => (
							<option key={`${host.host}:${host.port}`} value={host.host}>{host.host} (port {host.port})</option>
						))}
						<option value="__custom">Operator-prepared custom domain</option>
					</select>
				</label>
				{customDomain && (
					<label>
						Prepared custom domain<input required value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="app.example.com" />
						<span className="hint">Already bound by the operator. Pairing does not bind domains.</span>
					</label>
				)}
				<label>
					Public origin (optional)<input
						type="url"
						value={publicOrigin}
						onChange={(event) => setPublicOrigin(event.target.value)}
						placeholder="https://app.example.com"
					/>
					<span className="hint">Separate, explicit externally reachable origin for monitoring and login return URLs. Blank means null.</span>
				</label>
				<label>
					Trigger ref (optional)<input value={triggerRef} onChange={(event) => setTriggerRef(event.target.value)} placeholder="Manual-only by default" />
					<span className="hint">Blank means null: manual deployments only. An explicit ref enables automatic deployment.</span>
				</label>
			</fieldset>
			{busy && <p role="status">Loading prepared placement…</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			<div className="form-actions">
				<button type="submit" disabled={busy || !namespace || existingNames.includes(env)}>Review this placement</button>
				<button type="button" disabled={busy} onClick={() => void load()}>Refresh namespaces</button>
			</div>
		</form>
	)
}
