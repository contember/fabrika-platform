import { createPage, Link, useNavigate } from '@buzola/router'
import type { AuditEventDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { JsonView } from '../../../access/components/JsonView'
import { api } from '../../../access/lib/api'
import { AppName } from '../../../access/lib/app-names'
import { actorIdsToResolve, type AuditActor, auditActor, resolveActors } from '../../../access/lib/audit-actors'
import { trimmedQueryValue } from '../../../access/lib/format'
import { Icon } from '../../../components/Icon'
import { QuerySearch } from '../../../components/QuerySearch'
import { EmptyState, Table } from '../../../components/Table'
import { fmtDate } from '../../../lib/format'
import type { QueryLanguage } from '../../../lib/query-search'

const LIMIT = 50

interface FilterParams {
	resourceType?: string
	resourceId?: string
	principalId?: string
	action?: string
	requestId?: string
}

export default createPage()
	.params({
		resourceType: '?string',
		resourceId: '?string',
		principalId: '?string',
		action: '?string',
		requestId: '?string',
		before: '?string',
	})
	.loader(async ({ params }) => {
		const page = await api.audit.list({
			resourceType: trimmedQueryValue(params.resourceType),
			resourceId: trimmedQueryValue(params.resourceId),
			principalId: trimmedQueryValue(params.principalId),
			action: trimmedQueryValue(params.action),
			requestId: trimmedQueryValue(params.requestId),
			before: trimmedQueryValue(params.before),
			limit: LIMIT,
		})
		const actors = await resolveActors(actorIdsToResolve(page.items), (principalId) => api.principals.get({ principalId }))
		return { page, actors }
	})
	.route('/access/audit')
	.render(({ params, data }) => {
		const navigate = useNavigate()
		const events = data.page.items
		const current: FilterParams = {
			resourceType: params.resourceType,
			resourceId: params.resourceId,
			principalId: params.principalId,
			action: params.action,
			requestId: params.requestId,
		}

		function applyFilters(next: FilterParams) {
			// Reset the cursor whenever filters change.
			navigate('access/audit', { params: { ...next, before: undefined }, replace: true })
		}

		function nextPage() {
			if (data.page.nextCursor === null) return
			navigate('access/audit', { params: { ...current, before: data.page.nextCursor } })
		}

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Audit</h1>
							<p className="hint">Every write the IAM service recorded, newest first. Read-only.</p>
						</div>
						{/* The other half of the trail: what a credential was ALLOWED to do, not what an admin changed. */}
						<Link to="access/audit/auth-log" className="btn">
							<Icon name="lock" size={14} />
							Sign-in decisions
						</Link>
					</div>
				</div>

				<QuerySearch
					id="audit-search"
					language={AUDIT_QUERY}
					label="Search the audit log"
					filters={current}
					onApply={(filters) => applyFilters(filters)}
					placeholder="action:iam.grant.create resource:…"
				/>

				<Table
					colSpan={6}
					isEmpty={events.length === 0}
					empty={<EmptyState title="No audit events match" body="Clear the filters, or widen the resource and action you are looking for." />}
					head={
						<tr>
							<th>When</th>
							<th>Actor</th>
							<th>App</th>
							<th>Action</th>
							<th className="grow">Resource</th>
							<th>Request</th>
						</tr>
					}
				>
					{events.map((event) => <AuditRow key={event.id} event={event} actor={auditActor(event, data.actors)} current={current} />)}
				</Table>

				<div className="pager">
					{params.before && <button type="button" onClick={() => applyFilters(current)}>First page</button>}
					<span className="pull" />
					<button type="button" onClick={nextPage} disabled={data.page.nextCursor === null}>
						Next page
					</button>
				</div>
			</>
		)
	})

/** IAM's five audit filters as the search field's qualifiers; the log has no text search. */
const AUDIT_QUERY: QueryLanguage<keyof FilterParams> = {
	qualifiers: [
		{ key: 'action', name: 'action' },
		{ key: 'resourceType', name: 'type', aliases: ['resource-type'] },
		{ key: 'resourceId', name: 'resource', aliases: ['resource-id'] },
		{ key: 'principalId', name: 'principal', aliases: ['principal-id', 'actor'] },
		{ key: 'requestId', name: 'request', aliases: ['request-id'] },
	],
	freeText: false,
}

/**
 * Who acted. Like every other value in the row, the name narrows the log to it (`principal:`); a person also has a
 * way to their page, beside the name, so the cell's main click does what the rest of the row does.
 */
export function ActorCell({ actor, current = {} }: { actor: AuditActor; current?: FilterParams }) {
	switch (actor.kind) {
		case 'credential':
			return (
				<span title={actor.credentialId}>
					credential <code className="small">{actor.credentialId}</code>
				</span>
			)
		case 'principal':
			return (
				<span className="linked-value">
					<Link
						to="access/audit"
						params={{ ...current, principalId: actor.principalId }}
						title={`Filter to ${actor.label} (${actor.principalId})`}
						className="filter-link"
					>
						<span>{actor.label}</span>
					</Link>
					{actor.isUser && (
						<Link
							to="access/users/detail"
							params={{ id: actor.principalId }}
							className="value-page"
							aria-label={`Open ${actor.label}`}
							title="Open this user"
						>
							<Icon name="arrow-right" size={12} />
						</Link>
					)}
				</span>
			)
		case 'label':
			return <>{actor.label}</>
	}
}

function AuditRow({ event, actor, current }: { event: AuditEventDto; actor: AuditActor; current: FilterParams }) {
	const [open, setOpen] = useState(false)
	const hasDetail = event.diff !== null && event.diff !== undefined
		|| event.metadata !== null && event.metadata !== undefined

	return (
		<>
			<tr>
				<td className="nowrap">{fmtDate(event.createdAt)}</td>
				<td>
					<ActorCell actor={actor} current={current} />
				</td>
				<td>
					<AppName app={event.app} />
				</td>
				<td>
					<Link to="access/audit" params={{ ...current, action: event.action }} title="Filter to this action" className="filter-link">
						<code>{event.action}</code>
					</Link>
				</td>
				<td>
					<Link to="access/audit" params={{ ...current, resourceType: event.resourceType }} title="Filter to this resource type" className="filter-link">
						<code>{event.resourceType}</code>
					</Link>
					{event.resourceId && (
						<>
							{' '}
							<Link
								to="access/audit"
								params={{ ...current, resourceType: event.resourceType, resourceId: event.resourceId }}
								title="Filter to this resource"
								className="filter-link"
							>
								<span className="muted">#{event.resourceId}</span>
							</Link>
						</>
					)}
				</td>
				<td className="nowrap">
					<Link to="access/audit" params={{ ...current, requestId: event.requestId }} title="Filter to this request" className="filter-link">
						<code className="small">{event.requestId.slice(0, 8)}</code>
					</Link>
					{hasDetail && (
						<button type="button" className="link-btn small" onClick={() => setOpen((v) => !v)}>
							{open ? 'hide' : 'detail'}
						</button>
					)}
				</td>
			</tr>
			{open && hasDetail && (
				<tr className="detail-row">
					<td colSpan={6}>
						<div className="detail-grid">
							<div>
								<h4>diff</h4>
								<JsonView value={event.diff} />
							</div>
							<div>
								<h4>metadata</h4>
								<JsonView value={event.metadata} />
							</div>
						</div>
					</td>
				</tr>
			)}
		</>
	)
}
