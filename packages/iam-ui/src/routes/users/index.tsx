import { createPage, Link } from '@buzola/router'
import type { ListResponse, PrincipalListItem, PrincipalStatus as Lifecycle } from '@fabrika/iam-contract'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { PrincipalStatus } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate } from '../../lib/format'

// People. A service principal is a machine with a key, so it is listed where that key is managed
// (Credentials) instead of sharing this page behind a type filter — `GET /api-keys` returns every
// service principal, so narrowing this page to users hides nothing.

/** '' = any lifecycle state. */
type StatusFilter = '' | Lifecycle

export default createPage()
	.loader(async () => {
		const principals = await api.get<ListResponse<PrincipalListItem>>('/principals?type=user')
		return { users: principals.items }
	})
	.route('/access/users')
	.render(({ data }) => {
		const [status, setStatus] = useState<StatusFilter>('')
		const [query, setQuery] = useState('')

		function onStatusChange(value: string) {
			if (value === 'invited' || value === 'active' || value === 'disabled') setStatus(value)
			else setStatus('')
		}

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

				<div className="filters">
					<label>
						Status
						<select value={status} onChange={(e) => onStatusChange(e.target.value)}>
							<option value="">All</option>
							<option value="active">Active</option>
							<option value="invited">Invited</option>
							<option value="disabled">Disabled</option>
						</select>
					</label>
					<label className="field-wide">
						Search
						<input type="search" placeholder="Name, email or external id" value={query} onChange={(e) => setQuery(e.target.value)} />
					</label>
					<span className="count">{filtered.length} of {data.users.length}</span>
				</div>

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
								{user.email && <div className="muted small">{user.email}</div>}
							</td>
							<td>{user.externalId ?? <span className="muted">—</span>}</td>
							<td>
								<PrincipalStatus status={user.status} />
							</td>
							<td className="muted small nowrap" title={fmtDate(user.createdAt)}>{fmtAgo(user.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
