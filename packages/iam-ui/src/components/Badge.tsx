import type { ReactNode } from 'react'

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'muted'

interface BadgeProps {
	tone?: Tone
	children: ReactNode
	title?: string
}

/**
 * A small tinted label for a CATEGORY worth calling out — where a grant came from, what origin a role
 * has, whether a role key still resolves. Never a lifecycle status: that is a lamp (see `Status`),
 * because a reader must be able to tell "what kind of thing is this" from "how is it doing".
 */
export function Badge({ tone = 'neutral', children, title }: BadgeProps) {
	return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}
