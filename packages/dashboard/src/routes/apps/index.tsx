import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'
import { fmtAgo, fmtDate, shortRef } from '../../lib/format'

// Apps — every registered app. The detail page (apps/:id) holds its envs, secrets, and per-env Deploy.
// New apps are onboarded at /apps/new; this is the registry view.

export default createPage()
	.loader(async () => {
		const apps = await api.apps.list()
		return { apps: apps.items }
	})
	.route('/apps')
	.render(({ data }) => {
		const [query, setQuery] = useState('')
		const q = query.trim().toLowerCase()
		const filtered = data.apps.filter((app) => q === '' || app.id.toLowerCase().includes(q) || app.repoUrl.toLowerCase().includes(q))

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Applications</h1>
							<p className="hint">Every source repository fabrika knows how to build and release.</p>
						</div>
						<Link to="apps/new" className="btn primary">
							<Icon name="plus" />
							New app
						</Link>
					</div>
				</div>

				<div className="filters">
					<label className="field-wide">
						Search
						<input
							type="search"
							placeholder="App id or repository"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</label>
					<span className="count">{filtered.length} of {data.apps.length}</span>
				</div>

				<Table
					colSpan={4}
					isEmpty={filtered.length === 0}
					empty={data.apps.length === 0
						? (
							<EmptyState
								icon="app"
								title="No apps registered yet"
								body="Onboarding points fabrika at a repository and places its first environment."
								action={<Link to="apps/new" className="btn small primary">Onboard an app</Link>}
							/>
						)
						: <EmptyState icon="search" title="No apps match" body="Try a different id or repository fragment." />}
					head={
						<tr>
							<th>App</th>
							<th className="grow">Repository</th>
							<th>Default branch</th>
							<th>Registered</th>
						</tr>
					}
				>
					{filtered.map((app) => (
						<tr key={app.id}>
							<td>
								<Link to="apps/detail" params={{ id: app.id }}>
									<strong>{app.id}</strong>
								</Link>
							</td>
							<td>
								<code className="small">{app.repoUrl.replace(/^https?:\/\//, '')}</code>
							</td>
							<td>
								<Chip>
									<Icon name="branch" size={11} />
									{shortRef(`refs/heads/${app.defaultBranch}`)}
								</Chip>
							</td>
							<td className="muted small nowrap" title={fmtDate(app.createdAt)}>{fmtAgo(app.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
