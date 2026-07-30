import { createPage, useNavigate } from '@buzola/router'
import type { AppDto, AppSchemaDto, ListResponse } from '@fabrika/iam-contract'
import { EmptyState, Table } from '../../components/Table'
import { api } from '../../lib/api'

/**
 * Read-only view of an app's reconciled vocabulary — its scope dimensions, action catalog,
 * and origin='app' roles (declared in app code, reconciled via PUT schema; not editable
 * here). The app is chosen via the `?app` query param.
 */
export default createPage()
	.params({ app: '?string' })
	.loader(async ({ params }) => {
		const apps = await api.get<ListResponse<AppDto>>('/apps')
		const app = params.app && apps.items.some((a) => a.id === params.app) ? params.app : null
		const schema = app === null ? null : await api.get<AppSchemaDto>(`/apps/${encodeURIComponent(app)}/schema`)
		return { apps: apps.items, app, schema }
	})
	.route('/access/schema')
	.render(({ data }) => {
		const navigate = useNavigate()
		const roleEntries = data.schema ? Object.entries(data.schema.roles) : []

		return (
			<>
				<div className="page-head">
					<h1>Schema</h1>
					<p className="hint">
						An app's authz vocabulary, declared in its code and reconciled into Propustka (<code>PUT /admin/apps/:app/schema</code>). Read-only here.
					</p>
				</div>

				<div className="filters">
					<label>
						App
						<select
							value={data.app ?? ''}
							onChange={(e) => navigate('access/schema', { params: { app: e.target.value || undefined }, replace: true })}
						>
							<option value="">Select an app…</option>
							{data.apps.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
						</select>
					</label>
				</div>

				{data.schema === null
					? (
						<div className="empty-panel">
							<EmptyState
								title="Pick an app"
								body="Its scope dimensions, action catalog and declared roles are read from the vocabulary its code reconciled."
							/>
						</div>
					)
					: (
						<>
							<section>
								<div className="section-head">
									<h2>Scope dimensions</h2>
								</div>
								<Table
									colSpan={2}
									isEmpty={data.schema.scopes.length === 0}
									empty={<EmptyState title="No scope dimensions declared" />}
									head={
										<tr>
											<th>Type</th>
											<th className="grow">Label</th>
										</tr>
									}
								>
									{data.schema.scopes.map((s) => (
										<tr key={s.type}>
											<td>
												<code>{s.type}</code>
											</td>
											<td>{s.label ?? <span className="muted">—</span>}</td>
										</tr>
									))}
								</Table>
							</section>

							<section>
								<div className="section-head">
									<h2>Action catalog</h2>
								</div>
								<Table
									colSpan={2}
									isEmpty={data.schema.actions.length === 0}
									empty={<EmptyState title="No actions declared" />}
									head={
										<tr>
											<th>Action</th>
											<th className="grow">Description</th>
										</tr>
									}
								>
									{data.schema.actions.map((a) => (
										<tr key={a.action}>
											<td>
												<code>{a.action}</code>
											</td>
											<td>{a.description ?? <span className="muted">—</span>}</td>
										</tr>
									))}
								</Table>
							</section>

							<section>
								<div className="section-head">
									<h2>App roles</h2>
								</div>
								<p className="hint">
									Roles declared in app code (origin <code>app</code>). For admin-composed policies, see the Policies page.
								</p>
								<Table
									colSpan={3}
									isEmpty={roleEntries.length === 0}
									empty={<EmptyState title="No app roles declared" />}
									head={
										<tr>
											<th>Key</th>
											<th>Name</th>
											<th className="grow">Permissions</th>
										</tr>
									}
								>
									{roleEntries.map(([key, role]) => (
										<tr key={key}>
											<td>
												<code>{key}</code>
											</td>
											<td>
												{role.name}
												{role.description && <div className="muted small">{role.description}</div>}
											</td>
											<td>{role.permissions.map((p) => <code key={p} className="perm-chip">{p}</code>)}</td>
										</tr>
									))}
								</Table>
							</section>
						</>
					)}
			</>
		)
	})
