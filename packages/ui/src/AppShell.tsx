import type { ReactNode } from 'react'
import { classNames } from './class-names'
import { CountBadge } from './states'

export interface NavItem {
	readonly label: string
	readonly href: string
	readonly active?: boolean
	readonly count?: number
}

export interface AppShellProps {
	readonly brand: ReactNode
	readonly nav: readonly NavItem[]
	/** The signed-in caller, shown at the end of the top bar. */
	readonly user?: ReactNode
	readonly actions?: ReactNode
	readonly children: ReactNode
	readonly navLabel?: string
	readonly className?: string
}

export function AppShell({ brand, nav, user, actions, children, navLabel = 'Main', className }: AppShellProps) {
	return (
		<div className={classNames('fui-app', 'fui-shell', className)}>
			<div className="fui-shell__sidebar">
				<div className="fui-shell__brand">{brand}</div>
				<nav className="fui-shell__nav" aria-label={navLabel}>
					<ul className="fui-shell__nav-list">
						{nav.map((item) => (
							<li key={item.href}>
								<a
									href={item.href}
									className={classNames('fui-shell__nav-link', item.active && 'fui-shell__nav-link--active')}
									aria-current={item.active ? 'page' : undefined}
								>
									<span className="fui-shell__nav-label">{item.label}</span>
									{item.count !== undefined && <CountBadge count={item.count} />}
								</a>
							</li>
						))}
					</ul>
				</nav>
			</div>
			<div className="fui-shell__body">
				<header className="fui-shell__topbar">
					<div className="fui-shell__actions">{actions}</div>
					{user !== undefined && <div className="fui-shell__user">{user}</div>}
				</header>
				<main className="fui-shell__main">{children}</main>
			</div>
		</div>
	)
}
