import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { api, ApiError, type RegisterAppRequest } from '../../lib/api'
import { formProvider, type ProviderRegistrationPayload, providerRegistrationPayload } from '../../lib/provider-registration'

// Onboarding. "Paste a GitHub repo URL + domain, pick an env" creates the app and its first env in one
// `register-app` call. The provider input follows the installation: Cloudflare takes the app's config
// path; Zerops takes a built manifest, whose service names control reserves in a ready namespace.
//
// This used to be the console's landing page. It is a form, not a report — the overview earns that slot
// now, and this is the step you take from it.

export default createPage()
	.loader(async () => {
		const [installation, namespaces] = await Promise.all([api.installation(), api.namespaces.list()])
		return { installation, namespaces }
	})
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
		const [configPath, setConfigPath] = useState('fabrika.config.ts')
		const [installationId, setInstallationId] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		const provider = formProvider(data.installation.provider)
		const ready = data.namespaces.items.filter((namespace) => namespace.state === 'ready' && namespace.env === env)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			if (provider === null) return
			let registration: ProviderRegistrationPayload
			try {
				registration = providerRegistrationPayload(provider, { configPath, manifest, namespaceId })
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : 'Paste a valid fabrika.manifest.json.')
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
				...registration,
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
						{provider === 'cloudflare'
							? 'Register an app by the path of its fabrika config module in the repository.'
							: 'Register a built manifest into a ready deployment namespace. fabrika reserves the service names before it creates any provider resource.'}
					</p>
				</div>

				{provider === null && (
					<p className="error-text" role="alert">
						This console has no onboarding form for provider <code>{data.installation.provider}</code>.
					</p>
				)}
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
					{provider === 'cloudflare' && (
						<label>
							Config path
							<input
								required
								value={configPath}
								onChange={(e) => setConfigPath(e.target.value)}
								placeholder="fabrika.config.ts"
								autoComplete="off"
							/>
							<span className="hint">Path of the app's fabrika config module in the repository.</span>
						</label>
					)}
					{provider === 'zerops' && (
						<>
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
									placeholder='{ "manifestVersion": 3, "app": { … }, "target": { … } }'
									autoComplete="off"
									spellCheck={false}
								/>
								<span className="hint">
									Generate it in the app repository with <code>fabrika app build --env={env || 'prod'}</code>.
								</span>
							</label>
						</>
					)}
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
						<button type="submit" className="primary" disabled={busy || provider === null || (provider === 'cloudflare' && configPath.trim() === '')}>
							{busy ? 'Onboarding…' : 'Register app'}
						</button>
						<Link to="apps" className="btn">Cancel</Link>
					</div>
				</form>
			</>
		)
	})
