import { Link } from '@buzola/router'
import { type ReactNode, useState } from 'react'
import { fmtAgo, fmtDate } from '../../lib/format'
import { runtimeHealth, unhealthyTelemetry } from '../../lib/health'
import { boundedCount, expiringKey, isProduction, OVERVIEW_ISSUE_LIMIT, OVERVIEW_KEY_LIMIT, type OverviewData } from '../../lib/overview'
import { FilterGroup } from '../FilterGroup'
import { Icon } from '../Icon'
import { type Lamp, StatusLamp } from '../Status'
import { Panel } from './Panel'

type Destination =
	| { to: 'operations/sources/detail'; params: { sourceId: string } }
	| { to: 'operations/errors/detail'; params: { issueId: string } }
	| { to: 'approvals/detail' | 'runs/detail' | 'namespaces/detail' | 'access/credentials/keys/detail'; params: { id: string } }
	| { to: 'mail'; params: { state: string } }

type Kind = 'operations' | 'delivery' | 'mail' | 'access'
interface AttentionItem {
	id: string
	kind: Kind
	lamp: Lamp
	title: string
	context: string
	time: number | null
	action: string
	target: Destination
	priority: number
}

const FILTERS: { value: 'all' | Kind; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'operations', label: 'Operations' },
	{ value: 'delivery', label: 'Delivery' },
	{ value: 'mail', label: 'Mail' },
	{ value: 'access', label: 'Access' },
]

function TargetLink({ target, children, className }: { target: Destination; children: ReactNode; className?: string }) {
	switch (target.to) {
		case 'operations/sources/detail':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
		case 'operations/errors/detail':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
		case 'approvals/detail':
		case 'runs/detail':
		case 'namespaces/detail':
		case 'access/credentials/keys/detail':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
		case 'mail':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
	}
}

function attentionItems(data: OverviewData): AttentionItem[] {
	const items: AttentionItem[] = []
	for (const source of data.health.data?.sources ?? []) {
		if (!source.source.enabled) continue
		const health = runtimeHealth([source], data.loadedAt)
		if (health.state === 'failed' || health.state === 'degraded') {
			items.push({
				id: `health:${source.source.id}`,
				kind: 'operations',
				lamp: health.lamp,
				title: `${source.source.displayName} is ${health.label.toLowerCase()}`,
				context: `${source.source.appId} / ${source.source.environment} · ${health.note}`,
				time: null,
				action: 'Investigate',
				target: { to: 'operations/sources/detail', params: { sourceId: source.source.id } },
				priority: isProduction(source.source.environment) ? 0 : 2,
			})
		}
		if (unhealthyTelemetry(source) || health.state === 'stale' || health.state === 'unavailable') {
			items.push({
				id: `telemetry:${source.source.id}`,
				kind: 'operations',
				lamp: 'idle',
				title: `${source.source.displayName}: monitoring needs attention`,
				context: `${source.source.environment} · ${unhealthyTelemetry(source) ? `Telemetry ${source.telemetryState}` : health.note}`,
				time: null,
				action: 'Check monitoring',
				target: { to: 'operations/sources/detail', params: { sourceId: source.source.id } },
				priority: 5,
			})
		}
	}
	for (const issue of data.issues.data?.items ?? []) {
		items.push({
			id: `issue:${issue.id}`,
			kind: 'operations',
			lamp: 'stop',
			title: issue.title,
			context: `${issue.source.appId} / ${issue.source.environment} · ${issue.regressedAt === null ? 'Open error' : 'Regression'}`,
			time: issue.lastSeen / 1000,
			action: 'View error',
			target: { to: 'operations/errors/detail', params: { issueId: issue.id } },
			priority: issue.regressedAt !== null ? 1 : 4,
		})
	}
	for (const approval of data.approvals.data?.items ?? []) {
		items.push({
			id: `approval:${approval.run.id}`,
			kind: 'delivery',
			lamp: 'run',
			title: 'A deploy needs your approval',
			context: `${approval.run.appId} / ${approval.run.env} · ${
				approval.changes.find((change) => change.effect === 'widens')?.line ?? 'Access change awaiting review'
			}`,
			time: approval.run.startedAt ?? approval.run.createdAt,
			action: 'Review change',
			target: { to: 'approvals/detail', params: { id: approval.run.id } },
			priority: 2,
		})
	}
	for (const run of data.failures.data?.items ?? []) {
		items.push({
			id: `run:${run.id}`,
			kind: 'delivery',
			lamp: 'stop',
			title: `${run.appId} failed to deploy`,
			context: `${run.env} · Latest finished deploy failed`,
			time: run.finishedAt ?? run.createdAt,
			action: 'View logs',
			target: { to: 'runs/detail', params: { id: run.id } },
			priority: 2,
		})
	}
	for (const namespace of data.namespaces.data?.items ?? []) {
		if (namespace.state !== 'failed') continue
		items.push({
			id: `namespace:${namespace.id}`,
			kind: 'delivery',
			lamp: 'stop',
			title: `${namespace.id} needs repair`,
			context: namespace.lastError ?? 'Namespace provisioning failed',
			time: null,
			action: 'View namespace',
			target: { to: 'namespaces/detail', params: { id: namespace.id } },
			priority: 1,
		})
	}
	for (const state of ['held', 'failed'] satisfies ('held' | 'failed')[]) {
		const page = state === 'held' ? data.mailHeld.data : data.mailFailed.data
		if (page === null || page.items.length === 0) continue
		items.push({
			id: `mail:${state}`,
			kind: 'mail',
			lamp: state === 'failed' ? 'stop' : 'run',
			title: `${boundedCount(page.items.length, page.nextCursor !== null)} ${page.items.length === 1 && page.nextCursor === null ? 'email' : 'emails'} ${
				state === 'held' ? 'held for review' : 'failed to send'
			}`,
			context: state === 'held' ? 'Held messages need a decision before sending' : 'Review delivery failures in the mail relay',
			time: null,
			action: 'Review mail',
			target: { to: 'mail', params: { state } },
			priority: 3,
		})
	}
	for (const key of data.keys.data?.items ?? []) {
		const expiry = expiringKey(key, data.loadedAt / 1000)
		if (expiry === null) continue
		items.push({
			id: `key:${key.key.principalId}`,
			kind: 'access',
			lamp: 'run',
			title: `${expiry.kind} ${expiry.expiresAt <= data.loadedAt / 1000 ? 'has expired' : 'expires within 7 days'}`,
			context: `${key.key.label} · ${fmtDate(expiry.expiresAt)}`,
			time: null,
			action: 'View key',
			target: { to: 'access/credentials/keys/detail', params: { id: key.key.principalId } },
			priority: 3,
		})
	}
	return items.sort((left, right) => left.priority - right.priority || (right.time ?? 0) - (left.time ?? 0))
}

