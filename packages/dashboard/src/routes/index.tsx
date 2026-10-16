import { createPage, Link } from '@buzola/router'
import { BrandMark, Icon, type IconName } from '../components/Icon'
import { Chip, namespaceLamp, RunStatus, Status, StatusLamp } from '../components/Status'
import { EmptyState } from '../components/Table'
import { api, type AppDto, type AppEnvDto, type DeploymentNamespaceDto, type RunDto } from '../lib/api'
import { fmtAgo, fmtDuration, shortRef, shortSha } from '../lib/format'
import { type IamAuditEventDto, type IamPrincipalDto, iamPrincipals, recentAuditChanges } from '../lib/iam'

// Overview: the whole installation on one screen, laid out after the designer's console mockups: a row
// of readings, then what deployed, how the line has run for two weeks and what changed, then the apps.
// Everything on it is read from the typed list procedures that already exist; there is no aggregate
// endpoint and this page does not justify inventing one. What the mockups show and fabrika does not
// measure (resource usage, a team's presence) is left out rather than faked.
//
// The IAM read is best-effort: an operator without `iam.admin` still gets a working delivery overview.
// Onboarding lives at `/apps/new`. A fresh installation gets the welcome instead of a row of zeroes.

/** The most runs one call returns; enough for two weeks of a small fleet, and the chart says when it isn't. */
const RUN_WINDOW = 200
/** Applications whose environments the table reads; past this the table links to the full list. */
const APP_TABLE_LIMIT = 8
const CHART_DAYS = 14
const ACTIVITY_ROWS = 6
const DAY_SECONDS = 86_400

