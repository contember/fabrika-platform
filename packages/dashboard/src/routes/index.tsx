import { createPage, Link } from '@buzola/router'
// "Live" for a share link (revoked beats expired) is one rule; it lives with the access plane that owns it.
import { shareLinkState } from '@fabrika/iam-ui/format'
import { Icon } from '../components/Icon'
import { Chip, namespaceLamp, RunStatus, Status, StatusLamp } from '../components/Status'
import { EmptyState } from '../components/Table'
import { api, type AppDto, type DeploymentNamespaceDto, type RunDto } from '../lib/api'
import { fmtAgo, fmtDuration, shortRef, shortSha } from '../lib/format'
import { type IamAuditEventDto, type IamSnapshot, iamSnapshot } from '../lib/iam'

// Overview — the whole installation on one screen. Delivery answers "is anything
// in flight, did the last releases land, is a placement broken"; the access half answers "who and what
// can reach this"; Operations is the boundary for runtime failures and telemetry.
//
// Composed from the typed list procedures that already exist; there is no aggregate endpoint and this
// page does not justify inventing one. The
// IAM read is best-effort — an operator without `iam.admin` still gets a working delivery overview.
// Onboarding lives at `/apps/new`.

/** Enough recent runs to read in-flight work and a day's outcome without a second page. */
const RUN_WINDOW = 60
const DAY_SECONDS = 86_400

