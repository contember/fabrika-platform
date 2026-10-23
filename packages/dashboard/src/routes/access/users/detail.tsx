import { createPage, Link } from '@buzola/router'
import { UserAccess } from '../../../access/components/user-detail/Access'
import { UserAccount } from '../../../access/components/user-detail/Account'
import { UserActivity } from '../../../access/components/user-detail/Activity'
import { UserSignIn } from '../../../access/components/user-detail/SignIn'
import { api } from '../../../access/lib/api'
import { actorIdsToResolve, resolveActors } from '../../../access/lib/audit-actors'
import { Icon } from '../../../components/Icon'
import { Chip, PrincipalStatus } from '../../../components/Status'
import { fmtAgo, fmtDate } from '../../../lib/format'

const sections = [
	{ id: 'access', label: 'Access' },
	{ id: 'sign-in', label: 'Sign-in' },
	{ id: 'activity', label: 'Activity' },
	{ id: 'account', label: 'Account' },
] as const

export default createPage()
	.params({ id: 'string', tab: '?string', before: '?string', activity: '?string', connectionsBefore: '?string' })
	.loader(async ({ params }) => {
		const principal = await api.principals.get({ principalId: params.id })
		const tab = sections.find((section) => section.id === params.tab)?.id ?? 'access'
		const activity = params.activity === 'sign-ins' ? 'sign-ins' : params.activity === 'by-user' ? 'by-user' : 'changes'
		const [sessions, connections, audit, authLog] = await Promise.all([
			tab === 'sign-in' ? api.sessions.list({ principalId: params.id, signInsOnly: true, limit: 10, before: params.before }) : null,
			tab === 'sign-in' && principal.management.audit
				? api.connections.list({ principalId: params.id, limit: 10, before: params.connectionsBefore })
				: null,
			tab === 'activity' && principal.management.audit && activity !== 'sign-ins'
				? api.audit.list({
					...(activity === 'changes' ? { subjectPrincipalId: params.id } : { principalId: params.id }),
					limit: 20,
					before: params.before,
				})
				: null,
			tab === 'activity' && principal.management.audit && activity === 'sign-ins'
				? api.audit.listAuthLog({ principalId: params.id, limit: 20, before: params.before })
				: null,
		])
		const actors = await resolveActors(actorIdsToResolve(audit?.items ?? []), (principalId) => api.principals.get({ principalId }))
		return { principal, tab, activity, sessions, connections, audit, authLog, actors }
	})
	.route('/access/users/:id')
	.render(({ data, params, invalidate }) => {
		const { principal, tab } = data
		const lastSignIn = Math.max(0, ...principal.access.map((access) => access.lastSignInAt ?? 0))
		return (
			<>
				<div className="page-head user-detail-head">
					<Link to="access/users" className="back-link">
						<Icon name="chevron-left" size={14} />All users
					</Link>
					<div className="page-head-row">
						<div>
							<h1>{principal.label}</h1>
							<div className="user-identity-status">
								<PrincipalStatus status={principal.status} />
								<Chip>{principal.affiliation}</Chip>
								{principal.bootstrapMailbox && principal.affiliation === 'internal' && <Chip>Installation administrator</Chip>}
							</div>
						</div>
						<Link to="access/users/grant" params={{ id: principal.id }} className="btn primary">
							<Icon name="plus" size={14} />Add access
						</Link>
					</div>
					<div className="subtitle">
						{principal.email !== principal.label && principal.email && <span>{principal.email}</span>}
						<span>Created {fmtDate(principal.createdAt)}</span>
						<span className="dot-sep" title={lastSignIn === 0 ? undefined : fmtDate(lastSignIn)}>
							{lastSignIn === 0 ? 'No application sign-in recorded' : `Last application sign-in ${fmtAgo(lastSignIn)}`}
						</span>
					</div>
				</div>

				{principal.status !== 'active' && (
					<div className="user-state-note" role="status">
						<strong>{principal.status === 'disabled' ? 'This account is disabled.' : 'This person has not activated their account yet.'}</strong>
						<p>
							{principal.status === 'disabled'
								? 'Assigned access is kept, but new access tokens are refused. Previously issued tokens can remain valid for up to five minutes.'
								: principal.affiliation === 'external'
								? 'Send a password setup link so they can sign in. External people cannot use organization sign-in.'
								: 'Assign their access, then send a password setup link or ask them to use organization sign-in if available.'}
						</p>
						<Link to="access/users/detail" params={{ id: principal.id, tab: principal.status === 'disabled' ? 'account' : 'sign-in' }}>
							{principal.status === 'disabled' ? 'Manage account' : 'Set up sign-in'}
						</Link>
					</div>
				)}

				<nav className="user-detail-tabs" aria-label="User details">
					{sections.map((section) => (
						<Link
							key={section.id}
							to="access/users/detail"
							params={{ id: principal.id, tab: section.id }}
							aria-current={tab === section.id ? 'page' : undefined}
						>
							{section.label}
						</Link>
					))}
				</nav>
				{tab === 'access' && <UserAccess key={principal.id} principal={principal} onDone={invalidate} />}
				{tab === 'sign-in' && data.sessions && (
					<UserSignIn
						key={principal.id}
						principal={principal}
						sessions={data.sessions}
						connections={data.connections}
						before={params.before}
						connectionsBefore={params.connectionsBefore}
						onDone={invalidate}
					/>
				)}
				{tab === 'activity' && (
					<UserActivity principal={principal} mode={data.activity} audit={data.audit} authLog={data.authLog} actors={data.actors} before={params.before} />
				)}
				{tab === 'account' && <UserAccount key={principal.id} principal={principal} onDone={invalidate} />}
			</>
		)
	})
