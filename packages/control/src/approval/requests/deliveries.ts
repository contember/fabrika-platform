// The keys approved requests issued, waiting for the agent that asked (ADR-0083 §8). A key nobody fetched by its
// deadline is dropped from Control and revoked in IAM, so a key nobody holds does not stay valid until it expires.

import type { ControlRepositories } from '../../db'
import type { IamRequestedKeys } from './iam'

/** How long the requester has to fetch a key at least: the request's own deadline, or this long after it was issued. */
export const KEY_DELIVERY_MIN_SECONDS = 3600

/** When an issued key stops waiting for its requester. */
export function keyDeliveryDeadline(requestDeadline: number, now: number): number {
	return Math.max(requestDeadline, now + KEY_DELIVERY_MIN_SECONDS)
}

/** What the sweep did with unfetched keys. */
export interface UnfetchedKeySweepSummary {
	/** Waiting keys past their deadline, dropped from Control. */
	expired: number
	/** Expired keys revoked in IAM, this pass or left from an earlier one. */
	revoked: number
}

export interface UnfetchedKeySweepDeps {
	readonly repositories: Pick<ControlRepositories, 'approvalRequestDeliveries'>
	/** IAM, where an expired key is revoked; absent, it stays expired until a pass that reaches IAM. */
	readonly iamKeys?: IamRequestedKeys
}

/**
 * Drop every waiting key past its deadline, then revoke each expired one in IAM. A revocation that fails is tried again
 * on the next pass; it is logged without the error, which may carry the credentialed request.
 */
export async function sweepUnfetchedKeys(deps: UnfetchedKeySweepDeps): Promise<UnfetchedKeySweepSummary> {
	const deliveries = deps.repositories.approvalRequestDeliveries
	const expired = (await deliveries.expireUnfetched()).length
	let revoked = 0
	if (deps.iamKeys === undefined) return { expired, revoked }
	for (const delivery of await deliveries.listExpired()) {
		try {
			await deps.iamKeys.revoke(delivery.principal_id)
		} catch {
			console.warn(`approval request ${delivery.request_id}: Control could not revoke the unfetched key in IAM; the next sweep tries again`)
			continue
		}
		if (await deliveries.markRevoked(delivery.request_id)) revoked++
	}
	return { expired, revoked }
}
