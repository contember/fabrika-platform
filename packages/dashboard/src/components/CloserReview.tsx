/**
 * The mark of a line the approver reads the code behind, not only the line: a step off the paved road (declared reach,
 * database code) or a change the access diff cannot classify. A category, so a badge, never a lamp.
 */
export function CloserReview() {
	return <span className="badge badge-warn">needs closer review</span>
}
