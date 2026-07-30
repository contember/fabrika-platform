import { createPage, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { api, ApiError, type DeploymentNamespaceListResponse, type JsonValue, type RegisterAppRequest, type RegisterAppResponse } from '../lib/api'

// Onboarding — the headline UX. "Paste a GitHub repo URL + domain, pick an env" creates the app and
// its first env in one `register-app` call. The built manifest is provider-owned input; control
// reserves its service names, provisions them codeless, and persists the discovered target id.

export default createPage()
	.loader(async () => ({ namespaces: await api.get<DeploymentNamespaceListResponse>('/namespaces') }))
	.route('/')
	.render(({ data }) => {
		const navigate = useNavigate()

		const [id, setId] = useState('')
		const [repoUrl, setRepoUrl] = useState('')
		const [env, setEnv] = useState('prod')
		const [domain, setDomain] = useState('')
		const [triggerRef, setTriggerRef] = useState('')
		const [namespaceId, setNamespaceId] = useState('')
		const [manifest, setManifest] = useState('')
		const [installationId, setInstallationId] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			let manifestPayload: JsonValue
			try {
				const parsed: unknown = JSON.parse(manifest)
				if (!isJsonValue(parsed)) {
					throw new Error('manifest is not JSON')
				}
				manifestPayload = parsed
			} catch {
				setError('Paste a valid fabrika.manifest.json.')
				return
			}
			const installTrimmed = installationId.trim()
			// Blank → auto-detect from the installed GitHub App; a number → set it manually.
			const installField = installTrimmed === ''
				? { resolveInstallationId: true }
				: { githubInstallationId: Number(installTrimmed) }
			const body: RegisterAppRequest = {
				id: id.trim(),
				repoUrl: repoUrl.trim(),
				env: env.trim(),
				...(domain.trim() === '' ? {} : { domain: domain.trim() }),
				...(triggerRef.trim() === '' ? {} : { triggerRef: triggerRef.trim() }),
				namespaceId,
				target: { provider: 'zerops', version: 2, payload: {} },
				artifact: { provider: 'zerops', version: 2, payload: manifestPayload },
				...installField,
			}
			setBusy(true)
			try {
				const result = await api.post<RegisterAppResponse>('/register-app', body)
				navigate('apps/detail', { params: { id: result.app.id } })
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Onboarding failed.')
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<h1>Onboard an app</h1>
					<p className="hint">
						Register a built Zerops manifest in a ready deployment namespace. Fabrika reserves the service names before it creates provider resources.
					</p>
				</div>

				<form className="panel form" onSubmit={submit}>
					<label>
						App id
						<input
							required
							value={id}
							onChange={(e) => setId(e.target.value)}
							placeholder="acme-storefront"
							autoComplete="off"
						/>
						<span className="hint">Stable identifier for this app across environments. Lowercase, no spaces.</span>
					</label>
					<label>
						GitHub repo URL
						<input
							required
							value={repoUrl}
							onChange={(e) => setRepoUrl(e.target.value)}
							placeholder="https://github.com/acme/storefront"
							autoComplete="off"
						/>
						<span className="hint">Normalized server-side so webhook pushes match. The GitHub App must be installed on it.</span>
					</label>
					<label>
						Environment
						<input
							required
							value={env}
							onChange={(e) => setEnv(e.target.value)}
							placeholder="prod"
							autoComplete="off"
						/>
					</label>
					<label>
						Domain (optional)
						<input
							value={domain}
							onChange={(e) => setDomain(e.target.value)}
							placeholder="store.acme.com"
							autoComplete="off"
						/>
						<span className="hint">
							Public domain for this environment, passed to the deploy as <code>VOZKA_DOMAIN</code>.
						</span>
					</label>
					<label>
						Trigger ref (optional)
						<input
							value={triggerRef}
							onChange={(e) => setTriggerRef(e.target.value)}
							placeholder="refs/heads/main"
							autoComplete="off"
						/>
						<span className="hint">Push to this git ref auto-deploys this env. Leave empty for manual-only (Deploy button).</span>
					</label>
					<label>
						Deployment namespace
						<select
							required
							value={namespaceId}
							onChange={(e) => setNamespaceId(e.target.value)}
						>
							<option value="">Select a ready namespace</option>
							{data.namespaces.items
								.filter((namespace) => namespace.state === 'ready' && namespace.env === env)
								.map((namespace) => <option key={namespace.id} value={namespace.id}>{namespace.id}</option>)}
						</select>
					</label>
					<label>
						Built Fabrika manifest
						<textarea
							required
							rows={12}
							value={manifest}
							onChange={(e) => setManifest(e.target.value)}
							placeholder='{ "manifestVersion": 2, "app": { ... }, "target": { ... } }'
							autoComplete="off"
						/>
						<span className="hint">
							Generate it in the app repository with <code>fabrika-zerops build --env={env || 'prod'}</code>.
						</span>
					</label>
					<label>
						GitHub installation id (optional)
						<input
							type="number"
							min="1"
							value={installationId}
							onChange={(e) => setInstallationId(e.target.value)}
							placeholder="auto-detect"
							autoComplete="off"
						/>
						<span className="hint">
							Needed to clone a <strong>private</strong> repo. Leave blank to auto-detect from the installed GitHub App; set a number to override.
						</span>
					</label>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>
							{busy ? 'Onboarding…' : 'Register app'}
						</button>
					</div>
				</form>
			</>
		)
	})

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return true
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue)
	}
	if (typeof value !== 'object') {
		return false
	}
	return Object.values(value).every((entry) => entry !== undefined && isJsonValue(entry))
}
