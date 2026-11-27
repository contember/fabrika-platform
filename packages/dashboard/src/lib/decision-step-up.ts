// The step-up on deciding a pending item (ADR-0050 §5): when deciding takes a passkey, the page asks Control for a
// challenge bound to this one decision, the person answers it with one of their passkeys on IAM's step-up page, and the
// decision is posted with the challenge's id. A change of protection that weakens what deciding takes goes the same way.
// IAM verifies the answer for Control; the page decides nothing.

import { RpcError } from '@fabrika/app'
import type { ApprovalStepUp, ApprovalStepUpChallenge, StepUpMode } from '@fabrika/control-contract'

/** What a step-up confirms: a decision of a pending item, or a change of an environment's protection. */
export type StepUpSubject = 'decision' | 'change'

/** The person holds no passkey, so what takes one cannot be confirmed until they add one. */
export class NoPasskeyError extends Error {
	constructor(what: StepUpSubject) {
		super(
			what === 'decision'
				? 'You have no passkey, and this decision takes one. Add one on your IAM account page, then decide.'
				: 'You have no passkey, and this change takes one. Add one on your IAM account page, then save again.',
		)
	}
}

/**
 * A decision waiting for its passkey check on IAM's page: `post` sends it with the challenge's id, once the person is back;
 * `renew` asks for a new challenge bound to the same decision, for a check that expired.
 */
export interface PasskeyCheck<T> {
	readonly url: string
	/** Epoch seconds. */
	readonly expiresAt: number
	readonly what: StepUpSubject
	post(): Promise<T>
	renew(): Promise<PasskeyCheck<T>>
}

/** A decision posted at once, or one that waits for the person to confirm it on IAM's page first. */
export type StartedDecision<T> = { kind: 'posted'; value: T } | { kind: 'confirm'; check: PasskeyCheck<T> }

/**
 * Start one decision or change: under `none` it is posted at once; under `webauthn` the challenge bound to it is
 * fetched and nothing is posted until the caller runs the check's `post`, after the person answered it on IAM's page.
 */
export async function startDecision<T>(
	mode: StepUpMode,
	challenge: () => Promise<ApprovalStepUpChallenge>,
	post: (stepUp: ApprovalStepUp | undefined) => Promise<T>,
	what: StepUpSubject,
): Promise<StartedDecision<T>> {
	if (mode === 'none') return { kind: 'posted', value: await post(undefined) }
	return { kind: 'confirm', check: await issueCheck(challenge, post, what) }
}

async function issueCheck<T>(
	challenge: () => Promise<ApprovalStepUpChallenge>,
	post: (stepUp: ApprovalStepUp | undefined) => Promise<T>,
	what: StepUpSubject,
): Promise<PasskeyCheck<T>> {
	const issued = await challenge()
	if (issued.kind === 'no-passkey') throw new NoPasskeyError(what)
	const { challengeId, expiresAt, url } = issued.challenge
	return { url, expiresAt, what, post: () => post({ challengeId }), renew: () => issueCheck(challenge, post, what) }
}

/** Why a decision was not recorded, in the console's words; `noPasskey` adds the way to add one. */
export interface DecisionFailure {
	readonly message: string
	readonly noPasskey: boolean
}

export function decisionFailure(cause: unknown): DecisionFailure {
	if (cause instanceof NoPasskeyError) return { message: cause.message, noPasskey: true }
	if (cause instanceof RpcError) return { message: cause.message, noPasskey: false }
	return { message: 'The decision was not recorded.', noPasskey: false }
}
