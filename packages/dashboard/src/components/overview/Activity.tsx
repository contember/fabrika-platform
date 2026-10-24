import { Link } from '@buzola/router'
import { type ReactNode } from 'react'
import { mayOpen } from '../../lib/console-access'
import { fmtAgo, fmtDuration, shortRef, shortSha } from '../../lib/format'
import { boundedCount, type OverviewData } from '../../lib/overview'
import { Icon, type IconName } from '../Icon'
import { Chip, RunStatus } from '../Status'
import { Panel } from './Panel'

export function InFlight({ data }: { data: OverviewData }) {
	const runs = data.activeRuns.data?.items ?? []
	const awaiting = data.approvals.data?.items.length
	return (
		<Panel
			title="In flight"
			meta={
				<span className="ov-count">
					{data.activeRuns.data === null ? 'Unknown' : boundedCount(runs.length, data.activeRuns.data.nextCursor !== null)}
				</span>
			}
			aside={<Link to="runs">All deploys →</Link>}
		>
			{runs.slice(0, 6).map((run) => (
				<div className="ov-deploy" key={run.id}>
					<div className="ov-deploy-title">
						<strong>{run.appId}</strong>
						<Chip>{run.env}</Chip>
						<span className="spacer" />
						<RunStatus status={run.status} />
					</div>
					<div className="ov-deploy-ref">
						<Icon name="branch" size={14} />
						<span className="truncate">{shortRef(run.ref)}</span>
						{run.commitSha && <code>{shortSha(run.commitSha)}</code>}
						<span className="spacer" />
						{fmtDuration(run.startedAt ?? run.createdAt, Math.floor(data.loadedAt / 1000))}
					</div>
					<div className="ov-deploy-bottom">
						<span>{run.status === 'running' ? 'Deploy in progress' : 'Waiting to start'}</span>
						<Link to="runs/detail" params={{ id: run.id }}>View run →</Link>
					</div>
				</div>
			))}
			{runs.length === 0 && (
				<p className="ov-empty">{data.activeRuns.data === null ? 'Deploys could not be read.' : 'No deploys are running or queued.'}</p>
			)}
			{(runs.length > 6 || data.activeRuns.data?.nextCursor != null) && (
				<p className="ov-section-note">
					Showing the latest 6 active deploys. <Link to="runs">View all runs</Link>
				</p>
			)}
			{awaiting !== undefined && awaiting > 0 && (
				<div className="ov-approval-foot">
					<Icon name="shield" size={15} />
					<span>{awaiting} other {awaiting === 1 ? 'deploy awaits' : 'deploys await'} your approval</span>
					<Link to="approvals">Review →</Link>
				</div>
			)}
		</Panel>
	)
}

const AUDIT_TITLES: Record<string, string> = {
	'iam.principal.invite': 'User invited',
	'iam.principal.create': 'Principal created',
	'iam.principal.enable': 'User enabled',
	'iam.principal.disable': 'User disabled',
	'iam.principal.promote': 'User promoted',
	'iam.grant.create': 'Role granted',
	'iam.grant.revoke': 'Role revoked',
	'iam.apikey.create': 'API key issued',
	'iam.apikey.rotate': 'API key rotated',
	'iam.apikey.revoke': 'API key revoked',
	'iam.member.accept': 'Invitation accepted',
	'iam.member.assign': 'Member assigned',
	'iam.member.revoke': 'Member removed',
	'iam.password.enrollment.complete': 'Password set',
}

export function RecentChanges({ data }: { data: OverviewData }) {
	const changes: { id: string; time: number; icon: IconName; title: ReactNode; note: string }[] = []
	for (const run of data.runs.data?.items ?? []) {
		if (run.status !== 'succeeded' && run.status !== 'failed') continue
		changes.push({
			id: `run:${run.id}`,
			time: run.finishedAt ?? run.createdAt,
			icon: 'commit',
			title: <Link to="runs/detail" params={{ id: run.id }}>{run.appId}: deploy {run.status}</Link>,
			note: `${run.env}${run.commitSha === null ? '' : ` · ${shortSha(run.commitSha)}`}`,
		})
	}
	for (const issue of data.issues.data?.items ?? []) {
		if (issue.regressedAt === null) continue
		changes.push({
			id: `issue:${issue.id}`,
			time: issue.regressedAt / 1000,
			icon: 'alert',
			title: <Link to="operations/errors/detail" params={{ issueId: issue.id }}>An error returned: {issue.title}</Link>,
			note: `${issue.source.appId} / ${issue.source.environment}`,
		})
	}
	for (const event of data.audit.data?.items ?? []) {
		changes.push({
			id: `audit:${event.id}`,
			time: event.createdAt,
			icon: 'shield',
			title: <Link to="access/audit">{AUDIT_TITLES[event.action] ?? event.action}</Link>,
			note: `${event.principalLabel ?? 'Unknown actor'} · ${event.resourceId ?? event.resourceType}`,
		})
	}
	changes.sort((a, b) => b.time - a.time)
	return (
		<Panel title="Recent changes" aside={<span className="ov-section-note">Deploys, errors & access</span>}>
			<div>
				{changes.slice(0, 6).map((change) => (
					<div className="ov-change" key={change.id}>
						<span className="ov-change-icon">
							<Icon name={change.icon} size={16} />
						</span>
						<div>
							{change.title}
							<small>{change.note}</small>
						</div>
						<time>{fmtAgo(change.time, data.loadedAt)}</time>
					</div>
				))}
			</div>
			{changes.length === 0 && <p className="ov-empty">No changes in the available history.</p>}
			{data.audit.data?.limited && <p className="ov-section-note">The audit scan reached its limit; older access changes may be missing.</p>}
			<div className="ov-changes-foot">
				<Link to="runs">Deploy history →</Link>
				{mayOpen(data.caller, 'access/audit') && <Link to="access/audit">Access audit →</Link>}
			</div>
		</Panel>
	)
}
