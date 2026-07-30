// The console's one icon set — hand-drawn on a 24px grid, stroked at 1.75 so it reads a touch finer
// than the usual 2px UI icon and closer to a drafted line. Inline SVG on purpose: no icon dependency,
// and the optical weight stays ours. Icons clarify; anything purely decorative doesn't belong here.

import type { ReactNode } from 'react'

export type IconName =
	// Navigation
	| 'gauge'
	| 'app'
	| 'bay'
	| 'runs'
	| 'users'
	| 'key'
	| 'link'
	| 'shield'
	| 'medal'
	| 'schema'
	| 'history'
	// Actions & affordances
	| 'plus'
	| 'search'
	| 'close'
	| 'check'
	| 'alert'
	| 'refresh'
	| 'external'
	| 'copy'
	| 'trash'
	| 'bolt'
	| 'filter'
	| 'terminal'
	// Direction
	| 'chevron-right'
	| 'chevron-down'
	| 'chevron-left'
	| 'arrow-right'
	// Metadata
	| 'branch'
	| 'commit'
	| 'clock'
	| 'globe'
	| 'lock'
	// Theme
	| 'sun'
	| 'moon'

const GLYPHS: Record<IconName, ReactNode> = {
	gauge: (
		<>
			<path d="M3.5 16.25a8.5 8.5 0 1 1 17 0" />
			<path d="M12 16.25 16.25 10" />
			<circle cx="12" cy="16.25" r="1.35" fill="currentColor" stroke="none" />
		</>
	),
	app: (
		<>
			<path d="M12 2.9 20.1 7.4v9.2L12 21.1 3.9 16.6V7.4z" />
			<path d="M3.9 7.4 12 11.9l8.1-4.5" />
			<path d="M12 11.9v9.2" />
		</>
	),
	// A bounded bay on the floor: four corner brackets around one machine cell.
	bay: (
		<>
			<path d="M8.5 3.5H5.25A1.75 1.75 0 0 0 3.5 5.25V8.5" />
			<path d="M15.5 3.5h3.25a1.75 1.75 0 0 1 1.75 1.75V8.5" />
			<path d="M8.5 20.5H5.25A1.75 1.75 0 0 1 3.5 18.75V15.5" />
			<path d="M15.5 20.5h3.25a1.75 1.75 0 0 0 1.75-1.75V15.5" />
			<rect x="9" y="9" width="6" height="6" rx="1.25" />
		</>
	),
	runs: <path d="M2.75 12h4.1l2.4-6.75 4.6 13.5 2.35-6.75h5.05" />,
	users: (
		<>
			<circle cx="9.5" cy="8.25" r="3.4" />
			<path d="M3.5 19.75a6.2 6.2 0 0 1 12 0" />
			<path d="M16.4 5.35a3.4 3.4 0 0 1 0 5.8" />
			<path d="M17.6 13.9a5.6 5.6 0 0 1 3.15 4" />
		</>
	),
	key: (
		<>
			<circle cx="7.75" cy="16.25" r="3.5" />
			<path d="M10.35 13.65 19 5" />
			<path d="M16.4 7.6 18.6 9.8" />
			<path d="M14.2 9.8l2.2 2.2" />
		</>
	),
	link: (
		<>
			<path d="M10.6 13.4a4.2 4.2 0 0 0 5.94 0l2.5-2.5a4.2 4.2 0 0 0-5.94-5.94l-1.3 1.3" />
			<path d="M13.4 10.6a4.2 4.2 0 0 0-5.94 0l-2.5 2.5a4.2 4.2 0 0 0 5.94 5.94l1.3-1.3" />
		</>
	),
	shield: (
		<>
			<path d="M12 2.9 4.9 5.6v5.75c0 4.3 2.9 7.95 7.1 9.55 4.2-1.6 7.1-5.25 7.1-9.55V5.6z" />
			<path d="M9.1 11.85 11.3 14.1 15 10" />
		</>
	),
	medal: (
		<>
			<circle cx="12" cy="9.25" r="5.25" />
			<path d="M8.6 13.5 7.4 21l4.6-2.55L16.6 21l-1.2-7.5" />
		</>
	),
	schema: (
		<>
			<path d="M5.6 3.6v15.15a1.75 1.75 0 0 0 1.75 1.75h3.15" />
			<path d="M5.6 4.5h5.1" />
			<path d="M5.6 12.25h5.1" />
			<rect x="10.7" y="2.75" width="9.05" height="3.5" rx="1.1" />
			<rect x="10.7" y="10.5" width="9.05" height="3.5" rx="1.1" />
			<rect x="10.7" y="18.25" width="9.05" height="3.5" rx="1.1" />
		</>
	),
	history: (
		<>
			<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.05" />
			<path d="M3.6 4.1v4.2h4.2" />
			<path d="M12 7.7V12l3.1 1.85" />
		</>
	),
	plus: <path d="M12 5.25v13.5M5.25 12h13.5" />,
	search: (
		<>
			<circle cx="10.6" cy="10.6" r="6.35" />
			<path d="M15.3 15.3 20 20" />
		</>
	),
	close: <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />,
	check: <path d="M4.75 12.4 9.5 17.15 19.25 6.85" />,
	alert: (
		<>
			<path d="M12 3.6 21.1 20H2.9z" />
			<path d="M12 9.85v4.35" />
			<circle cx="12" cy="17.2" r="0.95" fill="currentColor" stroke="none" />
		</>
	),
	refresh: (
		<>
			<path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.05" />
			<path d="M20.4 3.85v4.3h-4.3" />
		</>
	),
	external: (
		<>
			<path d="M14.25 4.25h5.5v5.5" />
			<path d="M19.75 4.25 11.1 12.9" />
			<path d="M18 13.9v4.6a1.75 1.75 0 0 1-1.75 1.75H5.5A1.75 1.75 0 0 1 3.75 18.5V7.75A1.75 1.75 0 0 1 5.5 6h4.6" />
		</>
	),
	copy: (
		<>
			<rect x="8.9" y="8.9" width="11.6" height="11.6" rx="2" />
			<path d="M15.1 6.15V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2v7.6a2 2 0 0 0 2 2h.65" />
		</>
	),
	trash: (
		<>
			<path d="M4.4 6.4h15.2" />
			<path d="M9.5 6.4V4.85A1.35 1.35 0 0 1 10.85 3.5h2.3a1.35 1.35 0 0 1 1.35 1.35V6.4" />
			<path d="M6.4 6.4 7.3 19.35a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 6.4" />
		</>
	),
	bolt: <path d="M13.55 2.75 5.6 13.6h5.15L10.45 21.25 18.4 10.4h-5.15z" />,
	filter: <path d="M3.6 5.4h16.8l-6.65 7.9v5.5l-3.5 2v-7.5z" />,
	terminal: (
		<>
			<path d="M5.6 7.5 10.1 12l-4.5 4.5" />
			<path d="M12.4 16.5h6" />
		</>
	),
	'chevron-right': <path d="M9.5 5.5 16 12l-6.5 6.5" />,
	'chevron-down': <path d="M5.5 9.5 12 16l6.5-6.5" />,
	'chevron-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
	'arrow-right': <path d="M4.25 12h15.5M13.4 5.65 19.75 12l-6.35 6.35" />,
	branch: (
		<>
			<circle cx="7" cy="5.9" r="2.65" />
			<circle cx="7" cy="18.1" r="2.65" />
			<circle cx="17" cy="7.9" r="2.65" />
			<path d="M7 8.55v6.9" />
			<path d="M17 10.55v.55a4.35 4.35 0 0 1-4.35 4.35H9.65" />
		</>
	),
	commit: (
		<>
			<circle cx="12" cy="12" r="3.35" />
			<path d="M2.75 12h5.9M15.35 12h5.9" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="8.4" />
			<path d="M12 6.9v5.35l3.3 2" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="8.4" />
			<path d="M3.7 12h16.6" />
			<path d="M12 3.6a12.6 12.6 0 0 1 0 16.8 12.6 12.6 0 0 1 0-16.8z" />
		</>
	),
	lock: (
		<>
			<rect x="4.6" y="10.1" width="14.8" height="10.3" rx="2" />
			<path d="M8 10.1V7.4a4 4 0 0 1 8 0v2.7" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="4.15" />
			<path d="M12 2.9v2.1M12 19v2.1M4.55 4.55 6.05 6.05M17.95 17.95l1.5 1.5M2.9 12H5M19 12h2.1M4.55 19.45l1.5-1.5M17.95 6.05l1.5-1.5" />
		</>
	),
	moon: <path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7 8.6 8.6 0 1 0 20.3 14.6z" />,
}

interface IconProps {
	name: IconName
	/** Rendered box in px. 16 for inline/nav, 18 for buttons, 20+ for feature marks. */
	size?: number
	className?: string
}

export function Icon({ name, size = 16, className }: IconProps) {
	return (
		<svg
			className={className === undefined ? 'icon' : `icon ${className}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{GLYPHS[name]}
		</svg>
	)
}
