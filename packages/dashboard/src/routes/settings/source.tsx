import { createPage, useRouter } from '@buzola/router'
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { type Lamp, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import {
	api,
	ApiError,
	GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE,
	type GitHubSourceConnectionAppDto,
	type GitHubSourceConnectionConnectedDto,
	type GitHubSourceConnectionStatusDto,
	type GitHubSourceConnectionWorkflowDto,
} from '../../lib/api'
import {
	appendSourceConnectionPage,
	initialSourceConnectionCollection,
	MAX_SOURCE_APP_NAME_LENGTH,
	MAX_SOURCE_ORGANIZATION_LENGTH,
	MAX_SOURCE_REPOSITORIES_TEXT_LENGTH,
	parseSourceRepositories,
	privateSourceConnectionRequest,
	reconcileSourceConnectionFirstPage,
	scheduleSourceConnectionPoll,
	sourceChain,
	sourceConnectionInput,
	sourceManifestContinuePath,
	sourceStartContinuePath,
} from '../../lib/source-connection'

export default createPage()
	.loader(async () => ({ page: await api.sourceConnection.list({ limit: GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE }) }))
	.route('/settings/source')
	.render(({ data, invalidate }) => {
		const [collection, setCollection] = useState(() => initialSourceConnectionCollection(data.page))
		const [adding, setAdding] = useState(false)
		const [loadingMore, setLoadingMore] = useState(false)
		const [loadError, setLoadError] = useState<string | null>(null)

		useEffect(() => {
			setCollection((current) => reconcileSourceConnectionFirstPage(current, data.page))
			if (data.page.workflow !== null && data.page.workflow.state !== 'anonymous') setAdding(false)
		}, [data.page])

		useEffect(() => {
			return scheduleSourceConnectionPoll(data.page.workflow, invalidate, (callback, delayMs) => {
				const timer = window.setTimeout(callback, delayMs)
				return () => window.clearTimeout(timer)
			})
		}, [data.page.workflow, invalidate])

		async function loadMore() {
			if (collection.nextCursor === null) return
			setLoadingMore(true)
			setLoadError(null)
			try {
				const page = await api.sourceConnection.list({
					cursor: collection.nextCursor,
					limit: GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE,
				})
				setCollection((current) => appendSourceConnectionPage(current, page))
			} catch (cause) {
				setLoadError(cause instanceof ApiError ? cause.message : 'More source connections could not be loaded.')
			} finally {
				setLoadingMore(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<p className="eyebrow">Delivery checkpoint</p>
					<h1>Source connection</h1>
					<p className="hint">Connect one private GitHub App per organization without placing App credentials in this browser.</p>
				</div>
				<ConnectedConnections connections={collection.items} invalidate={invalidate} />
				{loadError !== null && <p className="error-text" role="alert">{loadError}</p>}
				{collection.nextCursor !== null && (
					<div className="pager source-connections-pager">
						<button type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more connections'}</button>
					</div>
				)}
				<SourceWorkflow
					workflow={data.page.workflow}
					connectionCount={collection.items.length}
					adding={adding}
					onAdd={() => setAdding(true)}
					onCancelAdd={() => setAdding(false)}
					invalidate={invalidate}
				/>
			</>
		)
	})

export function ConnectedConnections(
	{ connections, invalidate }: { connections: readonly GitHubSourceConnectionConnectedDto[]; invalidate: () => void },
) {
	return (
		<section aria-labelledby="connected-source-connections">
			<div className="section-head">
				<h2 id="connected-source-connections">Connected organizations</h2>
			</div>
			<p className="section-note">
				Each organization uses its own GitHub App, installation and private source credential. Reconcile repairs the credential binding and reapplies the
				stored webhook configuration without exposing or replacing the private key.
			</p>
			<Table
				colSpan={4}
				isEmpty={connections.length === 0}
				empty={<EmptyState icon="link" title="No organizations connected" body="Add the first private GitHub source connection below." />}
				head={
					<tr>
						<th className="grow">Organization and App</th>
						<th>Installation</th>
						<th>Repository access</th>
						<th>Status</th>
					</tr>
				}
			>
				{connections.map((connection) => (
					<tr key={connection.connectionId} aria-label={`GitHub source connection for ${connection.app.owner.login}`}>
						<td>
							<strong>{connection.app.owner.login}</strong>
							<div className="muted small">
								<a href={connection.app.htmlUrl} target="_blank" rel="noreferrer">
									{connection.app.slug} <Icon name="external" size={12} />
								</a>
								{' · '}
								{connection.app.public ? 'legacy public App' : 'private App'}
							</div>
						</td>
						<td>
							<code>{connection.installation.id}</code>
							<div className="muted small">{connection.installation.accountLogin}</div>
						</td>
						<td>
							{connection.installation.repositorySelection === 'all' ? 'All repositories' : 'Selected repositories'}
							<div className="muted small">{verifiedRepositoryCopy(connection)}</div>
						</td>
						<td>
							<Status lamp="ok">Connected</Status>
							<ConnectionMutation
								label="Reconcile"
								ariaLabel={`Reconcile GitHub source connection ${connection.app.owner.login}`}
								connectionId={connection.connectionId}
								pending="Reconciling…"
								action={() => api.sourceConnection.reconcile(sourceConnectionInput(connection.connectionId))}
								onDone={invalidate}
							/>
						</td>
					</tr>
				))}
			</Table>
		</section>
	)
}

export function SourceWorkflow(
	{ workflow, connectionCount, adding, onAdd, onCancelAdd, invalidate }: {
		workflow: GitHubSourceConnectionWorkflowDto | null
		connectionCount: number
		adding: boolean
		onAdd: () => void
		onCancelAdd: () => void
		invalidate: () => void
	},
) {
	const idle = workflow === null || workflow.state === 'anonymous'
	return (
		<section aria-labelledby="source-connection-workflow">
			<div className="section-head">
				<h2 id="source-connection-workflow">Connection setup</h2>
			</div>
			{idle && connectionCount > 0 && !adding
				? (
					<div className="source-checkpoint">
						<CheckpointHead lamp="ok" title="Ready for another organization" />
						<p>Connected organizations remain active while you add another private GitHub App.</p>
						<div className="form-actions">
							<button className="primary" type="button" onClick={onAdd}>Add connection</button>
						</div>
					</div>
				)
				: idle
				? <ConnectionForm onCancel={connectionCount > 0 ? onCancelAdd : undefined} />
				: (
					<>
						<ConnectionChain status={workflow} />
						<SourceAction status={workflow} connectionCount={connectionCount} invalidate={invalidate} />
					</>
				)}
		</section>
	)
}

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

function SourceAction(
	{ status, connectionCount, invalidate }: { status: GitHubSourceConnectionWorkflowDto; connectionCount: number; invalidate: () => void },
) {
	if (status.state === 'anonymous') return null
	if (status.state === 'unavailable') {
		return (
			<section className="source-checkpoint">
				<CheckpointHead lamp="idle" title="UI connection unavailable" />
				<p>This provider or installation setup does not expose source connection management in the console. Use its supported operator setup path.</p>
			</section>
		)
	}
	if (status.state === 'adoption-required') {
		if (connectionCount > 0) {
			return (
				<section className="source-checkpoint source-checkpoint-failed">
					<CheckpointHead lamp="stop" title="Legacy adoption unavailable" />
					<p>The existing source credential can be adopted only before the first organization connection is recorded.</p>
				</section>
			)
		}
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
					{continuePath !== null && (
						<a className="btn primary" href={continuePath} aria-label={`Continue GitHub setup ${status.connectionId}`}>Continue to GitHub</a>
					)}
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
					<a
						className="btn primary"
						href={status.installationUrl}
						target="_blank"
						rel="noreferrer"
						aria-label={`Open GitHub installation for ${status.app.owner.login}`}
					>
						Open GitHub installation <Icon name="external" size={14} />
					</a>
					<ConnectionMutation
						label="Verify installation"
						ariaLabel={`Verify GitHub installation for ${status.app.owner.login}`}
						connectionId={status.connectionId}
						pending="Verifying…"
						action={() => api.sourceConnection.verifyInstallation(sourceConnectionInput(status.connectionId))}
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
					ariaLabel={`Repair GitHub source connection ${status.app?.owner.login ?? status.connectionId}`}
					connectionId={status.connectionId}
					pending="Repairing…"
					action={() => api.sourceConnection.repair(sourceConnectionInput(status.connectionId))}
					onDone={invalidate}
				/>
			</section>
		)
	}
}

function ConnectionForm({ onCancel }: { onCancel?: () => void }) {
	const router = useRouter()
	const [organization, setOrganization] = useState('')
	const [appName, setAppName] = useState('')
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
			const started = await api.sourceConnection.start(privateSourceConnectionRequest(organization, appName, parsedRepositories))
			const continuePath = sourceStartContinuePath(started)
			if (continuePath === null) throw new Error('invalid source connection handoff')
			// Control serves this path, not the console (ADR-0031). `location.assign` would raise a
			// navigate event the router's catch-all 404 matches, and it would render "Not found"
			// without a request ever leaving the browser.
			router.leaveApp(continuePath)
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
				<p className="hint">The new App is private and belongs only to this organization.</p>
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
					{onCancel !== undefined && <button className="ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
				</div>
			</form>
		</section>
	)
}

function ConnectionMutation(
	{ label, ariaLabel, connectionId, pending, primary = false, action, onDone }: {
		label: string
		ariaLabel?: string
		connectionId?: string
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
		} finally {
			// Clear on EVERY path: an action that succeeds without changing the state re-renders this same
			// button, and leaving `busy` set locks it on its pending label with nothing to click.
			setBusy(false)
		}
	}
	return (
		<div className="source-mutation">
			<button
				aria-label={ariaLabel}
				data-connection-id={connectionId}
				className={primary ? 'primary' : undefined}
				type="button"
				disabled={busy}
				onClick={run}
			>
				{busy ? pending : label}
			</button>
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

function verifiedRepositoryCopy(connection: GitHubSourceConnectionConnectedDto): string {
	const repositories = connection.installation.verifiedRepositories
	if (repositories.length === 0) return connection.installation.accountLogin
	return repositories.map((repository) => `${repository.owner}/${repository.name}`).join(', ')
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
