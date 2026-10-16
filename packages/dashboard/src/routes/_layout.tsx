import { Link, Outlet, useNavigate, useRoute } from '@buzola/router'
import { useEffect, useRef, useState } from 'react'
// The console ships from the installation's own checkout, whose packages carry the release's version
// (`release:validate` holds every package and the tag to it), so the console's version is the installation's.
import { version as fabrikaVersion } from '../../package.json'
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
	useFoldedHead(pathname)
	const here = [LEAD, ...NAV.flatMap((section) => section.items)].find((item) => isActive(item, pathname)) ?? null

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand">
					<span className="brand-badge">
						<span className="brand-mark" aria-hidden="true">
							<BrandMark size={26} />
						</span>
						<span className="brand-name">fabrika</span>
					</span>
				</div>
				<div className="sidebar-scroll">
					{session !== null && <Navigation caller={session} pathname={pathname} />}
				</div>
				<div className="sidebar-account">
					<AccountMenu session={session} />
				</div>
			</aside>
			<main className="content">
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

/**
 * Plays a fold as motion: the title glides and scales to its new place and the button follows, and the lines that come
 * back on unfolding fade in. The layout itself switches at once (FLIP), so the measured heights stay exact and the work
 * under the head never moves; only transforms and opacity animate.
 */
function glide(workspace: Element, change: () => void) {
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	const moving = [...workspace.querySelectorAll<HTMLElement>(':scope > .page-head :is(h1, .page-head-row > :not(:first-child))')]
	// A fold in the middle of the last one starts from where things are drawn now, not from that one's start.
	for (const element of moving) for (const animation of element.getAnimations()) animation.cancel()
	const before = moving.map((element) => ({ box: element.getBoundingClientRect(), font: parseFloat(getComputedStyle(element).fontSize) }))
	change()
	if (reduced) return
	const timing = { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
	moving.forEach((element, index) => {
		const from = before[index]
		const to = element.getBoundingClientRect()
		if (from === undefined || to.width === 0) return
		// The title scales by its type size: its box is as wide as its column, which the fold also changes.
		const scale = element.tagName === 'H1' ? from.font / parseFloat(getComputedStyle(element).fontSize) : 1
		element.animate(
			[
				{ transformOrigin: 'left top', transform: `translate(${from.box.left - to.left}px, ${from.box.top - to.top}px) scale(${scale})` },
				{ transformOrigin: 'left top', transform: 'none' },
			],
			timing,
		)
	})
	for (const line of workspace.querySelectorAll(':scope > .page-head :is(.back-link, .hint, .subtitle)')) {
		if (line.getClientRects().length > 0) line.animate([{ opacity: 0 }, { opacity: 1 }], timing)
	}
}

/**
 * Folds the page's sticky head to one line once the page scrolls. The fold must not change the page's height, or a page
 * barely longer than the window would fold, lose its scroll, unfold and fold again: so the folded head keeps the height
 * it gave up as margin below it (`--fold-gap`), measured whenever the head changes, and the work under it never moves. Done on
 * the DOM rather than in state, because the measurement has to happen between the two layouts, before a paint.
 */
function useFoldedHead(pathname: string) {
	useEffect(() => {
		const shell = document.querySelector<HTMLElement>('.app-shell')
		const workspace = document.querySelector('.workspace')
		if (shell === null || workspace === null) return
		let folded = false
		let gap = 0
		// The head can change in place, with no new child of the workspace: the same page showing another app, or a head
		// whose content arrives after the loader. Its own text and children are watched too (not its attributes, which
		// `apply` writes), so its height is measured again.
		let watched: HTMLElement | null = null
		const headChanges = new MutationObserver(() => apply())

		const fold = (next: boolean) => {
			folded = next
			shell.setAttribute('data-folded', String(next))
		}
		// The fold waits until the work has scrolled up by the height the head gives up, so the work meets the folded
		// head's edge exactly as it folds, with no empty band under it.
		const apply = () => {
			// Only the head that opens the page folds: the styles that keep its height (`--fold-gap`) are written for it,
			// and a page that sets a link above its head would lose that height and jump.
			const head = workspace.querySelector<HTMLElement>(':scope > .page-head:first-child')
			if (head !== watched) {
				headChanges.disconnect()
				if (head !== null) headChanges.observe(head, { childList: true, subtree: true, characterData: true })
				watched = head
			}
			if (head === null) {
				// Nothing folds here, so no scroll position may fold it.
				gap = Number.POSITIVE_INFINITY
				return fold(false)
			}
			shell.setAttribute('data-folded', 'false')
			const open = head.offsetHeight
			shell.setAttribute('data-folded', 'true')
			gap = open - head.offsetHeight
			head.style.setProperty('--fold-gap', `${gap}px`)
			fold(window.scrollY > 0 && window.scrollY >= gap)
		}
		// Folds at the gap and unfolds a little above it, so a scroll resting on the edge does not flicker.
		const onScroll = () => {
			const next = folded ? window.scrollY > Math.max(0, gap - 8) : window.scrollY > 0 && window.scrollY >= gap
			if (next !== folded) glide(workspace, () => fold(next))
		}

		apply()
		// A page renders its head once its loader answers, so a new head is measured afresh.
		const mutations = new MutationObserver(apply)
		mutations.observe(workspace, { childList: true })
		window.addEventListener('scroll', onScroll, { passive: true })
		window.addEventListener('resize', apply)
		return () => {
			mutations.disconnect()
			headChanges.disconnect()
			window.removeEventListener('scroll', onScroll)
			window.removeEventListener('resize', apply)
		}
	}, [pathname])
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

/** Read once per console load; until it answers, the rail shows nothing rather than a guess. */
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
				<div className="nav-section">
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

/**
 * Everything that belongs to the person rather than to the page: who is signed in, their builder connections, the
 * theme and sign-out. Behind the avatar at the rail's foot, so the workspace holds only the page. The
 * panel is always rendered and hidden while closed, so it costs the page nothing to find its links.
 */
function AccountMenu({ session }: { session: ConsoleSession | null }) {
	const [open, setOpen] = useState(false)
	const root = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		function onPointer(event: PointerEvent) {
			if (event.target instanceof Node && root.current !== null && !root.current.contains(event.target)) setOpen(false)
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape') setOpen(false)
		}
		document.addEventListener('pointerdown', onPointer)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('pointerdown', onPointer)
			document.removeEventListener('keydown', onKey)
		}
	}, [open])

	const principal = session?.principal ?? null
	return (
		<div className="account" ref={root}>
			<button
				type="button"
				className="account-trigger"
				aria-expanded={open}
				aria-controls="account-panel"
				aria-label="Account and settings"
				onClick={() => setOpen((value) => !value)}
			>
				{principal === null ? <Icon name="users" /> : <span className="avatar" aria-hidden="true">{initials(principal.label)}</span>}
				<span className="account-name">{principal?.label ?? 'Account'}</span>
				<Icon name="chevron-down" size={13} />
			</button>
			<div id="account-panel" className="account-panel" hidden={!open}>
				{session !== null && <SignedIn session={session} />}
				<Link to="builder/authorize" className="account-item" onClick={() => setOpen(false)}>
					<Icon name="terminal" />
					Your builder connections
				</Link>
				<ThemeToggle />
				{session !== null && <SignOut session={session} />}
				{/* Which release this installation runs: what a bug report or an upgrade needs first. */}
				<p className="account-version">fabrika {fabrikaVersion}</p>
			</div>
		</div>
	)
}

