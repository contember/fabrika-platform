import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { api } from '../../../access/lib/api'
import { Icon } from '../../../components/Icon'
import { QuerySearch } from '../../../components/QuerySearch'
import { Chip, PrincipalStatus } from '../../../components/Status'
import { EmptyState, Table } from '../../../components/Table'
import { fmtAgo, fmtDate } from '../../../lib/format'
import type { QueryLanguage } from '../../../lib/query-search'

// People. A service principal is a machine with a key, so it is listed where that key is managed
// (Credentials) instead of sharing this page behind a type filter: `GET /api-keys` returns every
// service principal, so narrowing this page to users hides nothing.

/** The list filters in the browser: a lifecycle state, and words matched against name, email and external id. */
const USERS_QUERY: QueryLanguage<'status'> = {
	qualifiers: [{ key: 'status', name: 'status', values: ['active', 'invited', 'disabled'] }],
	freeText: true,
}

export default createPage()
	.loader(async () => {
		const principals = await api.principals.list({ type: 'user' })
		return { users: principals.items }
	})
	.route('/access/users')
	.render(({ data }) => {
		const [status, setStatus] = useState('')
		const [query, setQuery] = useState('')

		const q = query.trim().toLowerCase()
		const filtered = data.users.filter((user) => {
			if (status !== '' && user.status !== status) return false
			if (q === '') return true
			return [user.label, user.email, user.externalId].some((value) => value !== null && value !== undefined && value.toLowerCase().includes(q))
		})

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Users</h1>
							<p className="hint">
								People who can sign in. Inviting one pre-creates them so you can grant a role before their first login; the IdP fills in the rest.
							</p>
						</div>
						<Link to="access/users/new" className="btn primary">
							<Icon name="plus" />
							Invite user
						</Link>
					</div>
				</div>

				<QuerySearch
					id="users-search"
					language={USERS_QUERY}
					label="Search"
					filters={{ status: status || undefined }}
					text={query}
					onApply={(filters, text) => {
						setStatus(filters.status ?? '')
						setQuery(text)
					}}
					placeholder="status:invited ada"
					live
					aside={`${filtered.length} of ${data.users.length}`}
				/>

				{/* The page head already carries the filled Invite button, so this repeat of it stays outline. */}
				<Table
					colSpan={4}
					isEmpty={filtered.length === 0}
					empty={data.users.length === 0
						? (
							<EmptyState
								title="Nobody has been invited yet"
								body="Whoever is listed in IAM_BOOTSTRAP_ADMINS can already sign in; everyone else needs an invite or a group mapping."
								action={<Link to="access/users/new" className="btn small">Invite the first user</Link>}
							/>
						)
						: <EmptyState title="No users match" body="Try a different status or search term." />}
					head={
						<tr>
							<th className="grow">User</th>
							<th>External id</th>
							<th>Status</th>
							<th>Created</th>
						</tr>
					}
				>
					{filtered.map((user) => (
						<tr key={user.id}>
							<td>
								<Link to="access/users/detail" params={{ id: user.id }}>{user.label}</Link>
								{user.affiliation === 'external' && <Chip title="A person from outside the organization">external</Chip>}
								{user.email && <div className="muted small">{user.email}</div>}
							</td>
							<td className="nowrap">{user.externalId ?? <span className="muted">none</span>}</td>
							<td>
								<button type="button" className="filter-value" title="Filter to this status" onClick={() => setStatus(user.status)}>
									<PrincipalStatus status={user.status} />
								</button>
							</td>
							<td className="muted small nowrap" title={fmtDate(user.createdAt)}>{fmtAgo(user.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
