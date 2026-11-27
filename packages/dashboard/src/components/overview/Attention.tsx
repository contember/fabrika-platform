import { Link } from '@buzola/router'
import { type ReactNode, useState } from 'react'
import { waitingDeploySummary } from '../../lib/access-changes'
import { type EnvironmentState, needsDataAttention, stateLabel, stateLamp } from '../../lib/environment-state'
import { fmtAgo, fmtDate } from '../../lib/format'
import { runtimeHealth, unhealthyTelemetry } from '../../lib/health'
import {
	boundedCount,
	expiringKey,
	isProduction,
	missingSecrets,
	OVERVIEW_APP_LIMIT,
	OVERVIEW_ISSUE_LIMIT,
	OVERVIEW_KEY_LIMIT,
	type OverviewData,
	overviewEnvironments,
} from '../../lib/overview'
import { environmentStateOf } from '../app/AppFrame'
import { FilterGroup } from '../FilterGroup'
import { Icon } from '../Icon'
import { type Lamp, StatusLamp } from '../Status'
import { Panel } from './Panel'

type Destination =
	| { to: 'operations/sources/detail'; params: { sourceId: string } }
	| { to: 'operations/errors/detail'; params: { issueId: string } }
	| { to: 'approvals/detail' | 'runs/detail' | 'namespaces/detail' | 'access/credentials/keys/detail'; params: { id: string } }
	| { to: 'mail'; params: { state: string } }
	| { to: 'apps/data'; params: { id: string; env: string } }
	| { to: 'apps/secrets'; params: { id: string } }

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
		case 'apps/data':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
		case 'apps/secrets':
			return <Link to={target.to} params={target.params} className={className}>{children}</Link>
	}
}

/** Why an environment's data needs a person, for the states `needsDataAttention` names. */
function dataAttentionContext(state: EnvironmentState): string {
	switch (state.kind) {
		case 'boot-failure':
			return 'The application failed to boot'
		case 'mode':
			return 'Maintenance is on'
		case 'operation':
			return state.operation.state === 'running' ? 'A data operation is running' : 'A data operation failed and waits for recovery'
		default:
			return stateLabel(state)
	}
}

/** When the state began, in epoch seconds, where it says. */
function dataAttentionTime(state: EnvironmentState): number | null {
	if (state.kind === 'boot-failure') return Date.parse(state.at) / 1000
	if (state.kind === 'operation') return state.operation.updatedAt
	return null
}

function attentionItems(data: OverviewData, states: ReadonlyMap<string, EnvironmentState>): AttentionItem[] {
	const items: AttentionItem[] = []
	for (const env of overviewEnvironments(data)) {
		const state = environmentStateOf(states, env)
		if (!needsDataAttention(state)) continue
		const running = state.kind === 'operation' && state.operation.state === 'running'
		items.push({
			id: `data:${env.appId}:${env.env}`,
			kind: 'operations',
			lamp: stateLamp(state),
			title: `${env.appId} / ${env.env}: ${stateLabel(state)}`,
			context: dataAttentionContext(state),
			time: dataAttentionTime(state),
			action: 'Open data',
			target: { to: 'apps/data', params: { id: env.appId, env: env.env } },
			// A production boot failure is an outage, as a failed production check is; a running operation only asks to wait.
			priority: running ? 3 : !isProduction(env.env) ? 2 : state.kind === 'boot-failure' ? 0 : 1,
		})
	}
	for (const { env, names } of missingSecrets(data)) {
		const shown = names.slice(0, 3).join(', ')
		items.push({
			id: `secrets:${env.appId}:${env.env}`,
			kind: 'delivery',
			lamp: 'run',
			title: `${env.appId} / ${env.env}: ${names.length === 1 ? '1 secret' : `${names.length} secrets`} missing`,
			context: `${names.length > 3 ? `${shown} and ${names.length - 3} more` : shown} ${
				names.length === 1 ? 'is' : 'are'
			} set on another environment, not on ${env.env}`,
			time: null,
			action: 'Set secrets',
			target: { to: 'apps/secrets', params: { id: env.appId } },
			// A deploy that needs a missing secret fails before anything changes, so it waits for the next deploy, not an outage.
			priority: isProduction(env.env) ? 2 : 3,
		})
	}
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
			context: `${approval.run.appId} / ${approval.run.env} · ${waitingDeploySummary(approval)}`,
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
			id: `key:${key.principalId}`,
			kind: 'access',
			lamp: 'run',
			title: `${expiry.kind} ${expiry.expiresAt <= data.loadedAt / 1000 ? 'has expired' : 'expires within 7 days'}`,
			context: `${key.label} · ${fmtDate(expiry.expiresAt)}`,
			time: null,
			action: 'View key',
			target: { to: 'access/credentials/keys/detail', params: { id: key.principalId } },
			priority: 3,
		})
	}
	return items.sort((left, right) => left.priority - right.priority || (right.time ?? 0) - (left.time ?? 0))
}

/** `states` holds each environment's data state, keyed by `environmentKey` (`useEnvironmentStatesAcross`). */
export function Attention({ data, states }: { data: OverviewData; states: ReadonlyMap<string, EnvironmentState> }) {
	const [filter, setFilter] = useState<'all' | Kind>('all')
	const [expanded, setExpanded] = useState(false)
	const items = attentionItems(data, states)
	const matching = items.filter((item) => filter === 'all' || item.kind === filter)
	const visible = expanded ? matching : matching.slice(0, 8)
	const unavailable =
		[data.health, data.issues, data.approvals, data.failures, data.namespaces, data.mailHeld, data.mailFailed, data.keys, ...data.secrets.values()]
			.some((read) => read.problem === 'unavailable')
		|| [...states.values()].some((state) => state.kind === 'unknown' && state.reason === 'unavailable')
	const checking = [...states.values()].some((state) => state.kind === 'reading')
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
						{checking
							? 'Checking environment states…'
							: unavailable
							? 'No items in the available data. Some checks could not be read.'
							: 'No attention items in the visible data.'}
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
			{(data.apps.data?.items.length ?? 0) > OVERVIEW_APP_LIMIT && (
				<p className="ov-section-note">
					Data state and missing secret checks cover the first {OVERVIEW_APP_LIMIT} applications. <Link to="apps">View all applications</Link>
				</p>
			)}
			{data.keys.data?.limited && (
				<p className="ov-section-note">
					Expiry checks cover the latest {OVERVIEW_KEY_LIMIT} API keys. <Link to="access/credentials">View all credentials</Link>
				</p>
			)}
		</Panel>
	)
}
