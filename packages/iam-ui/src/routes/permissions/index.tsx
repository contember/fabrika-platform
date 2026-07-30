import { createPage, Link, useNavigate } from '@buzola/router'
import type { AppDto, AppSchemaDto, ListResponse, PolicyDto, RoleDto, UpdatePolicyRequest } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ActionPicker } from '../../components/ActionPicker'
import { Badge } from '../../components/Badge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError } from '../../lib/api'
import { fmtDate } from '../../lib/format'

// The authorization vocabulary for one app, in the order you read it: what you can grant (roles), what
// the roles are made of (actions), and what a grant can be narrowed to (scope dimensions).
//
// These were three pages — Roles, Policies, Schema — showing overlapping slices of the same thing
// behind three separate app pickers: Roles listed all three origins read-only, Policies re-listed the
// custom ones so they could be edited, Schema re-listed the app ones alongside the catalog. One page,
// one picker, and a custom role is edited where it is listed.

/** A label per role origin, for the reference table's badge. */
const ORIGIN_LABEL: Record<RoleDto['origin'], string> = {
	builtin: 'built-in',
	app: 'app',
	custom: 'policy',
}

export default createPage()
	.params({ app: '?string' })
	.loader(async ({ params }) => {
		const apps = await api.get<ListResponse<AppDto>>('/apps')
		const app = params.app && apps.items.some((candidate) => candidate.id === params.app) ? params.app : null
		if (app === null) {
			const roles = await api.get<ListResponse<RoleDto>>('/roles')
			return { apps: apps.items, app: null, roles: roles.items, policies: [], schema: null }
		}
		const [roles, policies, schema] = await Promise.all([
			api.get<ListResponse<RoleDto>>(`/roles?app=${encodeURIComponent(app)}`),
			api.get<ListResponse<PolicyDto>>(`/apps/${encodeURIComponent(app)}/policies`),
			api.get<AppSchemaDto>(`/apps/${encodeURIComponent(app)}/schema`),
		])
		return { apps: apps.items, app, roles: roles.items, policies: policies.items, schema }
	})
	.route('/access/permissions')
	.render(({ data, invalidate }) => {
		const navigate = useNavigate()
		// `/roles` already returns the custom ones, but flat and read-only. Drop them and render the
		// policy rows instead, which carry what it takes to edit them.
		const declared = data.roles.filter((role) => role.origin !== 'custom')
		const roleCount = declared.length + data.policies.length

		return (
			<>
				<div className="page-head">
					<h1>Permissions</h1>
					<p className="hint">
						What a grant actually means. Built-in roles are cross-app; an app declares its own roles, actions and scope dimensions in code, and you compose
						policies on top of that catalog.
					</p>
				</div>

				<div className="filters">
					<label>
						App
						<select
							value={data.app ?? ''}
							onChange={(e) => navigate('access/permissions', { params: { app: e.target.value || undefined }, replace: true })}
						>
							<option value="">Built-in only</option>
							{data.apps.map((app) => <option key={app.id} value={app.id}>{app.id}</option>)}
						</select>
					</label>
					<span className="count">{roleCount} grantable</span>
				</div>

				<section>
					<div className="section-head">
						<Icon name="medal" size={15} />
						<h2>Roles</h2>
						<span className="spacer" />
						{data.app !== null && (
							<Link to="access/permissions/policies/new" params={{ app: data.app }} className="btn small primary">
								<Icon name="plus" size={13} />
								Create policy
							</Link>
						)}
					</div>
					<p className="section-note">Everything a grant can name. A policy is a role you composed here, so it is listed and edited with the rest.</p>
					<Table
						colSpan={4}
						isEmpty={roleCount === 0}
						empty={<EmptyState title="No roles" body="Pick an app above to see the roles its code declares alongside the built-ins." />}
						head={
							<tr>
								<th className="grow">Role</th>
								<th>Origin</th>
								<th className="grow">Permission patterns</th>
								<th />
							</tr>
						}
					>
						{declared.map((role) => (
							<tr key={role.key}>
								<td>
									<strong>{role.name}</strong>
									<div className="muted small">
										<code>{role.key}</code>
									</div>
									{role.description !== undefined && <div className="muted small">{role.description}</div>}
								</td>
								<td>
									<Badge tone="muted">{ORIGIN_LABEL[role.origin]}</Badge>
								</td>
								<td>
									{role.permissions.length === 0
										? <span className="muted">none</span>
										: role.permissions.map((permission) => <code key={permission} className="perm-chip">{permission}</code>)}
								</td>
								<td />
							</tr>
						))}
						{data.app !== null
							&& data.policies.map((policy) => (
								<PolicyRow key={policy.key} app={data.app} policy={policy} actions={data.schema?.actions ?? []} onDone={invalidate} />
							))}
					</Table>
				</section>

				{data.schema === null
					? (
						<div className="empty-panel">
							<EmptyState
								title="Pick an app for its catalog"
								body="Actions and scope dimensions belong to one app's vocabulary — they are declared in its code and reconciled into IAM."
							/>
						</div>
					)
					: (
						<>
							<section>
								<div className="section-head">
									<Icon name="schema" size={15} />
									<h2>Actions</h2>
								</div>
								<p className="section-note">
									The catalog a role's patterns match against, reconciled from the app's code (<code>PUT /admin/apps/:app/schema</code>). Read-only here.
								</p>
								<Table
									colSpan={2}
									isEmpty={data.schema.actions.length === 0}
									empty={<EmptyState title="No actions declared" body="This app has not reconciled a vocabulary yet." />}
									head={
										<tr>
											<th>Action</th>
											<th className="grow">Description</th>
										</tr>
									}
								>
									{data.schema.actions.map((action) => (
										<tr key={action.action}>
											<td>
												<code>{action.action}</code>
											</td>
											<td>{action.description ?? <span className="muted">—</span>}</td>
										</tr>
									))}
								</Table>
							</section>

							<section>
								<div className="section-head">
									<Icon name="bay" size={15} />
									<h2>Scope dimensions</h2>
								</div>
								<p className="section-note">What a grant can be narrowed to. The values are opaque to IAM — the app owns what they mean.</p>
								<Table
									colSpan={2}
									isEmpty={data.schema.scopes.length === 0}
									empty={<EmptyState title="No scope dimensions declared" body="Every grant for this app is global." />}
									head={
										<tr>
											<th>Dimension</th>
											<th className="grow">Label</th>
										</tr>
									}
								>
									{data.schema.scopes.map((scope) => (
										<tr key={scope.type}>
											<td>
												<code>{scope.type}</code>
											</td>
											<td>{scope.label ?? <span className="muted">—</span>}</td>
										</tr>
									))}
								</Table>
							</section>
						</>
					)}
			</>
		)
	})

