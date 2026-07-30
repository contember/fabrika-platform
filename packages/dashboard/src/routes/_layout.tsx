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
	| 'access/principals'
	| 'access/api-keys'
	| 'access/share-links'
	| 'access/policies'
	| 'access/roles'
	| 'access/schema'
	| 'access/audit'

interface NavItem {
	to: Page
	label: string
	/** Shown in the context bar once you're on the page — the rail itself stays label-only. */
	description: string
	icon: IconName
	match: string
}

interface NavSection {
	label: string
	items: NavItem[]
}

/** The overview spans both planes, so it sits above them rather than inside either section. */
const LEAD: NavItem = { to: 'index', label: 'Overview', description: 'Both planes at a glance', icon: 'gauge', match: '/' }

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
			{ to: 'access/principals', label: 'Principals', description: 'People and services', icon: 'users', match: '/access/principals' },
			{ to: 'access/api-keys', label: 'API keys', description: 'Machine credentials', icon: 'key', match: '/access/api-keys' },
			{ to: 'access/share-links', label: 'Share links', description: 'Scoped guest access', icon: 'link', match: '/access/share-links' },
			{ to: 'access/policies', label: 'Policies', description: 'Authorization rules', icon: 'shield', match: '/access/policies' },
			{ to: 'access/roles', label: 'Roles', description: 'Reusable grants', icon: 'medal', match: '/access/roles' },
			{ to: 'access/schema', label: 'Schema', description: 'Resource vocabulary', icon: 'schema', match: '/access/schema' },
			{ to: 'access/audit', label: 'Audit', description: 'Decisions and events', icon: 'history', match: '/access/audit' },
		],
	},
]

function isActive(item: NavItem, pathname: string): boolean {
	return item.match === '/' ? pathname === '/' : pathname === item.match || pathname.startsWith(`${item.match}/`)
}

export default function RootLayout() {
	const { pathname } = useRoute()
	// The overview spans both planes, so it isn't filed under either.
	const plane = pathname === '/' ? 'Console' : pathname.startsWith('/access') ? 'Access' : 'Delivery'
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
			</aside>
			<main className="content">
				<header className="context-bar">
					<div className="bar-inner">
						<div className="crumbs">
							<span className="crumb-plane">{plane}</span>
							<Icon name="chevron-right" size={13} />
							<span className="crumb-here">{here?.label ?? 'Console'}</span>
							{here !== null && <span className="crumb-note dot-sep">{here.description}</span>}
						</div>
						<div className="bar-actions">
							{/* Both planes answer on one origin — worth stating, because in most installs they don't. */}
							<span className="endpoint" title="Control plane and IAM answer on this one origin">
								<span className="lamp" aria-hidden="true" />
								Control + IAM
							</span>
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
		<Link to={item.to} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
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
