import type { JSX } from 'react'
import type { ConnStatus } from '../lib/types'

const LABEL: Record<ConnStatus, string> = {
	connecting: 'connecting…',
	live: 'live',
	offline: 'offline',
	fixture: 'fixture',
}

const DOT: Record<ConnStatus, string> = {
	connecting: 'bg-accent-amber',
	live: 'bg-accent-green',
	offline: 'bg-accent-red',
	fixture: 'bg-accent-blue',
}

export function Header({
	sessionId,
	status,
	watching,
}: {
	sessionId: string
	status: ConnStatus
	watching: boolean
}): JSX.Element {
	return (
		<header className="flex h-11 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-surface px-4">
			<div className="flex items-center gap-2 text-body text-text-secondary">
				<span className="text-text-tertiary">session</span>
				<span className="rounded bg-bg-elevated px-2 py-0.5 font-mono text-code text-text-primary">
					{sessionId}
				</span>
			</div>
			<div className="flex items-center gap-4">
				{watching && (
					<span className="flex items-center gap-1.5 text-tiny text-text-tertiary">
						<span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-accent-blue" />
						agent watching
					</span>
				)}
				<span className="flex items-center gap-1.5 text-tiny text-text-secondary">
					<span className={`inline-flex h-2 w-2 rounded-full ${DOT[status]}`} />
					{LABEL[status]}
				</span>
			</div>
		</header>
	)
}
