// The step-up on deciding a pending item (ADR-0050 §5): when deciding takes a passkey, the page asks Control for a
// challenge bound to this one decision, the browser answers it with one of the person's passkeys, and the decision is
// posted with the answer. A change of protection that weakens what deciding takes goes the same way. IAM verifies it
// through Control; the page decides nothing.

import { RpcError } from '@fabrika/app'
import type { ApprovalStepUp, ApprovalStepUpChallenge, StepUpMode } from '@fabrika/control-contract'
import { ceremonyFailure, PasskeyCeremonyError, type PasskeyCredentials, stepUpWithPasskey } from './webauthn'

/** What a step-up confirms: a decision of a pending item, or a change of an environment's protection. */
export type StepUpSubject = 'decision' | 'change'

/** The person holds no passkey, so what takes one cannot be confirmed until they register one. */
export class NoPasskeyError extends Error {
	constructor(what: StepUpSubject) {
		super(
			what === 'decision'
				? 'You have no passkey, and this decision takes one. Register one under Account → Passkeys, then decide.'
				: 'You have no passkey, and this change takes one. Register one under Account → Passkeys, then save again.',
		)
	}
}

/**
 * Post one decision or change: under `webauthn` the passkey prompt runs first, on a challenge bound to it, and it
 * carries the answer; under `none` it is posted as it is. Nothing is posted when the prompt fails.
 */
export async function postDecision<T>(
	mode: StepUpMode,
	credentials: PasskeyCredentials | null,
	challenge: () => Promise<ApprovalStepUpChallenge>,
	post: (stepUp: ApprovalStepUp | undefined) => Promise<T>,
	what: StepUpSubject,
): Promise<T> {
	if (mode === 'none') return post(undefined)
	if (credentials === null) throw new PasskeyCeremonyError(`This browser cannot use passkeys, so this ${what} cannot be confirmed here.`)
	const stepUp = await stepUpWithPasskey(credentials, async () => {
		const issued = await challenge()
		if (issued.kind === 'no-passkey') throw new NoPasskeyError(what)
		return issued.challenge
	})
	return post(stepUp)
}

/** Why a decision was not recorded, in the console's words; `noPasskey` adds the way to register one. */
export interface DecisionFailure {
	readonly message: string
	readonly noPasskey: boolean
}

export function decisionFailure(cause: unknown): DecisionFailure {
	if (cause instanceof NoPasskeyError) return { message: cause.message, noPasskey: true }
	if (cause instanceof RpcError) return { message: cause.message, noPasskey: false }
	if (cause instanceof PasskeyCeremonyError || cause instanceof DOMException) return { message: ceremonyFailure(cause), noPasskey: false }
	return { message: 'The decision was not recorded.', noPasskey: false }
}
