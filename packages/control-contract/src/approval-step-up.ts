// The step-up on deciding a pending item (ADR-0050 §5): the approval page asks Control for a single-use passkey challenge
// bound to the decision, the person answers it on IAM's step-up page, and the page posts the challenge's id with the
// decision. IAM issues the challenge, takes the answer and verifies it for Control.

import type { PasskeyStepUpChallenge } from '@fabrika/iam-contract'
import type { SetEnvironmentProtectionRequest } from './index.js'

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

/** A challenge for one change of an environment's protection that weakens a passkey on deciding: the change as posted. */
export type ProtectionChallengeInput = Omit<SetEnvironmentProtectionRequest, 'stepUp'>

/**
 * IAM's challenge, bound to the decision, which the person answers on IAM's page at its `url`; or `no-passkey` when the
 * person has none to answer it with and adds one on their IAM account page first.
 */
export type ApprovalStepUpChallenge =
	| { kind: 'challenge'; challenge: PasskeyStepUpChallenge }
	| { kind: 'no-passkey' }

/** The challenge, answered on IAM's page, that a decision carries when it takes a step-up. */
export interface ApprovalStepUp {
	challengeId: string
}
