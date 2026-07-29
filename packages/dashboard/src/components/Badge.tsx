import type { ReactNode } from 'react'
import type { DeploymentNamespaceState, RunStatus } from '../lib/api'

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'muted'

interface BadgeProps {
	tone?: Tone
	children: ReactNode
	title?: string
}

/** A small inline status pill. */
export function Badge({ tone = 'neutral', children, title }: BadgeProps) {
	return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}

/** Map a run status to its tone — pending (neutral), running (warn), succeeded (good), failed (bad). */
function runTone(status: RunStatus): Tone {
	switch (status) {
		case 'succeeded':
			return 'good'
		case 'failed':
			return 'bad'
		case 'running':
			return 'warn'
		default:
			return 'neutral'
	}
}

/** A toned status pill for a deploy run, with a pulsing dot while running. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
	return (
		<span className={`badge badge-${runTone(status)}`}>
			{status === 'running' && <span className="run-dot" aria-hidden="true" />}
			{status}
		</span>
	)
}

/** Placement lifecycle status, using the same quiet operational tones as deploy runs. */
export function NamespaceStateBadge({ state }: { state: DeploymentNamespaceState }) {
	const tone: Tone = state === 'ready' ? 'good' : state === 'failed' ? 'bad' : state === 'provisioning' ? 'warn' : 'neutral'
	return <Badge tone={tone}>{state}</Badge>
}