function PolicyRow({ app, policy, actions, onDone }: { app: string; policy: PolicyDto; actions: AppSchemaDto['actions']; onDone: () => void }) {
	const [editing, setEditing] = useState(false)
	const [confirming, setConfirming] = useState(false)
	const [name, setName] = useState(policy.name)
	const [description, setDescription] = useState(policy.description ?? '')
	const [permissions, setPermissions] = useState<string[]>(policy.permissions)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		if (permissions.length === 0) {
			setError('Pick at least one action.')
			return
		}
		setBusy(true)
		try {
			const body: UpdatePolicyRequest = {
				name: name.trim(),
				...(description.trim() === '' ? {} : { description: description.trim() }),
				permissions,
			}
			await api.put(`/apps/${encodeURIComponent(app)}/policies/${encodeURIComponent(policy.key)}`, body)
			setEditing(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
		} finally {
			setBusy(false)
		}
	}

	async function remove() {
		await api.del(`/apps/${encodeURIComponent(app)}/policies/${encodeURIComponent(policy.key)}`)
		onDone()
	}

	if (editing) {
		return (
			<tr>
				<td>
					<code>{policy.key}</code>
				</td>
				<td colSpan={3}>
					<form className="inline-edit-form" onSubmit={save}>
						<label>
							Name
							<input value={name} onChange={(e) => setName(e.target.value)} required />
						</label>
						<label>
							Description
							<input value={description} onChange={(e) => setDescription(e.target.value)} />
						</label>
						<ActionPicker actions={actions} value={permissions} onChange={setPermissions} idPrefix={`edit-${policy.key}-action`} />
						{error && <p className="error-text" role="alert">{error}</p>}
						<div className="form-actions">
							<button type="submit" className="small primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
							<button
								type="button"
								className="small"
								onClick={() => {
									setEditing(false)
									setName(policy.name)
									setDescription(policy.description ?? '')
									setPermissions(policy.permissions)
									setError(null)
								}}
								disabled={busy}
							>
								Cancel
							</button>
						</div>
					</form>
				</td>
			</tr>
		)
	}

	return (
		<tr>
			<td>
				<strong>{policy.name}</strong>
				<div className="muted small">
					<code>{policy.key}</code>
				</div>
				{policy.description !== undefined && <div className="muted small">{policy.description}</div>}
			</td>
			<td>
				<Badge tone="neutral" title={`Composed here on ${fmtDate(policy.createdAt)}`}>{ORIGIN_LABEL.custom}</Badge>
			</td>
			<td>{policy.permissions.map((permission) => <code key={permission} className="perm-chip">{permission}</code>)}</td>
			<td className="row-actions">
				<button type="button" className="small" onClick={() => setEditing(true)}>Edit</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete policy"
						confirmLabel="Delete"
						body={
							<p>
								Delete the policy <code>{policy.key}</code>? Existing grants referencing it will become dangling.
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}
