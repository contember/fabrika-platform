import type { ReactNode } from 'react'

interface TableProps {
	head: ReactNode
	children: ReactNode
	/** Rendered in place of the body when there are no rows — usually an `<EmptyState>`. */
	empty?: ReactNode
	isEmpty?: boolean
	colSpan?: number
}

/** A tiny semantic table wrapper with a built-in empty state. */
export function Table({ head, children, empty, isEmpty, colSpan = 1 }: TableProps) {
	return (
		<div className="table-wrap">
			<table>
				<thead>{head}</thead>
				<tbody>
					{isEmpty
						? (
							<tr>
								<td className="empty" colSpan={colSpan}>{empty ?? <EmptyState title="Nothing here yet" />}</td>
							</tr>
						)
						: children}
				</tbody>
			</table>
		</div>
	)
}

interface EmptyStateProps {
	title: string
	body?: ReactNode
	/** The one thing to do about it — a link or button, not a list of options. */
	action?: ReactNode
}

/**
 * An empty table should say what belongs there and what to do about it. Mirrors the console's
 * `EmptyState`; the shared stylesheet owns `.empty-state`.
 */
export function EmptyState({ title, body, action }: EmptyStateProps) {
	return (
		<div className="empty-state">
			<div className="empty-title">{title}</div>
			{body !== undefined && <div className="empty-body">{body}</div>}
			{action !== undefined && <div className="empty-actions">{action}</div>}
		</div>
	)
}
