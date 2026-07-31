import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { api, ApiError, type JsonValue, type RegisterAppRequest } from '../../lib/api'

// Onboarding. "Paste a GitHub repo URL + domain, pick an env" creates the app and its first env in one
// `register-app` call. The built manifest is provider-owned input; control reserves its service names,
// provisions them codeless, and persists the discovered target id.
//
// This used to be the console's landing page. It is a form, not a report — the overview earns that slot
// now, and this is the step you take from it.

export default createPage()
	.loader(async () => ({ namespaces: await api.namespaces.list() }))
	.route('/apps/new')
	.render(({ data }) => {
		const navigate = useNavigate()

		const [id, setId] = useState('')
		const [repoUrl, setRepoUrl] = useState('')
		const [env, setEnv] = useState('prod')
		const [domain, setDomain] = useState('')
		const [publicOrigin, setPublicOrigin] = useState('')
		const [triggerRef, setTriggerRef] = useState('')
		const [namespaceId, setNamespaceId] = useState('')
		const [manifest, setManifest] = useState('')
		const [installationId, setInstallationId] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		const ready = data.namespaces.items.filter((namespace) => namespace.state === 'ready' && namespace.env === env)

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
				...(publicOrigin.trim() === '' ? {} : { publicOrigin: publicOrigin.trim() }),
				...(triggerRef.trim() === '' ? {} : { triggerRef: triggerRef.trim() }),
				namespaceId,
				target: { provider: 'zerops', version: 2, payload: {} },
				artifact: { provider: 'zerops', version: 2, payload: manifestPayload },
				...installField,
			}
			setBusy(true)
			try {
				const result = await api.register(body)
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
					<Link to="apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						All applications
					</Link>
					<h1>Onboard an app</h1>
					<p className="hint">
						Register a built manifest into a ready deployment namespace. fabrika reserves the service names before it creates any provider resource.
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
					<div className="form-row">
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
						</label>
					</div>
					<label>
						Public origin (optional)
						<input
							type="url"
							value={publicOrigin}
							onChange={(e) => setPublicOrigin(e.target.value)}
							placeholder="https://store.acme.com"
							autoComplete="off"
						/>
						<span className="hint">Exact externally reachable HTTP(S) origin used by operations monitoring. It can differ from the provider domain.</span>
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
							{ready.map((namespace) => <option key={namespace.id} value={namespace.id}>{namespace.id}</option>)}
						</select>
						{ready.length === 0 && (
							<span className="hint">
								No ready namespace for <code>{env || 'this env'}</code> yet — <Link to="namespaces/create">provision one</Link> first.
							</span>
						)}
					</label>
					<label>
						Built fabrika manifest
						<textarea
							required
							rows={10}
							value={manifest}
							onChange={(e) => setManifest(e.target.value)}
							placeholder='{ "manifestVersion": 2, "app": { … }, "target": { … } }'
							autoComplete="off"
							spellCheck={false}
						/>
						<span className="hint">
							Generate it in the app repository with <code>fabrika app build --env={env || 'prod'}</code>.
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
						<Link to="apps" className="btn">Cancel</Link>
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