/** The account panel's last item: IAM's sign-out confirmation, when the installation publishes IAM's origin. */
export function SignOut({ session }: { session: ConsoleSession }) {
	if (session.signOutUrl === null) return null
	return (
		<a href={session.signOutUrl} className="account-item account-signout">
			<Icon name="arrow-right" />
			Sign out
		</a>
	)
}

/** Who is signed in, at the head of the account panel; sign-out itself is the panel's last item. */
export function SignedIn({ session }: { session: ConsoleSession }) {
	if (session.principal === null) return null
	return (
		<span className="signed-in" title={`Signed in as ${session.principal.label} (${session.principal.id})`}>
			<span className="avatar" aria-hidden="true">{initials(session.principal.label)}</span>
			<span className="signed-in-name">{session.principal.label}</span>
		</span>
	)
}

/** Two letters for the avatar: the first of two words, or the first two of one (`admin@local.test` reads `AD`). */
export function initials(label: string): string {
	const words = label.split('@')[0]?.split(/[\s._-]+/).filter((word) => word !== '') ?? []
	const first = words[0] ?? '?'
	const second = words[1]
	return (second === undefined ? first.slice(0, 2) : `${first[0] ?? ''}${second[0] ?? ''}`).toUpperCase()
}

/** Pins light or dark for this browser; with nothing pinned the console follows the OS. */
function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>('light')

	// Read after mount: `effectiveTheme()` touches localStorage and matchMedia.
	useEffect(() => setTheme(effectiveTheme()), [])

	function flip() {
		const next: Theme = theme === 'dark' ? 'light' : 'dark'
		pinTheme(next)
		setTheme(next)
	}

	return (
		<button type="button" className="account-item" onClick={flip} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
			<Icon name={theme === 'dark' ? 'sun' : 'moon'} />
			{theme === 'dark' ? 'Light theme' : 'Dark theme'}
		</button>
	)
}
