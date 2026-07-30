import { Link, Outlet, useRoute } from '@buzola/router'
import { RouteError } from '../components/RouteError'

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
	description: string
	match: string
}

interface NavSection {
	label: string
	items: NavItem[]
}

const NAV: NavSection[] = [
	{
		label: 'Delivery',
		items: [
			{ to: 'index', label: 'Overview', description: 'Start here', match: '/' },
			{ to: 'apps', label: 'Applications', description: 'Sources and targets', match: '/apps' },
			{ to: 'namespaces', label: 'Namespaces', description: 'Runtime boundaries', match: '/namespaces' },
			{ to: 'runs', label: 'Deploy runs', description: 'Build and release log', match: '/runs' },
		],
	},
	{
		label: 'Access',
		items: [
			{ to: 'access/principals', label: 'Principals', description: 'People and services', match: '/access/principals' },
			{ to: 'access/api-keys', label: 'API keys', description: 'Machine credentials', match: '/access/api-keys' },
			{ to: 'access/share-links', label: 'Share links', description: 'Scoped guest access', match: '/access/share-links' },
			{ to: 'access/policies', label: 'Policies', description: 'Authorization rules', match: '/access/policies' },
			{ to: 'access/roles', label: 'Roles', description: 'Reusable grants', match: '/access/roles' },
			{ to: 'access/schema', label: 'Schema', description: 'Resource vocabulary', match: '/access/schema' },
			{ to: 'access/audit', label: 'Audit', description: 'Decisions and events', match: '/access/audit' },
		],
	},
]

export default function RootLayout() {
	const { pathname } = useRoute()
	const activePlane = pathname.startsWith('/access')
		? { label: 'Access plane', description: 'Identity, policy and audit' }
		: { label: 'Delivery plane', description: 'Applications, runtime and releases' }

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">F</span>
					<span className="brand-copy">
						<span className="brand-name">fabrika</span>
						<span className="brand-sub">cloud control plane</span>
					</span>
				</div>
				<nav aria-label="Console navigation">
					{NAV.map((section) => {
						return (
							<div className="nav-section" key={section.label}>
								<div className="nav-section-label">{section.label}</div>
								{section.items.map((item) => {
									const active = item.match === '/'
										? pathname === '/'
										: pathname === item.match || pathname.startsWith(`${item.match}/`)
									return (
										<Link
											key={item.to}
											to={item.to}
											className={`nav-item${active ? ' active' : ''}`}
											aria-current={active ? 'page' : undefined}
										>
											<span>{item.label}</span>
											<span className="nav-description">{item.description}</span>
										</Link>
									)
								})}
							</div>
						)
					})}
				</nav>
				<div className="console-status">
					<span className="status-indicator" aria-hidden="true" />
					<span>
						<strong>Unified endpoint</strong>
						<small>Control and IAM</small>
					</span>
				</div>
			</aside>
			<main className="content">
				<header className="context-bar">
					<div>
						<span className="context-kicker">{activePlane.label}</span>
						<span className="context-description">{activePlane.description}</span>
					</div>
					<span className="context-coordinate">Fabrika console</span>
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
