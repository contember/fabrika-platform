import { createPage } from '@buzola/router'
import type { AdministeredAppDto, AppMemberItem } from '@fabrika/iam-contract'
import { useState } from 'react'
import { api } from '../../access/lib/api'
import { fmtScope } from '../../access/lib/format'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Chip } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { ApiError } from '../../lib/api'
import { fmtAgo, fmtDate } from '../../lib/format'

// The people of the applications the signed-in person administers: whoever holds an application's `members.manage`
// globally grants and revokes its global roles here, without being an IAM administrator. IAM decides and audits each
// change (`appPeople.*`); this page only asks.

export default createPage()
	.params({ app: '?string', after: '?string' })
	.loader(async ({ params }) => {
		const apps = (await api.appPeople.apps()).items
		const selected = apps.find((app) => app.app === params.app) ?? apps[0] ?? null
		const people = selected === null
			? null
			: await api.appPeople.list({ app: selected.app, ...(params.after === undefined ? {} : { after: params.after }) })
		return { apps, selected, people }
	})
	.route('/people')
	.render(({ data, invalidate, params }) => {
		const { apps, selected, people } = data
		return (
			<>
				<div className="page-head">
					<h1>People</h1>
					<p className="hint">
						The people of the applications you administer. A role you give here takes effect at the next sign-in, at most 300 seconds later, and IAM audits
						it under the application.
					</p>
				</div>
				{selected === null || people === null
					? <EmptyState title="You administer no application's people" body="An IAM administrator grants the role that does." />
					: (
						<>
							{apps.length > 1 && <AppPicker apps={apps} selected={selected.app} />}
							<GrantForm app={selected} onDone={invalidate} />
							<PeopleTable app={selected} members={people.members} onDone={invalidate} />
							{people.next !== null && (
								<a className="btn small" href={`/people?app=${encodeURIComponent(selected.app)}&after=${encodeURIComponent(people.next)}`}>Next page</a>
							)}
							{params.after !== undefined && <a className="btn small" href={`/people?app=${encodeURIComponent(selected.app)}`}>First page</a>}
						</>
					)}
			</>
		)
	})

function AppPicker({ apps, selected }: { apps: AdministeredAppDto[]; selected: string }) {
	return (
		<div className="filters">
			<label>
				Application
				<select
					value={selected}
					onChange={(e) => {
						location.href = `/people?app=${encodeURIComponent(e.target.value)}`
					}}
				>
					{apps.map((app) => <option key={app.app} value={app.app}>{app.displayName ?? app.app}</option>)}
				</select>
			</label>
		</div>
	)
}

function GrantForm({ app, onDone }: { app: AdministeredAppDto; onDone: () => void }) {
	const [email, setEmail] = useState('')
	const [role, setRole] = useState(app.roles[0]?.key ?? '')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setMessage(null)
		try {
			const granted = await api.appPeople.grant({ app: app.app, role, email: email.trim() })
			setMessage(granted.granted ? 'Granted.' : 'This person already holds the role.')
			setEmail('')
			onDone()
		} catch (cause) {
			setMessage(cause instanceof ApiError ? cause.message : 'Grant failed.')
		} finally {
			setBusy(false)
		}
	}

	if (app.roles.length === 0) {
		return <p className="hint">This application declares no global role whose every action you hold.</p>
	}
	return (
		<form className="panel form" onSubmit={submit}>
			<label>
				Address
				<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
				<span className="hint">A person who has signed in to the installation before. An IAM administrator invites anyone else.</span>
			</label>
			<label>
				Role
				<select value={role} onChange={(e) => setRole(e.target.value)}>
					{app.roles.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
				</select>
			</label>
			{message && <p className="hint" role="status">{message}</p>}
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Granting…' : 'Grant role'}</button>
			</div>
		</form>
	)
}

function PeopleTable({ app, members, onDone }: { app: AdministeredAppDto; members: AppMemberItem[]; onDone: () => void }) {
	const [revoking, setRevoking] = useState<{ principalId: string; label: string; role: string } | null>(null)
	const grantable = new Set(app.roles.map((role) => role.key))
	return (
		<>
			<Table
				colSpan={3}
				isEmpty={members.length === 0}
				empty={<EmptyState title="Nobody holds a role of this application" body="Grant the first one above." />}
				head={
					<tr>
						<th className="grow">Person</th>
						<th>Roles</th>
						<th>Last sign-in</th>
					</tr>
				}
			>
				{members.map((member) => (
					<tr key={member.principalId}>
						<td>
							{member.label ?? member.principalId}
							{member.disabled && <Chip>disabled</Chip>}
							{member.affiliation === 'external' && <Chip title="A person from outside the organization">external</Chip>}
							{member.email && <div className="muted small">{member.email}</div>}
						</td>
						<td>
							{member.roles.map((held) => (
								<div key={`${held.role}:${held.scope === null ? '' : fmtScope(held.scope)}`}>
									{held.role}
									{held.scope !== null && <span className="muted small">in {fmtScope(held.scope)}</span>}
									{held.scope === null && grantable.has(held.role) && (
										<button
											type="button"
											className="small"
											onClick={() => setRevoking({ principalId: member.principalId, label: member.label ?? member.principalId, role: held.role })}
										>
											Revoke
										</button>
									)}
								</div>
							))}
						</td>
						<td className="muted small nowrap" title={member.lastSignInAt === null ? undefined : fmtDate(member.lastSignInAt)}>
							{member.lastSignInAt === null ? 'never' : fmtAgo(member.lastSignInAt)}
						</td>
					</tr>
				))}
			</Table>
			{revoking && (
				<ConfirmDialog
					title="Revoke role"
					confirmLabel="Revoke"
					body={<p>Take {revoking.role} from {revoking.label}? Their next sign-in no longer carries it.</p>}
					onConfirm={async () => {
						await api.appPeople.revoke({ app: app.app, role: revoking.role, principalId: revoking.principalId })
						onDone()
					}}
					onClose={() => setRevoking(null)}
				/>
			)}
		</>
	)
}
