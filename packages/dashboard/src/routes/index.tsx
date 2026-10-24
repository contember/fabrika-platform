import { createPage, Link } from '@buzola/router'
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { InFlight, RecentChanges } from '../components/overview/Activity'
import { Applications } from '../components/overview/Applications'
import { Attention } from '../components/overview/Attention'
import { Trends } from '../components/overview/Trends'
import { Welcome } from '../components/overview/Welcome'
import { Reading } from '../components/Reading'
import { Status } from '../components/Status'
import { mayOpen } from '../lib/console-access'
import { boundedCount, loadOverview, type OverviewData, type OverviewRead, productionHealth } from '../lib/overview'
import { consoleSession } from '../lib/session'

export default createPage()
	.loader(async () => loadOverview(await consoleSession()))
	.route('/')
	.render(({ data, invalidate }) => <Overview data={data} refresh={invalidate} />)

export function Overview({ data, refresh }: { data: OverviewData; refresh: () => void | Promise<unknown> }) {
	const [refreshing, setRefreshing] = useState(false)
	useEffect(() => {
		setRefreshing(false)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, 60_000)
		return () => window.clearInterval(timer)
	}, [data.loadedAt, refresh])
	const notices = readNotices(data)
	return (
		<div className="overview">
			<header className="ov-page-head">
				<div>
					<h1>Overview</h1>
					<p className="hint">The state of your applications, and what needs you next.</p>
				</div>
				<div className="ov-head-actions">
					<span className="ov-updated" role="status">
						{refreshing ? 'Refreshing…' : `Snapshot · ${new Date(data.loadedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}
					</span>
					<button
						type="button"
						className="btn ghost icon-btn"
						aria-label="Refresh overview"
						disabled={refreshing}
						onClick={() => {
							setRefreshing(true)
							void refresh()
						}}
					>
						<Icon name="refresh" />
					</button>
					{data.apps.data?.items.length !== 0 && (
						<Link to="apps/new" className="btn primary">
							<Icon name="plus" size={15} />New application
						</Link>
					)}
				</div>
			</header>
			{notices.length > 0 && <p className="ov-read-notices" role="status">{notices.join(' · ')}. Other sections show their available data.</p>}
			<Readings data={data} />
			<Attention data={data} />
			{data.apps.data?.items.length === 0 ? <Welcome hasNamespace={(data.namespaces.data?.items.length ?? 0) > 0} /> : <Applications data={data} />}
			<div className="ov-pair">
				<InFlight data={data} />
				<RecentChanges data={data} />
			</div>
			<Trends data={data} />
			<footer className="ov-page-foot">
				<Link to="namespaces">
					{data.namespaces.data === null
						? 'Namespaces not readable'
						: `${
							data.namespaces.data.items.filter((namespace) => namespace.state === 'ready').length
						} of ${data.namespaces.data.items.length} namespaces ready`}
				</Link>
				<span>Refreshes every minute while visible · Times are local</span>
			</footer>
		</div>
	)
}

function unavailableValue(read: OverviewRead<unknown>) {
	return <small>{read.problem === 'forbidden' ? 'No access' : 'Unknown'}</small>
}

function Readings({ data }: { data: OverviewData }) {
	const production = productionHealth(data)
	const issues = data.issues.data
	const inFlight = data.activeRuns.data?.items.length ?? 0
	const awaiting = data.approvals.data?.items.length
	const held = data.mailHeld.data
	const failed = data.mailFailed.data
	const mailKnown = held !== null && failed !== null
	const issueRegressions = issues?.items.filter((issue) => issue.regressedAt !== null).length ?? 0
	return (
		<section className="instrument-cluster readings ov-readings" aria-label="Installation at a glance">
			{data.health.data === null
				? (
					<div className="instrument">
						<Reading label="Production incidents" value={unavailableValue(data.health)} note="HTTP health not readable" />
					</div>
				)
				: (
					<Link to="operations/health" className="instrument">
						<Reading
							label="Production incidents"
							value={production.incidents}
							note={<Status lamp={production.incidents > 0 ? 'stop' : 'idle'}>{production.monitored} visible environments monitored</Status>}
						/>
					</Link>
				)}
			{issues === null
				? (
					<div className="instrument">
						<Reading label="Open errors" value={unavailableValue(data.issues)} note="Error data not readable" />
					</div>
				)
				: (
					<Link to="operations/errors" params={{ window: 'all' }} className="instrument">
						<Reading
							label="Open errors"
							value={issues.summary.open}
							note={
								<Status lamp={issueRegressions > 0 ? 'stop' : 'idle'}>
									{boundedCount(issueRegressions, issues.nextCursor !== null)}{' '}
									{issueRegressions === 1 && issues.nextCursor === null ? 'regression' : 'regressions'} · visible sources
								</Status>
							}
						/>
					</Link>
				)}
			<Link to="runs" className="instrument">
				<Reading
					label="In flight"
					value={data.activeRuns.data === null ? unavailableValue(data.activeRuns) : boundedCount(inFlight, data.activeRuns.data.nextCursor !== null)}
					note={awaiting === undefined
						? 'Approval count not readable'
						: <Status lamp={awaiting > 0 ? 'run' : 'idle'}>{awaiting} more {awaiting === 1 ? 'awaits' : 'await'} your approval</Status>}
				/>
			</Link>
			{!mailKnown
				? (
					<div className="instrument">
						<Reading
							label="Mail to review"
							value={data.mailHeld.problem === 'forbidden' && mayOpen(data.caller, 'mail')
								? <small>Scoped access</small>
								: unavailableValue(data.mailHeld.data === null ? data.mailHeld : data.mailFailed)}
							note={data.mailHeld.problem === 'forbidden' || data.mailFailed.problem === 'forbidden'
								? mayOpen(data.caller, 'mail') ? <Link to="mail">Choose a sender in Mail</Link> : 'Needs mail access'
								: 'Mail data could not be loaded'}
						/>
					</div>
				)
				: (
					<Link to="mail" className="instrument">
						<Reading
							label="Mail to review"
							value={boundedCount(held.items.length + failed.items.length, held.nextCursor !== null || failed.nextCursor !== null)}
							note={`${boundedCount(held.items.length, held.nextCursor !== null)} held · ${
								boundedCount(failed.items.length, failed.nextCursor !== null)
							} failed to send`}
						/>
					</Link>
				)}
		</section>
	)
}

function readNotices(data: OverviewData): string[] {
	const reads: [string, OverviewRead<unknown>][] = [
		['Applications', data.apps],
		['Namespaces', data.namespaces],
		['Deploys', data.runs],
		['Active deploys', data.activeRuns],
		['Failed deploys', data.failures],
		['Approvals', data.approvals],
		['Health', data.health],
		['Errors', data.issues],
		['Held mail', data.mailHeld],
		['Failed mail', data.mailFailed],
		['Credentials', data.keys],
		['Access audit', data.audit],
	]
	return reads.filter(([, read]) => read.problem === 'unavailable').map(([label]) => `${label} unavailable`)
}
