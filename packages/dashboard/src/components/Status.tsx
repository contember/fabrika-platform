// Status marks. The console's rule: STATUS is a lamp (a dot with a soft halo, the way an annunciator
// panel reports a channel), CATEGORY is a chip (env, provider, trigger). Two different kinds of fact
// must not look alike, which is why nothing here renders a coloured pill.

import type { ReactNode } from 'react'
// Aliased: the components below carry the plain names, the wire types are the values they map from.
import type { DeploymentNamespaceState, RunStatus as RunStatusValue } from '../lib/api'

/** ok = settled good · run = in flight (the lamp pulses) · stop = failed · idle = nothing happening. */
export type Lamp = 'ok' | 'run' | 'stop' | 'idle'

/** A lamp on its own, for tight spots (feed rows, table cells with their own label). */
export function StatusLamp({ lamp }: { lamp: Lamp }) {
	return (
		<span className={`status status-${lamp}`}>
			<span className="lamp" aria-hidden="true" />
		</span>
	)
}

/** A lamp plus its label — the default way to report state. */
export function Status({ lamp, children }: { lamp: Lamp; children: ReactNode }) {
	return (
		<span className={`status status-${lamp}`}>
			<span className="lamp" aria-hidden="true" />
			{children}
		</span>
	)
}

/** A categorical chip: env, provider, trigger — facts that classify rather than report health. */
export function Chip({ children, accent, title }: { children: ReactNode; accent?: boolean; title?: string }) {
	return <span className={accent === true ? 'chip chip-accent' : 'chip'} title={title}>{children}</span>
}

export function runLamp(status: RunStatusValue): Lamp {
	switch (status) {
		case 'succeeded':
			return 'ok'
		case 'failed':
			return 'stop'
		case 'running':
			return 'run'
		default:
			return 'idle'
	}
}

export function namespaceLamp(state: DeploymentNamespaceState): Lamp {
	switch (state) {
		case 'ready':
			return 'ok'
		case 'failed':
			return 'stop'
		case 'provisioning':
			return 'run'
		default:
			return 'idle'
	}
}

/** Deploy-run state: `pending` reads as `queued`, which is what an operator is actually waiting on. */
export function RunStatus({ status }: { status: RunStatusValue }) {
	return <Status lamp={runLamp(status)}>{status === 'pending' ? 'queued' : status}</Status>
}

export function NamespaceState({ state }: { state: DeploymentNamespaceState }) {
	return <Status lamp={namespaceLamp(state)}>{state}</Status>
}