export default createPage()
	.loader(async () => {
		const [apps, namespaces, runs, iam] = await Promise.all([
			api.apps.list(),
			api.namespaces.list(),
			api.runs.list({ limit: RUN_WINDOW }),
			iamSnapshot(),
		])
		return { apps: apps.items, namespaces: namespaces.items, runs: runs.items, iam }
	})
	.route('/')
	.render(({ data }) => {
		const { apps, namespaces, runs, iam } = data
		const nowSeconds = Math.floor(Date.now() / 1000)

		const inFlight = runs.filter((run) => run.status === 'pending' || run.status === 'running')
		const settledToday = runs.filter((run) => run.createdAt >= nowSeconds - DAY_SECONDS && (run.status === 'succeeded' || run.status === 'failed'))
		const okToday = settledToday.filter((run) => run.status === 'succeeded').length
		const failedRecently = runs.filter((run) => run.status === 'failed').slice(0, 4)
		const brokenNamespaces = namespaces.filter((namespace) => namespace.state === 'failed')
		const readyNamespaces = namespaces.filter((namespace) => namespace.state === 'ready').length
		const attention = brokenNamespaces.length + failedRecently.length

		if (apps.length === 0 && namespaces.length === 0) {
			return <ColdStart />
		}

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Overview</h1>
							<p className="hint">What this installation is releasing, who can reach it, and where runtime failures are investigated.</p>
						</div>
						<Link to="apps/new" className="btn primary">
							<Icon name="plus" />
							New app
						</Link>
					</div>
				</div>

				<section>
					<div className="section-head">
						<Icon name="runs" size={15} />
						<h2>Delivery plane</h2>
						<span className="spacer" />
						<Link to="runs" className="card-link">
							Deploy runs
							<Icon name="chevron-right" size={13} />
						</Link>
					</div>
					<div className="instrument-cluster">
						<div className="instrument">
							<div className="instrument-label">Applications</div>
							<div className="instrument-value">{apps.length}</div>
							<div className="instrument-note">registered here</div>
						</div>
						<div className="instrument">
							<div className="instrument-label">Namespaces</div>
							<div className="instrument-value">
								{readyNamespaces}
								<small>/ {namespaces.length}</small>
							</div>
							<div className="instrument-note">
								{brokenNamespaces.length > 0
									? <Status lamp="stop">{brokenNamespaces.length} failed</Status>
									: <Status lamp={namespaces.length === 0 ? 'idle' : 'ok'}>ready to place</Status>}
							</div>
						</div>
						<div className="instrument">
							<div className="instrument-label">In flight</div>
							<div className="instrument-value">{inFlight.length}</div>
							<div className="instrument-note">
								<Status lamp={inFlight.length > 0 ? 'run' : 'idle'}>
									{inFlight.length > 0 ? 'deploying now' : 'line is quiet'}
								</Status>
							</div>
						</div>
						<div className="instrument">
							<div className="instrument-label">Releases · 24 h</div>
							<div className="instrument-value">
								{okToday}
								<small>/ {settledToday.length}</small>
							</div>
							<div className="instrument-note">
								<Status lamp={settledToday.length === 0 ? 'idle' : okToday === settledToday.length ? 'ok' : 'stop'}>
									{settledToday.length === 0 ? 'nothing released' : okToday === settledToday.length ? 'all landed' : `${settledToday.length - okToday} failed`}
								</Status>
							</div>
						</div>
					</div>
				</section>

				<AccessPlane iam={iam} nowSeconds={nowSeconds} />
				<OperationsPlane />

				<div className="board">
					<div className="board-col">
						<section className="card">
							<div className="card-head">
								<Icon name="runs" size={15} />
								<h2>Recent deploys</h2>
								<span className="spacer" />
								<Link to="runs" className="card-link">
									All runs
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{runs.length === 0
									? (
										<EmptyState
											icon="runs"
											title="Nothing has deployed yet"
											body="A push to an app env's trigger ref starts a run, or deploy one by hand from its app page."
										/>
									)
									: (
										<div className="feed">
											{runs.slice(0, 9).map((run) => <RunRow key={run.id} run={run} />)}
										</div>
									)}
							</div>
						</section>

						<section className="card">
							<div className="card-head">
								<Icon name="app" size={15} />
								<h2>Applications</h2>
								<span className="spacer" />
								<Link to="apps" className="card-link">
									All
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{apps.length === 0
									? (
										<EmptyState
											icon="app"
											title="No apps registered"
											action={<Link to="apps/new" className="btn small primary">Onboard the first app</Link>}
										/>
									)
									: (
										<div className="feed">
											{apps.slice(0, 6).map((app) => (
												<Link key={app.id} to="apps/detail" params={{ id: app.id }} className="feed-row">
													<span className="feed-main">
														<span className="feed-title">
															<span className="truncate">{app.id}</span>
														</span>
														<span className="feed-meta">
															<code className="truncate">{app.repoUrl.replace(/^https?:\/\//, '')}</code>
														</span>
													</span>
													<span className="feed-side">
														<Chip>
															<Icon name="branch" size={11} />
															{app.defaultBranch}
														</Chip>
													</span>
												</Link>
											))}
										</div>
									)}
							</div>
						</section>
					</div>

					<div className="board-col">
						{attention > 0 && (
							<section className="card">
								<div className="card-head">
									<Icon name="alert" size={15} />
									<h2>Needs attention</h2>
								</div>
								<div className="card-body flush">
									<div className="feed">
										{brokenNamespaces.map((namespace) => <BrokenNamespaceRow key={namespace.id} namespace={namespace} />)}
										{failedRecently.map((run) => (
											<Link key={run.id} to="runs/detail" params={{ id: run.id }} className="feed-row">
												<StatusLamp lamp="stop" />
												<span className="feed-main">
													<span className="feed-title">
														<span className="truncate">{run.appId}</span>
														<Chip>{run.env}</Chip>
													</span>
													<span className="feed-meta">
														deploy failed
														{run.exitCode !== null && <span className="dot-sep">exit {run.exitCode}</span>}
													</span>
												</span>
												<span className="feed-side">
													<strong>{fmtAgo(run.finishedAt ?? run.createdAt)}</strong>
												</span>
											</Link>
										))}
									</div>
								</div>
							</section>
						)}

						{iam !== null && (
							<section className="card">
								<div className="card-head">
									<Icon name="history" size={15} />
									<h2>Recent access changes</h2>
									<span className="spacer" />
									<Link to="access/audit" className="card-link">
										Audit
										<Icon name="chevron-right" size={13} />
									</Link>
								</div>
								<div className="card-body flush">
									{iam.audit.length === 0
										? <EmptyState icon="history" title="No recorded decisions yet" />
										: (
											<div className="feed">
												{iam.audit.slice(0, 6).map((event) => <AuditRow key={event.id} event={event} />)}
											</div>
										)}
								</div>
							</section>
						)}

						<section className="card">
							<div className="card-head">
								<Icon name="bay" size={15} />
								<h2>Namespaces</h2>
								<span className="spacer" />
								<Link to="namespaces" className="card-link">
									All
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{namespaces.length === 0
									? (
										<EmptyState
											icon="bay"
											title="No placements yet"
											body="A namespace is the bounded area an app is deployed into."
											action={<Link to="namespaces/create" className="btn small">Provision one</Link>}
										/>
									)
									: (
										<div className="feed">
											{namespaces.slice(0, 6).map((namespace) => (
												<Link
													key={namespace.id}
													to="namespaces/detail"
													params={{ id: namespace.id }}
													className="feed-row"
												>
													<StatusLamp lamp={namespaceLamp(namespace.state)} />
													<span className="feed-main">
														<span className="feed-title">
															<span className="truncate">{namespace.id}</span>
														</span>
														<span className="feed-meta">
															{namespace.state}
															<span className="dot-sep">
																{namespace.exclusiveAppId === null ? 'shared' : `${namespace.exclusiveAppId} only`}
															</span>
														</span>
													</span>
													<span className="feed-side">
														<Chip>{namespace.env}</Chip>
													</span>
												</Link>
											))}
										</div>
									)}
							</div>
						</section>
					</div>
				</div>
			</>
		)
	})

/**
 * The access half of the installation. Its own gauge cluster rather than folded into the delivery one —
 * the two planes are the product's actual shape, and a reading means something different on each.
 * Replaced by a notice when IAM refused or is unreachable.
 */
function AccessPlane({ iam, nowSeconds }: { iam: IamSnapshot | null; nowSeconds: number }) {
	if (iam === null) {
		return (
			<section>
				<div className="section-head">
					<Icon name="shield" size={15} />
					<h2>Access plane</h2>
				</div>
				<div className="notice">
					<Icon name="lock" size={15} />
					<span>
						This account can't read the access plane — it needs the <code>iam.admin</code> role.
					</span>
				</div>
			</section>
		)
	}

	// Reported in the vocabulary the rail uses: users are people, machines are credentials. A service
	// principal has no separate page — it is the thing an API key belongs to.
	const users = iam.principals.filter((principal) => principal.type === 'user')
	const invited = users.filter((user) => user.status === 'invited')
	const activeKeys = iam.apiKeys.filter((key) => key.status === 'active')
	const revokedKeys = iam.apiKeys.length - activeKeys.length
	const liveLinks = iam.shareLinks.filter((link) => shareLinkState(link, nowSeconds * 1000) === 'active')
	const changesToday = iam.audit.filter((event) => event.createdAt >= nowSeconds - DAY_SECONDS).length

	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Access plane</h2>
				<span className="spacer" />
				<Link to="access" className="card-link">
					Open
					<Icon name="chevron-right" size={13} />
				</Link>
			</div>
			<div className="instrument-cluster">
				<div className="instrument">
					<div className="instrument-label">Users</div>
					<div className="instrument-value">{users.length}</div>
					<div className="instrument-note">
						{users.length === 0
							? <Status lamp="idle">nobody invited</Status>
							: invited.length > 0
							? <Status lamp="run">{invited.length} awaiting first sign-in</Status>
							: <Status lamp="ok">all signed in</Status>}
					</div>
				</div>
				<div className="instrument">
					<div className="instrument-label">API keys</div>
					<div className="instrument-value">
						{activeKeys.length}
						<small>/ {iam.apiKeys.length}</small>
					</div>
					<div className="instrument-note">
						<Status lamp={activeKeys.length === 0 ? 'idle' : 'ok'}>
							{revokedKeys > 0 ? `${revokedKeys} revoked` : 'all active'}
						</Status>
					</div>
				</div>
				<div className="instrument">
					<div className="instrument-label">Share links</div>
					<div className="instrument-value">
						{liveLinks.length}
						<small>/ {iam.shareLinks.length}</small>
					</div>
					<div className="instrument-note">
						<Status lamp={liveLinks.length === 0 ? 'idle' : 'ok'}>
							{liveLinks.length === 0 ? 'none in circulation' : 'anonymous, revocable'}
						</Status>
					</div>
				</div>
				<div className="instrument">
					<div className="instrument-label">Changes · 24 h</div>
					<div className="instrument-value">{changesToday}</div>
					<div className="instrument-note">
						<Status lamp={changesToday > 0 ? 'ok' : 'idle'}>audited decisions</Status>
					</div>
				</div>
			</div>
		</section>
	)
}

