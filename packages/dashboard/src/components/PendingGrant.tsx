import { Link } from '@buzola/router'
import type { GrantChangeResponse, GrantRequestDto } from '@fabrika/iam-contract'

/** The request a grant change answered with, when its application's grants wait for approval (ADR-0083); else null. */
export function pendingOf(result: GrantChangeResponse | { pending?: GrantRequestDto }): GrantRequestDto | null {
	return 'pending' in result && result.pending !== undefined ? result.pending : null
}

/** Says that nothing changed yet: another administrator of the application approves the request first. */
export function PendingGrantNotice({ request }: { request: GrantRequestDto }) {
	const what = request.kind === 'revoke' ? 'This revocation' : 'This access'
	return (
		<p className="notice" role="status">
			{what} at <strong>{request.app}</strong> waits for another administrator's approval: nothing changes until then. It is listed under{' '}
			<Link to="approvals">Approvals</Link> until {new Date(request.expiresAt * 1000).toLocaleDateString()}.
		</p>
	)
}
