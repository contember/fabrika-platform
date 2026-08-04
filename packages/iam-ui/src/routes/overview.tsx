import { createPage, Link } from '@buzola/router'
import type { ApiKeyDto, AuditEventDto, PrincipalListItem, ShareLinkListItem } from '@fabrika/iam-contract'
import { Icon } from '../components/Icon'
import { Chip, principalLamp, Status, StatusLamp } from '../components/Status'
import { EmptyState } from '../components/Table'
import { api } from '../lib/api'
import { fmtAgo, fmtDate, fmtExpiry, shareLinkState } from '../lib/format'

// The access plane on one screen: who can get in, what can get in without a person, what is about to
// lapse, and what changed. The console's landing page reports both planes but only has room for four
// gauges of this one; this is where the access half is actually read.
//
// Composed from the list endpoints that already exist. There is no aggregate endpoint and this page
// does not justify inventing one — the four reads are small and run in parallel.

const DAY = 86_400
const WEEK = 7 * DAY
/** An invite nobody claimed in two weeks is either forgotten or the address is wrong. */
const STALE_INVITE = 14 * DAY
const AUDIT_WINDOW = 100

export default createPage()
	.loader(async () => {
		const [users, apiKeys, shareLinks, audit] = await Promise.all([
			api.principals.list({ type: 'user' }),
			api.apiKeys.list({}),
			api.shareLinks.list({}),
			api.audit.list({ limit: AUDIT_WINDOW }),
		])
		return { users: users.items, apiKeys: apiKeys.items, shareLinks: shareLinks.items, audit: audit.items }
	})
	.route('/access')
	.render(({ data }) => {
		const { users, apiKeys, shareLinks, audit } = data
		const now = Math.floor(Date.now() / 1000)

		const activeUsers = users.filter((user) => user.status === 'active')
		const invited = users.filter((user) => user.status === 'invited')
		const disabled = users.filter((user) => user.status === 'disabled')
		const activeKeys = apiKeys.filter((key) => key.status === 'active')
		const liveLinks = shareLinks.filter((link) => shareLinkState(link) === 'active')
		const changesToday = audit.filter((event) => event.createdAt >= now - DAY).length

		const lapsing = [...expiringKeys(apiKeys, now), ...expiringLinks(shareLinks, now)]
		const dangling = apiKeys.filter((key) => key.grants.some((grant) => grant.dangling))
		const stale = invited.filter((user) => now - user.createdAt > STALE_INVITE)
		const attention = lapsing.length + dangling.length + stale.length

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Access overview</h1>
							<p className="hint">Who and what can reach this installation, what is about to lapse, and what changed.</p>
						</div>
						<Link to="access/users/new" className="btn primary">
							<Icon name="plus" />
							Invite user
						</Link>
					</div>
				</div>

				<div className="instrument-cluster">
					<div className="instrument">
						<div className="instrument-label">Users</div>
						<div className="instrument-value">
							{activeUsers.length}
							<small>/ {users.length}</small>
						</div>
						<div className="instrument-note">
							{users.length === 0
								? <Status lamp="idle">nobody invited</Status>
								: invited.length > 0
								? <Status lamp="run">{invited.length} awaiting first sign-in</Status>
								: <Status lamp="ok">{disabled.length > 0 ? `${disabled.length} disabled` : 'all signed in'}</Status>}
						</div>
					</div>
					<div className="instrument">
						<div className="instrument-label">API keys</div>
						<div className="instrument-value">
							{activeKeys.length}
							<small>/ {apiKeys.length}</small>
						</div>
						<div className="instrument-note">
							<Status lamp={apiKeys.length === 0 ? 'idle' : 'ok'}>
								{apiKeys.length === 0
									? 'none provisioned'
									: apiKeys.length - activeKeys.length > 0
									? `${apiKeys.length - activeKeys.length} revoked`
									: 'machines with a name'}
							</Status>
						</div>
					</div>
					<div className="instrument">
						<div className="instrument-label">Share links</div>
						<div className="instrument-value">
							{liveLinks.length}
							<small>/ {shareLinks.length}</small>
						</div>
						<div className="instrument-note">
							<Status lamp={liveLinks.length === 0 ? 'idle' : 'ok'}>
								{liveLinks.length === 0 ? 'none in circulation' : 'anonymous, revocable'}
							</Status>
						</div>
					</div>
					<div className="instrument">
						<div className="instrument-label">Changes · 24 h</div>
						<div className="instrument-value">{changesToday}</div>
						<div className="instrument-note">
							<Status lamp={changesToday > 0 ? 'ok' : 'idle'}>audited writes</Status>
						</div>
					</div>
				</div>

				<div className="board">
					<div className="board-col">
						<section className="card">
							<div className="card-head">
								<Icon name="history" size={15} />
								<h2>Recent changes</h2>
								<span className="spacer" />
								<Link to="access/audit" className="card-link">
									Audit
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{audit.length === 0
									? <EmptyState title="Nothing recorded yet" body="Every write the IAM service makes lands here — invites, grants, revocations." />
									: (
										<div className="feed">
											{audit.slice(0, 7).map((event) => <AuditRow key={event.id} event={event} />)}
										</div>
									)}
							</div>
						</section>

						<section className="card">
							<div className="card-head">
								<Icon name="users" size={15} />
								<h2>Users</h2>
								<span className="spacer" />
								<Link to="access/users" className="card-link">
									All
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{users.length === 0
									? (
										<EmptyState
											title="Nobody invited yet"
											body="Bootstrap admins can already sign in; everyone else needs an invite or a group mapping."
											action={<Link to="access/users/new" className="btn small">Invite the first user</Link>}
										/>
									)
									: (
										<div className="feed">
											{[...users].sort(byRecency).slice(0, 6).map((user) => (
												<Link key={user.id} to="access/users/detail" params={{ id: user.id }} className="feed-row">
													<StatusLamp lamp={principalLamp(user.status)} />
													<span className="feed-main">
														<span className="feed-title">
															<span className="truncate">{user.label}</span>
														</span>
														<span className="feed-meta">
															<span className="truncate">{secondaryIdentity(user)}</span>
														</span>
													</span>
													<span className="feed-side">
														<strong>{fmtAgo(user.createdAt)}</strong>
													</span>
												</Link>
											))}
										</div>
									)}
							</div>
						</section>
					</div>

					<div className="board-col">
						{attention > 0 && (
							<section className="card">
								<div className="card-head">
									<Icon name="alert" size={15} />
									<h2>Needs attention</h2>
								</div>
								<div className="card-body flush">
									<div className="feed">
										{dangling.map((key) => (
											<Link key={key.principalId} to="access/credentials" className="feed-row">
												<StatusLamp lamp="stop" />
												<span className="feed-main">
													<span className="feed-title">
														<span className="truncate">{key.label}</span>
													</span>
													<span className="feed-meta">grants a role that no longer exists — it resolves to zero permissions</span>
												</span>
											</Link>
										))}
										{lapsing.map((item) => (
											<Link key={item.key} to="access/credentials" className="feed-row">
												<StatusLamp lamp="run" />
												<span className="feed-main">
													<span className="feed-title">
														<span className="truncate">{item.label}</span>
														<Chip>{item.kind}</Chip>
													</span>
													<span className="feed-meta">expires {fmtDate(item.expiresAt)}</span>
												</span>
												<span className="feed-side">
													<strong>{inDays(item.expiresAt, now)}</strong>
												</span>
											</Link>
										))}
										{stale.map((user) => (
											<Link key={user.id} to="access/users/detail" params={{ id: user.id }} className="feed-row">
												<StatusLamp lamp="idle" />
												<span className="feed-main">
													<span className="feed-title">
														<span className="truncate">{user.label}</span>
													</span>
													<span className="feed-meta">invited {fmtAgo(user.createdAt)} and has never signed in</span>
												</span>
											</Link>
										))}
									</div>
								</div>
							</section>
						)}

						<section className="card">
							<div className="card-head">
								<Icon name="key" size={15} />
								<h2>Credentials</h2>
								<span className="spacer" />
								<Link to="access/credentials" className="card-link">
									All
									<Icon name="chevron-right" size={13} />
								</Link>
							</div>
							<div className="card-body flush">
								{apiKeys.length === 0 && shareLinks.length === 0
									? (
										<EmptyState
											title="No machine credentials"
											body="An API key names a service in the audit trail; a share link hands out a slice of what you hold."
											action={<Link to="access/credentials/keys/new" className="btn small">Provision a key</Link>}
										/>
									)
									: (
										<div className="feed">
											{apiKeys.slice(0, 4).map((key) => (
												<Link key={key.principalId} to="access/credentials" className="feed-row">
													<StatusLamp lamp={principalLamp(key.status)} />
													<span className="feed-main">
														<span className="feed-title">
															<span className="truncate">{key.label}</span>
															<Chip>API key</Chip>
														</span>
														<span className="feed-meta">
															<span className="truncate">{authorizationLabel(key)}</span>
														</span>
													</span>
												</Link>
											))}
											{liveLinks.slice(0, 3).map((link) => (
												<Link key={link.id} to="access/credentials" className="feed-row">
													<StatusLamp lamp="ok" />
													<span className="feed-main">
														<span className="feed-title">
															<span className="truncate">{link.label ?? 'unlabelled'}</span>
															<Chip>share link</Chip>
														</span>
														<span className="feed-meta">
															{link.grants.length} grant{link.grants.length === 1 ? '' : 's'}
															<span className="dot-sep">expires {fmtExpiry(link.expiresAt).toLowerCase()}</span>
														</span>
													</span>
												</Link>
											))}
										</div>
									)}
							</div>
						</section>
					</div>
				</div>
			</>
		)
	})

