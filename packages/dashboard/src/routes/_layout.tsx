import { Link, Outlet, useNavigate, useRoute } from '@buzola/router'
import { useEffect, useState } from 'react'
import { BrandMark, Icon, type IconName } from '../components/Icon'
import { RouteError } from '../components/RouteError'
import { type ConsoleCaller, mayOpen, type NavPage } from '../lib/console-access'
import { ConsoleAccessContext } from '../lib/console-caller'
import { type ConsoleSession, consoleSession } from '../lib/session'
import { effectiveTheme, pinTheme, type Theme } from '../lib/theme'

interface NavItem {
	to: NavPage
	label: string
	/** Distinguishes repeated visible labels for assistive technology and browser automation. */
	accessibleLabel?: string
	/** The rail stays label-only; this explains the label on hover. */
	description: string
	icon: IconName
	match: string
	/** For a section's own landing page, whose path is a prefix of every page under it. */
	exact?: boolean
}

interface NavSection {
	label: string
	items: NavItem[]
}

/** The overview spans all planes, so it sits above them rather than inside any section. */
const LEAD: NavItem = {
	to: 'index',
	label: 'Overview',
	accessibleLabel: 'Console overview',
	description: 'All planes at a glance',
	icon: 'gauge',
	match: '/',
	exact: true,
}

const NAV: NavSection[] = [
	{
		label: 'Delivery',
		items: [
			{ to: 'apps', label: 'Applications', description: 'Sources and targets', icon: 'app', match: '/apps' },
			{ to: 'namespaces', label: 'Namespaces', description: 'Runtime boundaries', icon: 'bay', match: '/namespaces' },
			{ to: 'runs', label: 'Deploy runs', description: 'Build and release log', icon: 'runs', match: '/runs' },
			{ to: 'approvals', label: 'Approvals', description: 'Access changes waiting for a person', icon: 'shield', match: '/approvals' },
			{ to: 'settings/source', label: 'Source connection', description: 'GitHub source authority', icon: 'link', match: '/settings/source' },
		],
	},
	{
		label: 'Access',
		items: [
			{
				to: 'access',
				label: 'Overview',
				accessibleLabel: 'Access overview',
				description: 'The access plane at a glance',
				icon: 'shield',
				match: '/access',
				exact: true,
			},
			{ to: 'access/users', label: 'Users', description: 'People who can sign in', icon: 'users', match: '/access/users' },
			{ to: 'access/credentials', label: 'Credentials', description: 'API keys and share links', icon: 'key', match: '/access/credentials' },
			{ to: 'access/permissions', label: 'Permissions', description: 'Roles, actions and scopes', icon: 'schema', match: '/access/permissions' },
			{ to: 'access/audit', label: 'Audit', description: 'Changes and sign-in decisions', icon: 'history', match: '/access/audit' },
		],
	},
	{
		label: 'Operations',
		items: [
			{
				to: 'operations',
				label: 'Overview',
				accessibleLabel: 'Operations overview',
				description: 'The operations plane at a glance',
				icon: 'gauge',
				match: '/operations',
				exact: true,
			},
			{ to: 'operations/errors', label: 'Errors', description: 'Application failures and triage', icon: 'alert', match: '/operations/errors' },
			{ to: 'operations/sources', label: 'Sources', description: 'Telemetry source catalog', icon: 'app', match: '/operations/sources' },
			{ to: 'operations/releases', label: 'Releases', description: 'Release and regression context', icon: 'commit', match: '/operations/releases' },
			{ to: 'operations/health', label: 'Health', description: 'Runtime and pipeline signals', icon: 'runs', match: '/operations/health' },
		],
	},
	{
		label: 'Your applications',
		items: [
			{ to: 'people', label: 'People', description: 'Roles of the applications you administer', icon: 'users', match: '/people' },
		],
	},
]

function isActive(item: NavItem, pathname: string): boolean {
	if (item.exact === true) return pathname === item.match
	return pathname === item.match || pathname.startsWith(`${item.match}/`)
}

/** The rail as this caller may use it: a section with no usable page is left out. */
export function visibleNav(caller: ConsoleCaller): { lead: NavItem | null; sections: NavSection[] } {
	const sections = NAV
		.map((section) => ({ ...section, items: section.items.filter((item) => mayOpen(caller, item.to)) }))
		.filter((section) => section.items.length > 0)
	return { lead: mayOpen(caller, LEAD.to) ? LEAD : null, sections }
}