function OperationsPlane() {
	return (
		<section>
			<div className="section-head">
				<Icon name="alert" size={15} />
				<h2>Operations plane</h2>
				<span className="spacer" />
				<Link to="operations" className="card-link">
					Open
					<Icon name="chevron-right" size={13} />
				</Link>
			</div>
			<div className="notice">
				<Icon name="runs" size={15} />
				<span>
					Application errors, release context and telemetry health live behind an independent Operations boundary.
				</span>
			</div>
		</section>
	)
}

function RunRow({ run }: { run: RunDto }) {
	const live = run.status === 'pending' || run.status === 'running'
	return (
		<Link to="runs/detail" params={{ id: run.id }} className="feed-row">
			<span className="feed-main">
				<span className="feed-title">
					<span className="truncate">{run.appId}</span>
					<Chip>{run.env}</Chip>
				</span>
				{/* A feed line states what is there; an em-dash placeholder is a table's job, not a sentence's. */}
				<span className="feed-meta">
					<Icon name="branch" size={12} />
					<code>{shortRef(run.ref)}</code>
					{run.commitSha !== null && run.commitSha !== '' && (
						<span className="dot-sep">
							<code>{shortSha(run.commitSha)}</code>
						</span>
					)}
					<span className="dot-sep">{run.trigger}</span>
				</span>
			</span>
			<span className="feed-side">
				<RunStatus status={run.status} />
				<span>
					{live ? fmtAgo(run.startedAt ?? run.createdAt) : fmtDuration(run.startedAt, run.finishedAt)}
					<span className="dot-sep">{fmtAgo(run.createdAt)}</span>
				</span>
			</span>
		</Link>
	)
}