/** An invited user's label IS their email, so the second line has to say something else. */
function secondaryIdentity(user: PrincipalListItem): string {
	if (user.email !== null && user.email !== user.label) return user.email
	if (user.externalId !== null && user.externalId !== user.label) return user.externalId
	return user.id
}

/** Newest first — an overview reports what just happened, not what has been there longest. */
function byRecency(a: PrincipalListItem, b: PrincipalListItem): number {
	return b.createdAt - a.createdAt
}

interface Lapsing {
	key: string
	kind: 'API key' | 'share link'
	label: string
	expiresAt: number
}

function expiringKeys(apiKeys: ApiKeyDto[], now: number): Lapsing[] {
	const out: Lapsing[] = []
	for (const key of apiKeys) {
		if (key.status !== 'active') continue
		const soonest = key.grants
			.map((grant) => grant.expiresAt)
			.filter((expiry): expiry is number => expiry !== null && expiry > now && expiry - now < WEEK)
			.sort((a, b) => a - b)[0]
		if (soonest !== undefined) out.push({ key: `key:${key.principalId}`, kind: 'API key', label: key.label, expiresAt: soonest })
	}
	return out
}

function expiringLinks(shareLinks: ShareLinkListItem[], now: number): Lapsing[] {
	const out: Lapsing[] = []
	for (const link of shareLinks) {
		if (shareLinkState(link) !== 'active') continue
		if (link.expiresAt === null || link.expiresAt - now >= WEEK) continue
		out.push({ key: `link:${link.id}`, kind: 'share link', label: link.label ?? 'unlabelled', expiresAt: link.expiresAt })
	}
	return out
}

