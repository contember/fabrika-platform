import { createPage } from '@buzola/router'
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { type Lamp, Status } from '../../components/Status'
import { api, ApiError, type GitHubSourceConnectionAppDto, type GitHubSourceConnectionStatusDto } from '../../lib/api'
import {
	MAX_SOURCE_APP_NAME_LENGTH,
	MAX_SOURCE_ORGANIZATION_LENGTH,
	MAX_SOURCE_REPOSITORIES_TEXT_LENGTH,
	parseSourceRepositories,
	scheduleSourceConnectionPoll,
	sourceChain,
	sourceManifestContinuePath,
} from '../../lib/source-connection'

export default createPage()
	.loader(async () => ({ status: await api.sourceConnection.status() }))
	.route('/settings/source')
	.render(({ data, invalidate }) => {
		useEffect(() => {
			return scheduleSourceConnectionPoll(data.status, invalidate, (callback, delayMs) => {
				const timer = window.setTimeout(callback, delayMs)
				return () => window.clearTimeout(timer)
			})
		}, [data.status, invalidate])

		return (
			<>
				<div className="page-head">
					<p className="eyebrow">Delivery checkpoint</p>
					<h1>Source connection</h1>
					<p className="hint">Give the private source service read-only GitHub authority without placing App credentials in this browser.</p>
				</div>
				<ConnectionChain status={data.status} />
				<SourceAction status={data.status} invalidate={invalidate} />
			</>
		)
	})

function ConnectionChain({ status }: { status: GitHubSourceConnectionStatusDto }) {
	return (
		<section className="source-chain" aria-label="Source connection path">
			{sourceChain(status).map((node, index) => (
				<div className="source-chain-segment" key={node.label}>
					<div className="source-chain-node">
						<Status lamp={node.lamp}>{node.label}</Status>
						<span>{node.detail}</span>
					</div>
					{index < 2 && (
						<span className="source-chain-link" aria-hidden="true">
							<Icon name="arrow-right" size={15} />
						</span>
					)}
				</div>
			))}
		</section>
	)
}

function SourceAction({ status, invalidate }: { status: GitHubSourceConnectionStatusDto; invalidate: () => void }) {
	if (status.state === 'anonymous') return <ConnectionForm />
	if (status.state === 'unavailable') {
		return (
			<section className="source-checkpoint">
				<CheckpointHead lamp="idle" title="UI connection unavailable" />
				<p>This provider or installation setup does not expose source connection management in the console. Use its supported operator setup path.</p>
			</section>
		)
	}
	if (status.state === 'adoption-required') {
		return (
			<section className="source-checkpoint">
				<CheckpointHead lamp="run" title="Adopt the existing GitHub App" />
				<p>
					Fabrika found App credentials already stored on the private source. Adopt them into this connection and move webhook verification into the
					Control vault. No new App or personal access token is needed.
				</p>
				<ConnectionMutation
					primary
					label="Adopt existing GitHub App"
					pending="Adopting…"
					action={() => api.sourceConnection.adoptExisting()}
					onDone={invalidate}
				/>
			</section>
		)
	}
	if (status.state === 'setup-pending') {
		const continuePath = sourceManifestContinuePath(status)
		return (
			<section className="source-checkpoint" aria-live="polite">
				<CheckpointHead lamp="run" title="Setup is in progress" />
				<p>{phaseCopy(status.phase)}</p>
				<div className="source-checkpoint-meta">
					<code>{status.connectionId}</code>
					<span>Refreshes automatically</span>
				</div>
				<div className="form-actions">
					{continuePath !== null && <a className="btn primary" href={continuePath}>Continue to GitHub</a>}
					<button type="button" onClick={invalidate}>
						<Icon name="refresh" size={14} /> Refresh now
					</button>
				</div>
			</section>
		)
	}
	if (status.state === 'installation-required') {
		return (
			<section className="source-checkpoint">
				<CheckpointHead lamp="run" title="Install the verified GitHub App" />
				<p>The App is active on the private source. Grant it access in GitHub, then verify the installation here.</p>
				<AppFacts app={status.app} />
				<div className="form-actions">
					<a className="btn primary" href={status.installationUrl} target="_blank" rel="noreferrer">
						Open GitHub installation <Icon name="external" size={14} />
					</a>
					<ConnectionMutation
						label="Verify installation"
						pending="Verifying…"
						action={() => api.sourceConnection.verifyInstallation({ connectionId: status.connectionId })}
						onDone={invalidate}
					/>
				</div>
			</section>
		)
	}
	if (status.state === 'repair-required') {
		return (
			<section className="source-checkpoint source-checkpoint-failed">
				<CheckpointHead lamp="stop" title="Connection repair required" />
				<p>{repairCopy(status.reason)}</p>
				{status.app !== undefined && <AppFacts app={status.app} />}
				<ConnectionMutation
					primary
					label="Repair connection"
					pending="Repairing…"
					action={() => api.sourceConnection.repair({ connectionId: status.connectionId })}
					onDone={invalidate}
				/>
			</section>
		)
	}
	return (
		<section className="source-checkpoint">
			<CheckpointHead lamp="ok" title="Source connected" />
			<p>The private source holds the App credentials. Control receives webhook deliveries without exposing either secret here.</p>
			<AppFacts app={status.app} />
			<dl className="source-facts">
				<div>
					<dt>Installation</dt>
					<dd>
						<code>{status.installation.id}</code>
					</dd>
				</div>
				<div>
					<dt>Account</dt>
					<dd>{status.installation.accountLogin}</dd>
				</div>
				<div>
					<dt>Repository access</dt>
					<dd>{status.installation.repositorySelection}</dd>
				</div>
				<div>
					<dt>Verified repositories</dt>
					<dd>
						{status.installation.verifiedRepositories.length === 0
							? 'Organization grant'
							: status.installation.verifiedRepositories.map((repo) => `${repo.owner}/${repo.name}`).join(', ')}
					</dd>
				</div>
			</dl>
		</section>
	)
}