export default function RootLayout() {
	const { pathname } = useRoute()
	const session = useConsoleSession()
	// The overview spans all planes, so it isn't filed under any one of them.
	const plane = pathname === '/'
		? 'Console'
		: pathname.startsWith('/access')
		? 'Access'
		: pathname.startsWith('/operations')
		? 'Operations'
		: pathname.startsWith('/people')
		? 'Your applications'
		: 'Delivery'
	const here = [LEAD, ...NAV.flatMap((section) => section.items)].find((item) => isActive(item, pathname)) ?? null

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">
						<BrandMark size={26} />
					</span>
					<span className="brand-copy">
						<span className="brand-name">fabrika</span>
						<span className="brand-sub">console</span>
					</span>
				</div>
				{session !== null && <Navigation caller={session} pathname={pathname} />}
				{/* An install-level fact, so it sits on the rail's nameplate rather than in the per-page bar. */}
				<div className="sidebar-foot">
					<span className="endpoint" title="Delivery, Access and Operations share one console">
						<span className="lamp" aria-hidden="true" />
						Three planes · one console
					</span>
				</div>
			</aside>
			<main className="content">
				<header className="context-bar">
					<div className="bar-inner">
						{/* Where you are, and nothing else — the page states its own purpose directly below. */}
						<div className="crumbs">
							<span className="crumb-plane">{plane}</span>
							<Icon name="chevron-right" size={13} />
							<span className="crumb-here">{here?.label ?? 'Console'}</span>
						</div>
						<div className="bar-actions">
							<Link to="builder/authorize" className="btn small">Your builder connections</Link>
							<ThemeToggle />
							{session !== null && <SignedIn session={session} />}
						</div>
					</div>
				</header>
				<div className="workspace">
					{session === null
						? <div className="loading">Loading console…</div>
						: (
							<ConsoleAccessContext.Provider value={session.access}>
								<Workspace session={session} here={here} pathname={pathname} />
							</ConsoleAccessContext.Provider>
						)}
				</div>
			</main>
		</div>
	)
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
	const active = isActive(item, pathname)
	return (
		<Link
			to={item.to}
			className={`nav-item${active ? ' active' : ''}`}
			aria-label={item.accessibleLabel}
			aria-current={active ? 'page' : undefined}
			title={item.description}
		>
			<Icon name={item.icon} />
			<span>{item.label}</span>
		</Link>
	)
}

/** Read once per console load; until it answers, the rail and the bar show nothing rather than a guess. */
function useConsoleSession(): ConsoleSession | null {
	const [session, setSession] = useState<ConsoleSession | null>(null)

	useEffect(() => {
		let cancelled = false
		void consoleSession().then((read) => {
			if (!cancelled) setSession(read)
		})
		return () => {
			cancelled = true
		}
	}, [])

	return session
}

function Navigation({ caller, pathname }: { caller: ConsoleCaller; pathname: string }) {
	const { lead, sections } = visibleNav(caller)
	return (
		<nav aria-label="Console navigation">
			{lead !== null && (
				<div className="nav-section nav-lead">
					<NavLink item={lead} pathname={pathname} />
				</div>
			)}
			{sections.map((section) => (
				<div className="nav-section" key={section.label}>
					<div className="nav-section-label">{section.label}</div>
					{section.items.map((item) => <NavLink key={item.to} item={item} pathname={pathname} />)}
				</div>
			))}
		</nav>
	)
}

/**
 * The page, or why it is not shown. Hiding is presentation only: each procedure behind a page still decides. The
 * overview needs the whole Delivery plane, so a caller without it starts on the first page they may use.
 */
function Workspace({ session, here, pathname }: { session: ConsoleSession; here: NavItem | null; pathname: string }) {
	const navigate = useNavigate()
	const { lead, sections } = visibleNav(session)
	const first = lead ?? sections[0]?.items[0] ?? null
	const redirect = pathname === '/' && lead === null ? first : null

	useEffect(() => {
		if (redirect !== null) navigate(redirect.to)
	}, [redirect, navigate])

	if (first === null) return <NoAccess session={session} />
	if (redirect !== null) return <div className="loading">Loading console…</div>
	if (here !== null && !mayOpen(session, here.to)) return <NotAvailable />
	return (
		<Outlet
			fallback={<div className="loading">Loading console…</div>}
			errorFallback={(error) => <RouteError error={error} />}
		/>
	)
}

export function NoAccess({ session }: { session: ConsoleSession }) {
	return (
		<div className="gate-screen">
			<p className="eyebrow">Console</p>
			<h1>You have no access to this console yet</h1>
			<p>
				{session.principal === null ? 'You are signed in' : (
					<>
						You are signed in as <strong title={session.principal.id}>{session.principal.label}</strong>
					</>
				)}, but no role in this console is granted to you. Ask an administrator to grant you a role.
			</p>
			{session.signOutUrl !== null && <a href={session.signOutUrl} className="btn">Sign in as someone else</a>}
		</div>
	)
}

function NotAvailable() {
	return (
		<div className="gate-screen">
			<p className="eyebrow">Console</p>
			<h1>This page is not available to you</h1>
			<p>None of your roles in this console includes it. Ask an administrator if you need it.</p>
		</div>
	)
}

export function SignedIn({ session }: { session: ConsoleSession }) {
	return (
		<>
			{session.principal !== null && (
				<span className="signed-in" title={`Signed in as ${session.principal.label} (${session.principal.id})`}>
					{session.principal.label}
				</span>
			)}
			{session.signOutUrl !== null && <a href={session.signOutUrl} className="btn small ghost">Sign out</a>}
		</>
	)
}

/** Pins light or dark for this browser; with nothing pinned the console follows the OS. */
function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>('light')

	// Read after mount — `effectiveTheme()` touches localStorage and matchMedia.
	useEffect(() => setTheme(effectiveTheme()), [])

	function flip() {
		const next: Theme = theme === 'dark' ? 'light' : 'dark'
		pinTheme(next)
		setTheme(next)
	}

	return (
		<button
			type="button"
			className="icon-btn"
			onClick={flip}
			title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
			aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
		>
			<Icon name={theme === 'dark' ? 'sun' : 'moon'} />
		</button>
	)
}