function inDays(expiresAt: number, now: number): string {
	const hours = Math.max(0, Math.floor((expiresAt - now) / 3600))
	return hours < 48 ? `in ${hours}h` : `in ${Math.floor(hours / 24)}d`
}

/** One line of what a key may do — the detail lives on the credentials page. */
function authorizationLabel(key: ApiKeyDto): string {
	if (key.grants.length === 0) return 'no grants'
	const first = key.grants[0]
	if (first === undefined) return 'no grants'
	const what = first.roleKey ?? (first.permissions ?? []).join(', ')
	const where = first.app ?? 'all apps'
	return key.grants.length === 1 ? `${what} on ${where}` : `${what} on ${where} + ${key.grants.length - 1} more`
}

function AuditRow({ event }: { event: AuditEventDto }) {
	return (
		<Link to="access/audit" params={{ requestId: event.requestId }} className="feed-row">
			<span className="feed-main">
				<span className="feed-title">
					<code className="truncate">{event.action}</code>
				</span>
				<span className="feed-meta">
					<span className="truncate">{event.credentialId === null ? event.principalLabel : `credential ${event.credentialId}`}</span>
					<span className="dot-sep">
						<code>{event.resourceType}</code>
					</span>
				</span>
			</span>
			<span className="feed-side">
				<strong>{fmtAgo(event.createdAt)}</strong>
			</span>
		</Link>
	)
}
