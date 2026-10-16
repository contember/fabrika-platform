import { createPage, Link, useNavigate } from '@buzola/router'
import { api } from '../../../access/lib/api'
import { AppName } from '../../../access/lib/app-names'
import { trimmedQueryValue } from '../../../access/lib/format'
import { Icon } from '../../../components/Icon'
import { QuerySearch } from '../../../components/QuerySearch'
import { Status } from '../../../components/Status'
import { EmptyState, Table } from '../../../components/Table'
import { fmtDate } from '../../../lib/format'
import type { QueryLanguage } from '../../../lib/query-search'

const LIMIT = 50

export default createPage()
	.params({
		principalId: '?string',
		requestId: '?string',
		decision: '?string',
		before: '?string',
	})
	.loader(async ({ params }) => {
		const decisionParam = trimmedQueryValue(params.decision)
		const decision = decisionParam === 'allow' || decisionParam === 'deny' ? decisionParam : undefined
		const page = await api.audit.listAuthLog({
			principalId: trimmedQueryValue(params.principalId),
			requestId: trimmedQueryValue(params.requestId),
			decision,
			before: trimmedQueryValue(params.before),
			limit: LIMIT,
		})
		return { page }
	})
	.route('/access/audit/auth-log')
	.render(({ params, data }) => {
		const navigate = useNavigate()
		const rows = data.page.items
		const current: AuthFilterParams = { principalId: params.principalId, requestId: params.requestId, decision: params.decision }

		function applyFilters(next: { principalId?: string; requestId?: string; decision?: string }) {
			navigate('access/audit/auth-log', {
				params: { ...next, before: undefined },
				replace: true,
			})
		}
		function nextPage() {
			if (data.page.nextCursor === null) return
			navigate('access/audit/auth-log', {
				params: {
					principalId: params.principalId,
					requestId: params.requestId,
					decision: params.decision,
					before: data.page.nextCursor,
				},
			})
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/audit" className="back-link">
						<Icon name="chevron-left" size={14} />
						Audit
					</Link>
					<h1>Sign-in decisions</h1>
					<p className="hint">
						Outcomes of <code>mintToken()</code> / <code>mintFromKey()</code> and the OIDC login. This is where you debug "login looks broken", e.g.{' '}
						<code>invalid_token</code>, <code>unknown_principal</code>, or <code>disabled</code>.
					</p>
				</div>

				<QuerySearch
					id="auth-log-search"
					language={AUTH_LOG_QUERY}
					label="Search sign-in decisions"
					filters={current}
					onApply={(filters) => applyFilters(filters)}
					placeholder="decision:deny principal:…"
				/>

				<Table
					colSpan={6}
					isEmpty={rows.length === 0}
					empty={<EmptyState title="No auth-log rows match" body="Clear the filters, or widen the principal and decision you are looking for." />}
					head={
						<tr>
							<th>When</th>
							<th>App</th>
							<th>Kind</th>
							<th>Principal / credential</th>
							<th>Decision</th>
							<th className="grow">Reason</th>
						</tr>
					}
				>
					{rows.map((row) => (
						<tr key={row.id}>
							<td className="nowrap">{fmtDate(row.createdAt)}</td>
							<td>
								<AppName app={row.app} />
							</td>
							<td>{row.kind}</td>
							<td>
								{row.credentialId
									? (
										<span title={row.credentialId}>
											credential <code className="small">{row.credentialId}</code>
										</span>
									)
									: row.principalId
									? (
										<Link
											to="access/audit/auth-log"
											params={{ ...current, principalId: row.principalId }}
											title="Filter to this principal"
											className="filter-link"
										>
											<code className="small">{row.principalId}</code>
										</Link>
									)
									: <span className="muted">none</span>}
							</td>
							<td>
								<Link to="access/audit/auth-log" params={{ ...current, decision: row.decision }} title={`Filter to ${row.decision}`} className="filter-link">
									<Status lamp={row.decision === 'allow' ? 'ok' : 'stop'}>{row.decision}</Status>
								</Link>
							</td>
							<td>{row.reason ? <code className="small">{row.reason}</code> : <span className="muted">none</span>}</td>
						</tr>
					))}
				</Table>

				<div className="pager">
					{params.before && <button type="button" onClick={() => applyFilters(params)}>First page</button>}
					<span className="pull" />
					<button type="button" onClick={nextPage} disabled={data.page.nextCursor === null}>
						Next page
					</button>
				</div>
			</>
		)
	})

interface AuthFilterParams {
	principalId?: string
	requestId?: string
	decision?: string
}

/** The log's three filters as the search field's qualifiers; it has no text search. */
const AUTH_LOG_QUERY: QueryLanguage<keyof AuthFilterParams> = {
	qualifiers: [
		{ key: 'decision', name: 'decision', values: ['allow', 'deny'] },
		{ key: 'principalId', name: 'principal', aliases: ['principal-id'] },
		{ key: 'requestId', name: 'request', aliases: ['request-id'] },
	],
	freeText: false,
}
