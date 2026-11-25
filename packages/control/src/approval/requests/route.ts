// D8 (ADR-0083 §1, §3): a write a non-person makes directly, in a category a protected environment judges, meets the
// gate before its use case runs. `off` lets it apply with the caller's own authority; `refuse` is a 403 naming the
// category; `person` stores it as an approval request, exactly as `approvals.requests.create` would, and answers 409
// `approval_requested` with the request's link, so the write never reads as applied. A person in the console applies.

import { type ActionCategory, APPROVAL_REQUESTED, type CreateApprovalRequestResponse, gate } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { ControlApiError, fail } from '../../api/domain'
import { isConsolePerson } from '../human'
import { type ApprovalRequestContext, createApprovalRequestUseCase, refusedToNonPerson } from './api'
import type { RequestCoordinates } from './kind'
import { judging, policyOf, reachOf, refusingEnvironment } from './rules'

/** One direct write the gate judges: the procedure, which is also the kind of the request it becomes. */
export interface DirectWrite {
	readonly kind: string
	readonly category: ActionCategory
	/** Where it acts: one environment, or `ALL_ENVIRONMENTS` for the all-environments layer and an application-wide write. */
	readonly coordinates: RequestCoordinates
	/** The procedure's checked input, which the request stores as asked. */
	readonly input: JsonValue
}

/**
 * Apply `write` (`apply`) when the caller is a person in the console, when no protected environment it reaches judges it,
 * or when every one that does has its category `off`. Otherwise refuse it (403) or store it as a request and answer 409
 * `approval_requested`: the write did not apply. What the write names that does not exist is left to its use case.
 */
export async function gateDirectWrite<T>(c: ApprovalRequestContext, write: DirectWrite, apply: () => Promise<T>): Promise<T> {
	if (isConsolePerson(c.auth, c.admission)) return apply()
	const reach = await reachOf(c.repositories.registry, write.coordinates)
	if (reach === null) return apply()
	const refusing = refusingEnvironment(reach, write.category)
	if (refusing !== null) fail(403, refusedToNonPerson(refusing.env, write.category))
	if (!judging(reach).some((appEnv) => gate({ lines: [], actions: [write.category] }, policyOf(appEnv)).kind === 'wait')) return apply()
	throw approvalRequested(await createApprovalRequestUseCase(c, { kind: write.kind, input: write.input }))
}

/** The answer of a routed write: it did not apply, and the message names the link, so an older client shows it too. */
function approvalRequested(created: CreateApprovalRequestResponse): ControlApiError {
	const fingerprint = created.fingerprint === undefined ? '' : `; the value's fingerprint is ${created.fingerprint}`
	return new ControlApiError(
		409,
		`the change was not made: it waits for a person, who approves or refuses it at ${created.url}${fingerprint}. `
			+ 'Hand the person that link; nothing changes until they approve it',
		{
			type: APPROVAL_REQUESTED,
			data: {
				id: created.id,
				url: created.url,
				state: created.state,
				...(created.fingerprint === undefined ? {} : { fingerprint: created.fingerprint }),
			},
		},
	)
}