export default createPage()
	.loader(async () => {
		// The environment reads need only the app list, so they start as soon as it answers, beside the IAM reads
		// (the audit feed may page a few times) rather than after them. One read per listed app, since Control answers one app
		// at a time (docs/backlog/190); a refused or failed one leaves that row without environments.
		const appList = api.apps.list()
		const appEnvironments = appList.then((apps) =>
			Promise.all(
				apps.items.slice(0, APP_TABLE_LIMIT).map(async (app) =>
					[app.id, await api.apps.environments.list({ appId: app.id }).then((list) => list.items, () => [])] as const
				),
			)
		)
		const [apps, namespaces, runs, latestFailures, principals, activity, environments] = await Promise.all([
			appList,
			api.namespaces.list(),
			api.runs.list({ limit: RUN_WINDOW }),
			api.runs.latestFailures(),
			iamPrincipals(),
			recentAuditChanges(ACTIVITY_ROWS),
			appEnvironments,
		])
		return {
			apps: apps.items,
			namespaces: namespaces.items,
			runs: runs.items,
			runsComplete: runs.nextCursor === null,
			latestFailures: latestFailures.items,
			principals,
			activity,
			environments: new Map(environments),
		}
	})
	.route('/')
	.render(({ data }) => {
		const { apps, namespaces, runs, runsComplete, latestFailures, principals, activity, environments } = data
		const nowSeconds = Math.floor(Date.now() / 1000)

		if (apps.length === 0) {
			return <Welcome namespaces={namespaces} />
		}

		const inFlight = runs.filter((run) => run.status === 'pending' || run.status === 'running')
		const awaiting = runs.filter((run) => run.status === 'awaiting_approval')
		const settledToday = runs.filter((run) => run.createdAt >= nowSeconds - DAY_SECONDS && (run.status === 'succeeded' || run.status === 'failed'))
		const okToday = settledToday.filter((run) => run.status === 'succeeded').length
		const brokenNamespaces = namespaces.filter((namespace) => namespace.state === 'failed')
		const readyNamespaces = namespaces.filter((namespace) => namespace.state === 'ready').length
		const newThisMonth = apps.filter((app) => app.createdAt >= nowSeconds - 30 * DAY_SECONDS).length
		const envCount = new Set(namespaces.map((namespace) => namespace.env)).size

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Overview</h1>
							<p className="hint">What this installation is releasing, how the line has run, and what changed in who can reach it.</p>
						</div>
						<Link to="apps/new" className="btn primary">
							<Icon name="plus" />
							New application
						</Link>
					</div>
				</div>

				<section className="overview-row">
					<div className="instrument-cluster readings">
						<Link to="apps" className="instrument">
							<div className="instrument-label">Applications</div>
							<div className="instrument-value">{apps.length}</div>
							<div className="instrument-note">{newThisMonth > 0 ? `+${newThisMonth} in the last 30 days` : 'registered here'}</div>
						</Link>
						<Link to="namespaces" className="instrument">
							<div className="instrument-label">Namespaces</div>
							<div className="instrument-value">
								{readyNamespaces}
								{readyNamespaces !== namespaces.length && <small>/ {namespaces.length}</small>}
							</div>
							<div className="instrument-note">
								{brokenNamespaces.length > 0
									? <Status lamp="stop">{brokenNamespaces.length} failed</Status>
									: `${envCount} ${envCount === 1 ? 'environment' : 'environments'}`}
							</div>
						</Link>
						<Link to="runs" className="instrument">
							<div className="instrument-label">In flight</div>
							<div className="instrument-value">{inFlight.length}</div>
							<div className="instrument-note">
								<Status lamp={inFlight.length > 0 ? 'run' : awaiting.length > 0 ? 'run' : 'idle'}>
									{inFlight.length > 0
										? 'deploying now'
										: awaiting.length > 0
										? `${awaiting.length} awaiting approval`
										: 'line is quiet'}
								</Status>
							</div>
						</Link>
						<Link to="runs" className="instrument">
							<div className="instrument-label">Deploys (24 h)</div>
							<div className="instrument-value">{settledToday.length}</div>
							<div className="instrument-note">
								{settledToday.length === 0
									? 'nothing released'
									: okToday === settledToday.length
									? <Status lamp="ok">all succeeded</Status>
									: <Status lamp="stop">{settledToday.length - okToday} failed</Status>}
							</div>
						</Link>
						<UsersTile principals={principals} />
					</div>
				</section>

				{(brokenNamespaces.length > 0 || latestFailures.length > 0) && (
					<section className="card overview-row">
						<div className="card-head">
							<Icon name="alert" size={18} />
							<h2>Needs attention</h2>
						</div>
						<div className="card-body flush">
							<div className="feed">
								{brokenNamespaces.map((namespace) => <BrokenNamespaceRow key={namespace.id} namespace={namespace} />)}
								{latestFailures.map((run) => <FailedRunRow key={run.id} run={run} />)}
							</div>
						</div>
					</section>
				)}

				<DeployChart runs={runs} complete={runsComplete} nowSeconds={nowSeconds} />

				<div className="overview-pair">
					<section className="overview-panel">
						<div className="panel-head">
							<h2>Recent deploys</h2>
							<span className="spacer" />
							<Link to="runs" className="panel-link">View all</Link>
						</div>
						<div className="panel-body">
							{runs.length === 0
								? (
									<EmptyState
										icon="runs"
										title="Nothing has deployed yet"
										body="A push to an environment's trigger ref starts a run, or deploy one by hand from its app page."
									/>
								)
								: (
									<div className="feed">
										{runs.slice(0, 6).map((run) => <RunRow key={run.id} run={run} />)}
									</div>
								)}
						</div>
					</section>

					<ActivityCard activity={activity} />
				</div>

				<AppsTable apps={apps} environments={environments} runs={runs} />
			</>
		)
	})

/** People, as the Access rail counts them; a machine is a credential, not a user. */
function UsersTile({ principals }: { principals: IamPrincipalDto[] | null }) {
	if (principals === null) {
		return (
			<div className="instrument">
				<div className="instrument-label">Users</div>
				<div className="instrument-value">
					<small>not readable</small>
				</div>
				<div className="instrument-note">needs the iam.admin role</div>
			</div>
		)
	}
	const users = principals
	const invited = users.filter((user) => user.status === 'invited').length
	return (
		<Link to="access/users" className="instrument">
			<div className="instrument-label">Users</div>
			<div className="instrument-value">{users.length}</div>
			<div className="instrument-note">
				{users.length === 0
					? 'nobody invited'
					: invited > 0
					? <Status lamp="run">{invited} awaiting first sign-in</Status>
					: 'all signed in'}
			</div>
		</Link>
	)
}

interface ChartDay {
	start: number
	ok: number
	failed: number
}

/**
 * Two weeks of settled deploys, one bar per local day, failures stacked on top. Read from the overview's
 * one run list: when that list does not reach back two weeks, the chart says from when it counts.
 */