function ConnectionForm() {
	const [organization, setOrganization] = useState('')
	const [appName, setAppName] = useState('')
	const [visibility, setVisibility] = useState<'private' | 'public'>('private')
	const [repositories, setRepositories] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setError(null)
		let parsedRepositories: ReturnType<typeof parseSourceRepositories>
		try {
			parsedRepositories = parseSourceRepositories(repositories, organization)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Repository list is invalid.')
			return
		}
		setBusy(true)
		try {
			const started = await api.sourceConnection.start({
				organization: organization.trim().toLowerCase(),
				appName: appName.trim(),
				visibility,
				repositories: parsedRepositories,
			})
			window.location.assign(started.continuePath)
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Source connection could not start.')
			setBusy(false)
		}
	}

	return (
		<section className="source-checkpoint">
			<CheckpointHead lamp="idle" title="Create the organization-owned App" />
			<p>Fabrika will hand off to GitHub once, persist the App on the private source, and return here for installation verification.</p>
			<form className="form source-form" onSubmit={submit}>
				<div className="form-row">
					<label>
						GitHub organization<input
							required
							value={organization}
							onChange={(event) => setOrganization(event.target.value)}
							placeholder="acme"
							maxLength={MAX_SOURCE_ORGANIZATION_LENGTH}
							autoComplete="off"
						/>
					</label>
					<label>
						GitHub App name<input
							required
							value={appName}
							onChange={(event) => setAppName(event.target.value)}
							placeholder="acme-fabrika"
							maxLength={MAX_SOURCE_APP_NAME_LENGTH}
							autoComplete="off"
						/>
					</label>
				</div>
				<fieldset className="source-visibility">
					<legend>App visibility</legend>
					<label>
						<input type="radio" name="visibility" value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Private
					</label>
					<label>
						<input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public
					</label>
					<span className="hint">
						A public App may be installed by other organizations later. This initial verified repository set must stay in the owner organization.
					</span>
				</fieldset>
				<label>
					Repositories (optional)<textarea
						value={repositories}
						onChange={(event) => setRepositories(event.target.value)}
						placeholder="acme/api\nacme/web"
						maxLength={MAX_SOURCE_REPOSITORIES_TEXT_LENGTH}
						spellCheck={false}
					/>
					<span className="hint">One owner/repository per line. Every repository must belong to the organization above.</span>
				</label>
				{error !== null && <p className="error-text" role="alert">{error}</p>}
				<div className="form-actions">
					<button className="primary" type="submit" disabled={busy || organization.trim() === '' || appName.trim() === ''}>
						{busy ? 'Starting…' : 'Connect GitHub source'}
					</button>
				</div>
			</form>
		</section>
	)
}

function ConnectionMutation(
	{ label, pending, primary = false, action, onDone }: {
		label: string
		pending: string
		primary?: boolean
		action: () => Promise<unknown>
		onDone: () => void
	},
) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	async function run() {
		setBusy(true)
		setError(null)
		try {
			await action()
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'The connection action failed.')
			setBusy(false)
		}
	}
	return (
		<div className="source-mutation">
			<button className={primary ? 'primary' : undefined} type="button" disabled={busy} onClick={run}>{busy ? pending : label}</button>
			{error !== null && <p className="error-text" role="alert">{error}</p>}
		</div>
	)
}

function CheckpointHead({ lamp, title }: { lamp: Lamp; title: string }) {
	return (
		<div className="section-head">
			<Status lamp={lamp}>{title}</Status>
		</div>
	)
}

function AppFacts({ app }: { app: GitHubSourceConnectionAppDto }) {
	return (
		<div className="source-app">
			<a href={app.htmlUrl} target="_blank" rel="noreferrer">
				{app.slug} <Icon name="external" size={13} />
			</a>
			<span>{app.owner.login}</span>
			<span>{app.public ? 'public App' : 'private App'}</span>
			<span>contents: read</span>
			<span>push events</span>
		</div>
	)
}

function phaseCopy(phase: Extract<GitHubSourceConnectionStatusDto, { state: 'setup-pending' }>['phase']): string {
	if (phase === 'awaiting-manifest-callback') return 'Waiting for GitHub to return the one-time manifest conversion.'
	if (phase === 'persisting') return 'Persisting the App credentials on the private source service.'
	if (phase === 'activating') return 'Verifying the App identity and activating the source client.'
	return 'Preparing a bound GitHub manifest handoff.'
}

function repairCopy(reason: Extract<GitHubSourceConnectionStatusDto, { state: 'repair-required' }>['reason']): string {
	if (reason === 'credential-activation') return 'The durable App credentials are not active on the private source.'
	if (reason === 'installation-verification') return 'The App installation no longer matches the configured organization or repositories.'
	return 'A previous setup stopped after GitHub created the App. Resume from the durable checkpoint.'
}
