// The step-up on deciding a pending item (ADR-0050 §5): the approval page asks Control for a single-use passkey challenge
// bound to the decision, answers it in the browser, and posts the assertion with the decision. IAM issues and verifies.

import type { PasskeyAssertion, PasskeyChallenge, PasskeyRequestOptions } from '@fabrika/iam-contract'

/** The decision a step-up is bound to. */
export type ApprovalDecision = 'approve' | 'reject'

/** A challenge for one decision of a parked run, on the digests the page shows. */
export interface ApprovalChallengeInput {
	runId: string
	decision: ApprovalDecision
	candidateDigest: string
	baselineDigest: string
}

/** A challenge for one decision of an approval request, on the input digest the page shows. */
export interface ApprovalRequestChallengeInput {
	id: string
	decision: ApprovalDecision
	inputDigest: string
}

/**
 * IAM's challenge, bound to the decision, for `navigator.credentials.get`; or `no-passkey` when the person has none to
 * answer it with and registers one under Account → Passkeys first.
 */
export type ApprovalStepUpChallenge =
	| { kind: 'challenge'; challenge: PasskeyChallenge<PasskeyRequestOptions> }
	| { kind: 'no-passkey' }

/** The answered challenge a decision carries when it takes a step-up. */
export type ApprovalStepUp = PasskeyAssertion