function AuditRow({ event }: { event: IamAuditEventDto }) {
	return (
		<div className="feed-row">
			<span className="feed-main">
				<span className="feed-title">
					<code className="truncate">{event.action}</code>
				</span>
				<span className="feed-meta">
					<span className="truncate">{event.principalLabel ?? event.principalId}</span>
					{event.resourceType !== null && <span className="dot-sep">{event.resourceType}</span>}
				</span>
			</span>
			<span className="feed-side">
				<strong>{fmtAgo(event.createdAt)}</strong>
			</span>
		</div>
	)
}

function BrokenNamespaceRow({ namespace }: { namespace: DeploymentNamespaceDto }) {
	return (
		<Link to="namespaces/detail" params={{ id: namespace.id }} className="feed-row">
			<StatusLamp lamp="stop" />
			<span className="feed-main">
				<span className="feed-title">
					<span className="truncate">{namespace.id}</span>
					<Chip>{namespace.env}</Chip>
				</span>
				<span className="feed-meta">
					<span className="truncate">{namespace.lastError ?? 'Placement failed — reconcile it.'}</span>
				</span>
			</span>
		</Link>
	)
}

/**
 * A fresh installation has no apps and no placements: the overview would be a row of zeroes, which
 * tells an operator nothing. Show the bring-up order instead.
 */
function ColdStart() {
	return (
		<>
			<div className="page-head">
				<h1>The line is empty</h1>
				<p className="hint">
					fabrika is installed and the control plane is answering. Two steps put the first release through it.
				</p>
			</div>

			<div className="board">
				<div className="board-col">
					<section className="card">
						<div className="card-head">
							<Icon name="bay" size={15} />
							<h2>1 · Open a namespace</h2>
						</div>
						<div className="card-body">
							<p className="hint">
								A deployment namespace is the bounded area on the provider where apps get placed. Provision one per environment before onboarding anything
								into it.
							</p>
							<div className="form-actions">
								<Link to="namespaces/create" className="btn primary">
									<Icon name="plus" />
									Provision a namespace
								</Link>
							</div>
						</div>
					</section>
				</div>
				<div className="board-col">
					<section className="card">
						<div className="card-head">
							<Icon name="app" size={15} />
							<h2>2 · Onboard an app</h2>
						</div>
						<div className="card-body">
							<p className="hint">
								Point fabrika at a GitHub repo, pick the namespace it deploys into, and paste the manifest its build produced.
							</p>
							<div className="form-actions">
								<Link to="apps/new" className="btn">
									<Icon name="plus" />
									Onboard an app
								</Link>
							</div>
						</div>
					</section>
				</div>
			</div>
		</>
	)
}
