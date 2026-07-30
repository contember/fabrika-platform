import { createPage, Link } from '@buzola/router'
import type { ListResponse, PrincipalListItem } from '@fabrika/iam/admin'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { StatusLamp } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate } from '../../lib/format'

/** '' = all types, otherwise a principal type. */
type TypeFilter = '' | PrincipalListItem['type']

export default createPage()
	.loader(async () => {
		const principals = await api.get<ListResponse<PrincipalListItem>>('/principals')
		return { principals: principals.items }
	})
	.route('/access/principals')
	.render(({ data }) => {
		const [type, setType] = useState<TypeFilter>('')
		const [query, setQuery] = useState('')

		function onTypeChange(value: string) {
			if (value === 'user' || value === 'service') setType(value)
			else setType('')
		}

		const q = query.trim().toLowerCase()
		const filtered = data.principals.filter((p) => {
			if (type && p.type !== type) return false
			if (q === '') return true
			return [p.label, p.email, p.externalId]
				.some((v) => v !== null && v !== undefined && v.toLowerCase().includes(q))
		})

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Principals</h1>
							<p className="hint">Everyone and everything that can hold a permission here — people from the IdP and service identities.</p>
						</div>
						<Link to="access/principals/new" className="btn primary">
							<Icon name="plus" />
							Invite user
						</Link>
					</div>
				</div>

				<div className="filters">
					<label>
						Type
						<select value={type} onChange={(e) => onTypeChange(e.target.value)}>
							<option value="">All</option>
							<option value="user">User</option>
							<option value="service">Service</option>
						</select>
					</label>
					<label className="field-wide">
						Search
						<input
							type="search"
							placeholder="Label, email or external id"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</label>
					<span className="count">{filtered.length} of {data.principals.length}</span>
				</div>

				<Table
					colSpan={5}
					isEmpty={filtered.length === 0}
					empty={<EmptyState title="No principals match" body="Try a different type filter or search term." />}
					head={
						<tr>
							<th>Type</th>
							<th className="grow">Label</th>
							<th>External id</th>
							<th>Status</th>
							<th>Created</th>
						</tr>
					}
				>
					{filtered.map((p) => (
						<tr key={p.id}>
							<td>{p.type}</td>
							<td>
								<Link to="access/principals/detail" params={{ id: p.id }}>{p.label}</Link>
								{p.email && <div className="muted small">{p.email}</div>}
							</td>
							<td>{p.externalId ?? <span className="muted">—</span>}</td>
							<td>
								<StatusLamp status={p.status} />
							</td>
							<td className="muted small nowrap" title={fmtDate(p.createdAt)}>{fmtAgo(p.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