function DeployChart({ runs, complete, nowSeconds }: { runs: RunDto[]; complete: boolean; nowSeconds: number }) {
	const today = new Date(nowSeconds * 1000)
	today.setHours(0, 0, 0, 0)
	const days: ChartDay[] = Array.from({ length: CHART_DAYS }, (_, index) => {
		const day = new Date(today)
		day.setDate(day.getDate() - (CHART_DAYS - 1 - index))
		return { start: Math.floor(day.getTime() / 1000), ok: 0, failed: 0 }
	})
	const windowStart = days[0]?.start ?? nowSeconds
	const settled = runs.filter((run) => run.createdAt >= windowStart && (run.status === 'succeeded' || run.status === 'failed'))
	for (const run of settled) {
		const day = [...days].reverse().find((candidate) => candidate.start <= run.createdAt)
		if (day === undefined) continue
		if (run.status === 'succeeded') day.ok++
		else day.failed++
	}
	const peak = Math.max(1, ...days.map((day) => day.ok + day.failed))
	const succeeded = settled.filter((run) => run.status === 'succeeded')
	const durations = succeeded
		.map((run) => (run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : null))
		.filter((value) => value !== null)
		.sort((a, b) => a - b)
	const median = durations.length === 0 ? null : durations[Math.floor(durations.length / 2)] ?? null
	const oldest = runs.at(-1)
	const truncated = !complete && oldest !== undefined && oldest.createdAt > windowStart
	const label = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

	return (
		<section className="overview-panel overview-chart">
			<div className="panel-head">
				<h2>Deploys, {CHART_DAYS} days</h2>
			</div>
			<div className="deploy-chart">
				<div
					className="chart-bars"
					role="img"
					aria-label={`${settled.length} settled deploys in the last ${CHART_DAYS} days, ${settled.length - succeeded.length} failed`}
				>
					{days.map((day) => (
						<div key={day.start} className="chart-day" title={`${label(day.start)}: ${day.ok} succeeded, ${day.failed} failed`}>
							{day.failed > 0 && <span className="chart-bar failed" style={{ height: `${(day.failed / peak) * 100}%` }} />}
							{day.ok > 0 && <span className="chart-bar ok" style={{ height: `${(day.ok / peak) * 100}%` }} />}
							{day.ok + day.failed === 0 && <span className="chart-bar none" />}
						</div>
					))}
				</div>
				<div className="chart-axis">
					<span>{label(windowStart)}</span>
					<span>Today</span>
				</div>
				{truncated && oldest !== undefined && <p className="hint">Counted from {label(oldest.createdAt)}, the oldest of the last {RUN_WINDOW} runs.</p>}
				<div className="chart-totals">
					<div>
						<strong>{settled.length}</strong>
						<span>deploys</span>
					</div>
					<div>
						<strong>{settled.length === 0 ? 'none' : `${Math.round((succeeded.length / settled.length) * 100)} %`}</strong>
						<span>succeeded</span>
					</div>
					<div>
						<strong>{median === null ? 'none' : fmtDuration(0, median)}</strong>
						<span>median build</span>
					</div>
				</div>
			</div>
		</section>
	)
}

/** The changes IAM writes to its audit log, as the overview names them; an action missing here shows as its code. */
const ACTIVITY_TITLES: Record<string, string> = {
	'iam.principal.create': 'Principal created',
	'iam.principal.invite': 'User invited',
	'iam.principal.enable': 'User enabled',
	'iam.principal.disable': 'User disabled',
	'iam.principal.promote': 'User promoted',
	'iam.grant.create': 'Role granted',
	'iam.grant.revoke': 'Role revoked',
	'iam.policy.create': 'Policy created',
	'iam.policy.update': 'Policy updated',
	'iam.policy.delete': 'Policy deleted',
	'iam.apikey.create': 'API key issued',
	'iam.apikey.rotate': 'API key rotated',
	'iam.apikey.revoke': 'API key revoked',
	'iam.credential.create': 'Share link created',
	'iam.credential.revoke': 'Credential revoked',
	'iam.link.issue': 'Sign-in link issued',
	'iam.link.revoke': 'Sign-in link revoked',
	'iam.session.revoke': 'Session ended',
	'iam.session.revoke_all': 'All sessions ended',
	'iam.password.disable': 'Password disabled',
	'iam.password.enrollment.complete': 'Password set',
	'iam.member.assign': 'Member assigned',
	'iam.member.revoke': 'Member removed',
	'iam.member.accept': 'Invitation accepted',
	'iam.member.uninvite': 'Invitation withdrawn',
	'iam.app.schema.reconcile': 'Access schema reconciled',
	'iam.app.return-origins.set': 'Return origins set',
	'iam.workload.key.issue': 'Workload key issued',
	'iam.workload.key.revoke': 'Workload key revoked',
	'iam.membership-key.issue': 'Membership key issued',
	'iam.oauth.grant.create': 'Client authorized',
	'iam.oauth.grant.revoke': 'Client authorization revoked',
}

