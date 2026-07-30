// Status marks, in the console's vocabulary: STATUS is a lamp (a dot with a soft halo, the way an
// annunciator panel reports a channel), CATEGORY is a chip or a badge. The delivery plane already
// speaks this language; the access plane used coloured pills for both kinds of fact, which made an
// `active` principal look like a `prod` label. Mirrors `@fabrika/dashboard`'s Status — the shared
// stylesheet owns `.status` / `.lamp`.

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

/** A principal's or credential's lifecycle state. `invited` is in flight — nobody has signed in yet. */
export function StatusLamp({ status }: { status: 'invited' | 'active' | 'disabled' }) {
	const lamp: Lamp = status === 'active' ? 'ok' : status === 'invited' ? 'run' : 'idle'
	return <Status lamp={lamp}>{status}</Status>
}
