import { useState } from 'react'
import { api, type AppDto, type AppEnvDto, type BuilderConnectionEnvironmentDto } from '../../lib/api'
import {
	type BuilderCreationAttempt,
	builderRequestError,
	currentBuilderEnvironment,
	isBuilderWriteConflict,
	loadKnownBuilderApp,
	recoverBuilderCreation,
} from '../../lib/builder-authorization'
import { BuilderPlacement } from './BuilderPlacement'

export function BuilderApplicationSelection({ onSelect }: {
	onSelect: (app: AppDto, environment: BuilderConnectionEnvironmentDto) => void
}) {
	const [apps, setApps] = useState<AppDto[] | null>(null)
	const [appId, setAppId] = useState('')
	const [app, setApp] = useState<AppDto | null>(null)
	const [environments, setEnvironments] = useState<AppEnvDto[]>([])
	const [newEnvironment, setNewEnvironment] = useState(false)
	const [creating, setCreating] = useState(false)
	const [creationAttempt, setCreationAttempt] = useState<BuilderCreationAttempt | null>(null)
	const [repoUrl, setRepoUrl] = useState('')
	const [source, setSource] = useState('connection')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)

	async function listApps() {
		setBusy(true)
		setError(null)
		try {
			setApps((await api.apps.list()).items)
		} catch {
			setError(
				'The application list is unavailable or not permitted. You can still enter a known application ID below; no global grant is required for that lookup.',
			)
		} finally {
			setBusy(false)
		}
	}

	async function lookup() {
		setBusy(true)
		setError(null)
		setApp(null)
		try {
			let selection: { app: AppDto; environments: AppEnvDto[] }
			if (creationAttempt) {
				const recovery = await recoverBuilderCreation(api, creationAttempt)
				if (recovery.status === 'absent') {
					setCreationAttempt(null)
					setCreating(true)
					setNotice('The rejected creation left no application with this ID. Correct the repository or source option, then explicitly retry creation.')
					return
				}
				if (recovery.status === 'uncertain') {
					setError(
						'The application is not visible, but the earlier creation outcome is still uncertain. Retry lookup later; creation stays locked to avoid a duplicate request.',
					)
					return
				}
				selection = { app: recovery.app, environments: (await api.apps.environments.list({ appId: recovery.app.id })).items }
			} else {
				selection = await loadKnownBuilderApp(api, appId.trim())
			}
			setApp(selection.app)
			setCreationAttempt(null)
			setEnvironments(selection.environments)
			setNewEnvironment(selection.environments.length === 0)
			setCreating(false)
		} catch (cause) {
			setError(
				builderRequestError(cause, 'Application or environments not found or not accessible. Check the ID and your app-scoped app.manage permission.'),
			)
		} finally {
			setBusy(false)
		}
	}

	async function create() {
		setBusy(true)
		setError(null)
		const attemptedId = appId.trim()
		setCreationAttempt({ appId: attemptedId, rejected: false })
		try {
			const created = await api.apps.create({
				id: attemptedId,
				repoUrl: repoUrl.trim(),
				...(source === 'connection' ? { resolveInstallationId: true } : { githubInstallationId: null }),
			})
			setApp(created)
			setCreationAttempt(null)
			setEnvironments([])
			setNewEnvironment(true)
			setNotice(
				`Application ${created.id} was created. It remains registered if connection approval fails. Select it by ID when resuming; do not create another application.`,
			)
			setCreating(false)
		} catch (cause) {
			setCreationAttempt({ appId: attemptedId, rejected: isBuilderWriteConflict(cause) })
			setError(
				builderRequestError(
					cause,
					'Application creation was not confirmed. It may already exist. Look up the same ID before retrying; this page will not silently recreate or replace it. Check that the repository and source connection already exist.',
				),
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<section aria-labelledby="builder-app-selection">
			<h2 id="builder-app-selection">Select the application</h2>
			{notice && <p role="status">{notice}</p>}
			{!app && (
				<>
					<p className="hint">
						An app-scoped manager can look up an existing application directly. Creating a bare application requires global app.manage.
					</p>
					<button type="button" disabled={busy} onClick={() => void listApps()}>Browse existing applications</button>
					{apps && (
						<label>
							Existing applications<select value={appId} disabled={busy || creationAttempt !== null} onChange={(event) => setAppId(event.target.value)}>
								<option value="">Choose an app</option>
								{apps.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
							</select>
						</label>
					)}
					{apps?.length === 0 && <p className="empty">No applications in the list.</p>}
					<form
						className="panel form"
						onSubmit={(event) => {
							event.preventDefault()
							void (creating && !creationAttempt ? create() : lookup())
						}}
					>
						<label>
							Application ID<input
								required
								pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
								value={appId}
								disabled={busy || creationAttempt !== null}
								onChange={(event) => setAppId(event.target.value)}
								autoComplete="off"
							/>
						</label>
						{creating && !creationAttempt && (
							<>
								<label>
									Existing repository URL<input
										required
										type="url"
										value={repoUrl}
										disabled={busy}
										onChange={(event) => setRepoUrl(event.target.value)}
										placeholder="https://github.com/organization/repository"
									/>
								</label>
								<label>
									Repository access<select value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}>
										<option value="connection">Resolve existing GitHub source connection</option>
										<option value="public">Public repository (no GitHub credentials)</option>
									</select>
								</label>
								<p className="hint">
									The server derives source coordinates from the existing repository organization. This page does not create repositories or configure GitHub.
								</p>
							</>
						)}
						<div className="form-actions">
							<button type="submit" disabled={busy}>
								{busy ? 'Working…' : creating && !creationAttempt ? 'Create bare application' : 'Look up application'}
							</button>
							{!creationAttempt && (
								<button type="button" disabled={busy} onClick={() => setCreating(!creating)}>
									{creating ? 'Use existing application' : 'Create a bare application instead'}
								</button>
							)}
						</div>
					</form>
				</>
			)}
			{error && <p className="error-text" role="alert">{error}</p>}
			{app && (
				<>
					<h3>{app.id}</h3>
					<p>
						<code>{app.repoUrl}</code>
					</p>
					<p className="hint">Source connection: {app.githubConnectionId ?? 'none'} · GitHub installation: {app.githubInstallationId ?? 'none'}</p>
					{environments.length > 0 && (
						<label>
							Existing environment<select
								value=""
								onChange={(event) => {
									const selected = environments.find((item) => item.env === event.target.value)
									if (selected) onSelect(app, currentBuilderEnvironment(selected))
								}}
							>
								<option value="">Select and review current placement</option>
								{environments.map((item) => <option key={item.env} value={item.env}>{item.env}</option>)}
							</select>
						</label>
					)}
					{environments.length === 0 && <p className="hint">This application has no environments yet.</p>}
					{!newEnvironment && <button type="button" onClick={() => setNewEnvironment(true)}>Select a new environment</button>}
					{newEnvironment && (
						<BuilderPlacement
							appId={app.id}
							existingNames={environments.map((item) => item.env)}
							onSelect={(environment) => onSelect(app, environment)}
						/>
					)}
					<button
						type="button"
						onClick={() => {
							setApp(null)
							setError(null)
						}}
					>
						Look up a different application
					</button>
				</>
			)}
		</section>
	)
}