/** Icons by the resource type IAM records; an API key is recorded on its service principal. */
const ACTIVITY_ICONS: Record<string, IconName> = {
	principal: 'users',
	grant: 'shield',
	policy: 'shield',
	credential: 'link',
	session: 'lock',
	scope: 'schema',
	app: 'app',
	oauth_grant: 'key',
	membership_transport_key: 'key',
}

function ActivityCard({ activity }: { activity: IamAuditEventDto[] | null }) {
	return (
		<section className="overview-panel">
			<div className="panel-head">
				<h2>Recent activity</h2>
				<span className="spacer" />
				{activity !== null && <Link to="access/audit" className="panel-link">View all</Link>}
			</div>
			<div className="panel-body">
				{activity === null
					? <EmptyState icon="lock" title="Activity is not readable" body="The audit log needs the iam.admin role." />
					: activity.length === 0
					? <EmptyState icon="history" title="No recorded changes yet" />
					: (
						<div className="feed">
							{activity.map((event) => <ActivityRow key={event.id} event={event} />)}
						</div>
					)}
			</div>
		</section>
	)
}

function ActivityRow({ event }: { event: IamAuditEventDto }) {
	const title = ACTIVITY_TITLES[event.action]
	return (
		<div className="feed-row">
			<span className="activity-icon">
				<Icon name={ACTIVITY_ICONS[event.resourceType] ?? 'history'} size={16} />
			</span>
			<span className="feed-main">
				<span className="feed-title">
					{title === undefined ? <code className="truncate">{event.action}</code> : <span className="truncate">{title}</span>}
				</span>
				<span className="feed-meta">
					<span className="truncate">{event.resourceId ?? event.resourceType}</span>
				</span>
			</span>
			<span className="feed-side">
				<span>{fmtAgo(event.createdAt)}</span>
				<span className="truncate activity-actor">{event.principalLabel}</span>
			</span>
		</div>
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
					<code>{shortRef(run.ref)}</code>
					{run.commitSha !== null && run.commitSha !== '' && <code>{shortSha(run.commitSha)}</code>}
				</span>
			</span>
			<span className="feed-side">
				<RunStatus status={run.status} />
				<span>{live ? fmtAgo(run.startedAt ?? run.createdAt) : fmtAgo(run.finishedAt ?? run.createdAt)}</span>
			</span>
		</Link>
	)
}

function FailedRunRow({ run }: { run: RunDto }) {
	return (
		<Link to="runs/detail" params={{ id: run.id }} className="feed-row">
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
				<span>{fmtAgo(run.finishedAt ?? run.createdAt)}</span>
			</span>
		</Link>
	)
}

function BrokenNamespaceRow({ namespace }: { namespace: DeploymentNamespaceDto }) {
	return (
		<Link to="namespaces/detail" params={{ id: namespace.id }} className="feed-row">
			<StatusLamp lamp={namespaceLamp(namespace.state)} />
			<span className="feed-main">
				<span className="feed-title">
					<span className="truncate">{namespace.id}</span>
					<Chip>{namespace.env}</Chip>
				</span>
				<span className="feed-meta">
					<span className="truncate">{namespace.lastError ?? 'Placement failed. Reconcile it.'}</span>
				</span>
			</span>
		</Link>
	)
}

/** Where an environment answers: its configured public origin, else its domain. */
function envUrl(env: AppEnvDto): string | null {
	if (env.publicOrigin !== null) return env.publicOrigin
	return env.domain === null ? null : `https://${env.domain}`
}

