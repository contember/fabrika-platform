import { Link } from '@buzola/router'
import type { AuditEventDto, AuthLogDto, CursorList, PrincipalDetail, PrincipalListItem } from '@fabrika/iam-contract'
import { Status } from '../../../components/Status'
import { EmptyState } from '../../../components/Table'
import { fmtDate } from '../../../lib/format'
import { AppName } from '../../lib/app-names'
import { auditActor } from '../../lib/audit-actors'
import { auditActionLabel } from '../../lib/audit-labels'
import { JsonView } from '../JsonView'

export function UserActivity({ principal, mode, audit, authLog, actors, before }: {
	principal: PrincipalDetail
	mode: string
	audit: CursorList<AuditEventDto> | null
	authLog: CursorList<AuthLogDto> | null
	actors: ReadonlyMap<string, PrincipalListItem>
	before: string | undefined
}) {
	if (!principal.management.audit) {
		return (
			<EmptyState
				title="Activity is available to installation administrators"
				body="Your role lets you manage users. Reading the installation’s audit history requires an installation administrator."
			/>
		)
	}
	const nextCursor = audit?.nextCursor ?? authLog?.nextCursor
	return (
		<section>
			<div className="section-head">
				<h2>Activity</h2>
				<span className="spacer" />
				{mode === 'sign-ins'
					? <Link to="access/audit/auth-log" params={{ principalId: principal.id }} className="btn small">Open sign-in log</Link>
					: (
						<Link
							to="access/audit"
							params={mode === 'changes' ? { subjectPrincipalId: principal.id } : { principalId: principal.id }}
							className="btn small"
						>
							Open audit log
						</Link>
					)}
			</div>
			<nav className="user-activity-filters" aria-label="Activity type">
				{[{ id: 'changes', label: 'Changes to this person' }, { id: 'sign-ins', label: 'Sign-in decisions' }, {
					id: 'by-user',
					label: 'Actions by this person',
				}].map((option) => (
					<Link
						key={option.id}
						to="access/users/detail"
						params={{ id: principal.id, tab: 'activity', activity: option.id }}
						aria-current={mode === option.id ? 'page' : undefined}
					>
						{option.label}
					</Link>
				))}
			</nav>
			<p className="section-note">
				{mode === 'changes'
					? 'Changes to this account and its access, including changes made by other people.'
					: mode === 'sign-ins'
					? 'Recorded sign-ins, token checks and sign-outs. Anonymous failed attempts cannot be attributed to a person.'
					: 'Audit events where this person is the actor, including administration requests.'}
			</p>
			{(audit?.items.length ?? authLog?.items.length ?? 0) === 0 && (
				<EmptyState title="No events in the retained history" body="History is subject to the installation’s retention settings." />
			)}
			<ol className="user-timeline">
				{audit?.items.map((event) => {
					const actor = auditActor(event, actors)
					return (
						<li key={event.id}>
							<time dateTime={new Date(event.createdAt * 1000).toISOString()}>{fmtDate(event.createdAt)}</time>
							<div>
								<strong>{auditActionLabel(event.action)}</strong>
								<p className="muted small">
									{actor.kind === 'principal' && actor.isUser
										? <Link to="access/users/detail" params={{ id: actor.principalId }}>{actor.label}</Link>
										: actor.kind === 'credential'
										? `Credential ${actor.credentialId}`
										: actor.label} · <AppName app={event.app} />
								</p>
								<details>
									<summary>Event details</summary>
									<p className="muted small">{event.action} · {event.resourceType} {event.resourceId}</p>
									{event.diff !== null && <JsonView value={event.diff} />}
									{event.metadata !== null && <JsonView value={event.metadata} />}
								</details>
							</div>
						</li>
					)
				})}
				{authLog?.items.map((event) => (
					<li key={event.id}>
						<time dateTime={new Date(event.createdAt * 1000).toISOString()}>{fmtDate(event.createdAt)}</time>
						<div>
							<Status lamp={event.decision === 'deny' ? 'stop' : 'ok'}>
								{event.kind === 'logout' ? 'Signed out' : event.decision === 'deny' ? 'Sign-in or token check refused' : 'Sign-in or token check allowed'}
							</Status>
							<p className="muted small">
								<AppName app={event.app} />
								{event.reason && <>· {event.reason.replaceAll('_', ' ')}</>}
							</p>
						</div>
					</li>
				))}
			</ol>
			<div className="pager">
				{before && <Link to="access/users/detail" params={{ id: principal.id, tab: 'activity', activity: mode }} className="btn">Latest events</Link>}
				<span className="pull" />
				{nextCursor && (
					<Link to="access/users/detail" params={{ id: principal.id, tab: 'activity', activity: mode, before: nextCursor }} className="btn">
						Older events
					</Link>
				)}
			</div>
		</section>
	)
}
