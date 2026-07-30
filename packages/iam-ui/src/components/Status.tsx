// Status marks, in the console's vocabulary: STATUS is a lamp (a dot with a soft halo, the way an
// annunciator panel reports a channel), CATEGORY is a chip or a badge. The delivery plane already
// speaks this language; the access plane used coloured pills for both kinds of fact, which made an
// `active` principal look like a `prod` label. Mirrors `@fabrika/dashboard`'s Status, name for name —
// the shared stylesheet owns `.status` / `.lamp` / `.chip`.

import type { ReactNode } from 'react'

/** ok = settled good · run = in flight (the lamp pulses) · stop = failed · idle = nothing happening. */
export type Lamp = 'ok' | 'run' | 'stop' | 'idle'

/** A lamp plus its label — the default way to report state. */
export function Status({ lamp, children, title }: { lamp: Lamp; children: ReactNode; title?: string }) {
	return (
		<span className={`status status-${lamp}`} title={title}>
			<span className="lamp" aria-hidden="true" />
			{children}
		</span>
	)
}

/** A lamp on its own, for tight spots (feed rows, cells that already carry their own label). */
export function StatusLamp({ lamp }: { lamp: Lamp }) {
	return (
		<span className={`status status-${lamp}`}>
			<span className="lamp" aria-hidden="true" />
		</span>
	)
}

/** A principal's or credential's lifecycle state. `invited` is in flight — nobody has signed in yet. */
export function PrincipalStatus({ status }: { status: 'invited' | 'active' | 'disabled' }) {
	return <Status lamp={principalLamp(status)}>{status}</Status>
}

export function principalLamp(status: 'invited' | 'active' | 'disabled'): Lamp {
	return status === 'active' ? 'ok' : status === 'invited' ? 'run' : 'idle'
}

/** A categorical chip: app, scope dimension, role origin — facts that classify rather than report health. */
export function Chip({ children, accent, title }: { children: ReactNode; accent?: boolean; title?: string }) {
	return <span className={accent === true ? 'chip chip-accent' : 'chip'} title={title}>{children}</span>
}