export function Attention({ data }: { data: OverviewData }) {
	const [filter, setFilter] = useState<'all' | Kind>('all')
	const [expanded, setExpanded] = useState(false)
	const items = attentionItems(data)
	const matching = items.filter((item) => filter === 'all' || item.kind === filter)
	const visible = expanded ? matching : matching.slice(0, 8)
	const unavailable = [data.health, data.issues, data.approvals, data.failures, data.namespaces, data.mailHeld, data.mailFailed, data.keys]
		.some((read) => read.problem === 'unavailable')
	return (
		<Panel title="Needs attention" meta={<span className="ov-section-note">Prioritized by impact</span>}>
			<FilterGroup
				label="Filter attention items"
				className="ov-filter-row"
				options={FILTERS.map((option) => ({ ...option, count: items.filter((item) => option.value === 'all' || item.kind === option.value).length }))}
				value={filter}
				onChange={(value) => {
					setFilter(value)
					setExpanded(false)
				}}
			/>
			<div className="ov-attention-list">
				{visible.map((item) => (
					<div className="ov-attention-row" key={item.id}>
						<div className="ov-row-lamp">
							<StatusLamp lamp={item.lamp} />
						</div>
						<div>
							<div className="ov-attention-title">
								<TargetLink target={item.target}>{item.title}</TargetLink>
							</div>
							<div className="ov-row-context">{item.context}</div>
						</div>
						<time className="ov-time" title={item.time === null ? undefined : fmtDate(item.time)}>
							{item.time === null ? '' : fmtAgo(item.time, data.loadedAt)}
						</time>
						<TargetLink target={item.target} className="ov-row-action">
							{item.action}
							<Icon name="arrow-right" size={15} />
						</TargetLink>
					</div>
				))}
				{visible.length === 0 && (
					<p className="ov-empty">
						{unavailable ? 'No items in the available data. Some checks could not be read.' : 'No attention items in the visible data.'}
					</p>
				)}
			</div>
			{matching.length > visible.length && (
				<button type="button" className="btn ghost" onClick={() => setExpanded(true)}>Show all {matching.length} items</button>
			)}
			{data.issues.data?.nextCursor != null && (
				<p className="ov-section-note">
					Showing the {OVERVIEW_ISSUE_LIMIT} most recently seen open errors. <Link to="operations/errors" params={{ window: 'all' }}>View all errors</Link>
				</p>
			)}
			{data.keys.data?.limited && (
				<p className="ov-section-note">
					Expiry checks cover the latest {OVERVIEW_KEY_LIMIT} API keys. <Link to="access/credentials">View all credentials</Link>
				</p>
			)}
			{data.keys.data?.items.some((item) => item.detail.problem !== null) && <p className="ov-section-note">Some key expiry dates could not be read.</p>}
		</Panel>
	)
}
