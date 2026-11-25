// D8 (ADR-0083 §1, §3): a write a non-person makes directly, in a category a protected environment judges, meets the
// gate before its use case runs. `off` lets it apply with the caller's own authority; `refuse` is a 403 naming the
// category; `person` stores it as an approval request, exactly as `approvals.requests.create` would, and answers 409
// `approval_requested` with the request's link, so the write never reads as applied. A person in the console applies.

import { type ActionCategory, ALL_ENVIRONMENTS, APPROVAL_REQUESTED, type CreateApprovalRequestResponse, gate } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { ControlApiError, fail } from '../../api/domain'
import { isConsolePerson, startsProtected } from '../human'
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
 * `approval_requested`: the write did not apply. An environment that does not exist but starts protected has nowhere
 * for a request to wait, so a non-person's write there is refused (403). Anything else the write names that does not
 * exist is left to its use case.
 */
export async function gateDirectWrite<T>(c: ApprovalRequestContext, write: DirectWrite, apply: () => Promise<T>): Promise<T> {
	if (isConsolePerson(c.auth, c.admission)) return apply()
	const reach = await reachOf(c.repositories.registry, write.coordinates)
	if (reach === null) {
		const { appId, env } = write.coordinates
		const registry = c.repositories.registry
		if (env !== ALL_ENVIRONMENTS && (await registry.getApp(appId)) !== null && (await startsProtected(registry, appId, env, null))) {
			fail(403, startsProtectedRefusal(env, write.category))
		}
		return apply()
	}
	const refusing = refusingEnvironment(reach, write.category)
	if (refusing !== null) fail(403, refusedToNonPerson(refusing.env, write.category))
	if (!judging(reach).some((appEnv) => gate({ lines: [], actions: [write.category] }, policyOf(appEnv)).kind === 'wait')) return apply()
	throw approvalRequested(await createApprovalRequestUseCase(c, { kind: write.kind, input: write.input }))
}

/** Why a non-person's write on an environment that does not exist yet but starts protected is refused. */
function startsProtectedRefusal(env: string, category: ActionCategory): string {
	return `environment \`${env}\` starts protected (it is \`prod\`, or it was protected when it was deleted) and does not exist yet, so a `
		+ `${category} write there has no request to wait in: only a person makes it, in the console; an agent, a builder key or a service key cannot`
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