function AppsTable({ apps, environments, runs }: { apps: AppDto[]; environments: Map<string, AppEnvDto[]>; runs: RunDto[] }) {
	const shown = apps.slice(0, APP_TABLE_LIMIT)
	return (
		<section className="overview-panel overview-apps">
			<div className="panel-head">
				<h2>Your applications</h2>
				<span className="spacer" />
				<Link to="apps" className="panel-link">View all</Link>
			</div>
			<div className="table-wrap bare">
				<table aria-label="Applications">
					<thead>
						<tr>
							<th>Name</th>
							<th>Environments</th>
							<th>Last deploy</th>
							<th className="grow">URL</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((app) => {
							const envs = environments.get(app.id) ?? []
							const last = runs.find((run) => run.appId === app.id)
							const preferred = envs.find((env) => env.env === 'prod') ?? envs[0]
							const url = preferred === undefined ? null : envUrl(preferred)
							return (
								<tr key={app.id}>
									<td className="nowrap">
										<Link to="apps/detail" params={{ id: app.id }} className="app-name">
											<Icon name="app" size={16} />
											{app.id}
										</Link>
									</td>
									<td>
										<span className="chip-row">
											{envs.length === 0 ? <span className="muted">none</span> : envs.map((env) => <Chip key={env.env}>{env.env}</Chip>)}
										</span>
									</td>
									<td className="nowrap">
										{last === undefined
											? <span className="muted">never</span>
											: (
												<Link to="runs/detail" params={{ id: last.id }} className="last-deploy">
													<RunStatus status={last.status} />
													<span className="muted">{fmtAgo(last.finishedAt ?? last.createdAt)}</span>
												</Link>
											)}
									</td>
									<td>
										{url === null ? <span className="muted">no address</span> : (
											<a href={url} target="_blank" rel="noreferrer" className="external-url">
												<code className="truncate">{url.replace(/^https?:\/\//, '')}</code>
												<Icon name="external" size={13} />
											</a>
										)}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
		</section>
	)
}

/**
 * A fresh installation: the welcome from the mockups, then the bring-up order. Shown only until the first
 * application is registered; after that the overview starts with its readings.
 */
function Welcome({ namespaces }: { namespaces: DeploymentNamespaceDto[] }) {
	const hasNamespace = namespaces.length > 0
	return (
		<>
			<section className="welcome">
				<div className="welcome-copy">
					<p className="welcome-eyebrow">fabrika console</p>
					<h1>
						Build.<br />Run.<br />Scale.
					</h1>
					<p>
						fabrika takes an application from a git push to a running service behind one gate, and keeps watch on it afterwards. Two steps put the first
						release through it.
					</p>
					<div className="welcome-actions">
						{hasNamespace
							? (
								<Link to="apps/new" className="btn primary">
									<Icon name="plus" />
									New application
								</Link>
							)
							: (
								<Link to="namespaces/create" className="btn primary">
									<Icon name="plus" />
									Provision a namespace
								</Link>
							)}
					</div>
				</div>
				<div className="welcome-art" aria-hidden="true">
					<BrandMark size={220} />
				</div>
			</section>

			<div className="welcome-steps">
				<section className="card">
					<div className="card-head">
						{hasNamespace ? <StatusLamp lamp="ok" /> : <Icon name="bay" size={18} />}
						<h2>1 · Open a namespace</h2>
					</div>
					<div className="card-body">
						<p className="hint">
							A deployment namespace is the bounded area on the provider where apps get placed. Provision one per environment before onboarding anything into
							it.
						</p>
						<div className="form-actions">
							{hasNamespace
								? <Link to="namespaces" className="btn">See namespaces</Link>
								: (
									<Link to="namespaces/create" className="btn">
										<Icon name="plus" />
										Provision a namespace
									</Link>
								)}
						</div>
					</div>
				</section>
				<section className="card">
					<div className="card-head">
						<Icon name="app" size={18} />
						<h2>2 · Onboard an app</h2>
					</div>
					<div className="card-body">
						<p className="hint">Point fabrika at a GitHub repo, pick the namespace it deploys into, and let its first push deploy it.</p>
						<div className="form-actions">
							<Link to="apps/new" className="btn">
								<Icon name="plus" />
								Onboard an app
							</Link>
						</div>
					</div>
				</section>
			</div>
		</>
	)
}
