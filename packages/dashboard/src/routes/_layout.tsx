import { Link, Outlet, useRoute } from '@buzola/router'
import { useEffect, useState } from 'react'
import { BrandMark, Icon, type IconName } from '../components/Icon'
import { RouteError } from '../components/RouteError'
import { effectiveTheme, pinTheme, type Theme } from '../lib/theme'

type Page =
	| 'index'
	| 'apps'
	| 'namespaces'
	| 'runs'
	| 'access'
	| 'access/users'
	| 'access/credentials'
	| 'access/permissions'
	| 'access/audit'
	| 'operations'
	| 'operations/errors'
	| 'operations/sources'
	| 'operations/releases'
	| 'operations/health'

interface NavItem {
	to: Page
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
]

function isActive(item: NavItem, pathname: string): boolean {
	if (item.exact === true) return pathname === item.match
	return pathname === item.match || pathname.startsWith(`${item.match}/`)
}

export default function RootLayout() {
	const { pathname } = useRoute()
	// The overview spans all planes, so it isn't filed under any one of them.
	const plane = pathname === '/'
		? 'Console'
		: pathname.startsWith('/access')
		? 'Access'
		: pathname.startsWith('/operations')
		? 'Operations'
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
				<nav aria-label="Console navigation">
					<div className="nav-section nav-lead">
						<NavLink item={LEAD} pathname={pathname} />
					</div>
					{NAV.map((section) => (
						<div className="nav-section" key={section.label}>
							<div className="nav-section-label">{section.label}</div>
							{section.items.map((item) => <NavLink key={item.to} item={item} pathname={pathname} />)}
						</div>
					))}
				</nav>
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
							<ThemeToggle />
						</div>
					</div>
				</header>
				<div className="workspace">
					<Outlet
						fallback={<div className="loading">Loading console…</div>}
						errorFallback={(error) => <RouteError error={error} />}
					/>
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
