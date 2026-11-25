// An approval request (ADR-0083 §8): a non-person's action that waits for a person, stored in Control inert and exact,
// and decided from one console link, `<console>/approvals/requests/<id>`. These are its wire shapes.

import type { JsonValue } from '@fabrika/provider-contract'
import type { StepUpMode } from './approval-policy.js'
import type { ApprovalStepUp } from './approval-step-up.js'
import type { AccessMapRoleDto, ListResponse } from './index.js'

/**
 * `pending` waits for a decision; `approved`, `rejected` and `expired` follow it. An approved request moves to `executing`
 * under an operation id recorded before any external effect, then to `executed`, `failed` or `unknown` (the outcome was
 * not observed; Control follows it). `stale`: what the request acts on, or the policy, changed since it was asked for.
 */
export const APPROVAL_REQUEST_STATES = ['pending', 'approved', 'rejected', 'expired', 'executing', 'executed', 'failed', 'unknown', 'stale'] as const

export type ApprovalRequestState = (typeof APPROVAL_REQUEST_STATES)[number]

/** The states a request never leaves: an agent waiting on it stops here. */
export const FINAL_APPROVAL_REQUEST_STATES: readonly ApprovalRequestState[] = ['rejected', 'expired', 'executed', 'failed', 'stale']

export function isFinalApprovalRequestState(state: ApprovalRequestState): boolean {
	return FINAL_APPROVAL_REQUEST_STATES.includes(state)
}

/** One piece of text the page shows: Fabrika's own words, or text the agent wrote, which the page escapes and marks. */
export interface ApprovalRequestText {
	text: string
	/** Written by the agent (a name, a message), never by Fabrika. */
	agent: boolean
	/** A time, in unix seconds, that `text` states in ISO 8601: the page shows it as it shows its other dates. */
	at?: number
}

/** What the request asks for, as its kind describes it: plain data, never markup. */
export interface ApprovalRequestDescription {
	/** One sentence, in parts, saying what happens on approval. */
	summary: ApprovalRequestText[]
	/** The facts beside it, each a label and its value. */
	facts: { label: string; value: ApprovalRequestText }[]
	/** The role a grant gives, as the environment's approved contract declares it and the approval pages show it. */
	role?: AccessMapRoleDto
}

/** Who asked: the principal, through which credential, and the person behind it when known. */
export interface ApprovalRequesterDto {
	/** The person the credential acts for, or the service principal that holds it. */
	principal: { id: string; type: string; label: string }
	/** `oauth`: an OAuth client acting for the person; `key`: an API key or another bearer. */
	credential: 'oauth' | 'key'
	/** The OAuth client's id (its metadata URL); the client wrote it, so it is the agent's text. */
	clientId?: string
	/** The OAuth grant the token was minted from. */
	grantId?: string
	/** Who issued the service key, when the credential named them. */
	issuerId?: string
	/** The person behind the request (`requesterPersonId`); null when it cannot be known, a service key's. */
	personId: string | null
}

/** A person's decision, or the first of two approvals. */
export interface ApprovalRequestDecisionDto {
	principalId: string
	label: string
	at: number
}

export interface ApprovalRequestDto {
	id: string
	kind: string
	/** The action category that judges it (`ActionCategory`); a category a later release added reads as its name. */
	category: string
	appId: string
	env: string
	state: ApprovalRequestState
	/** Where a person decides it; absent where Control knows no console origin. */
	url?: string
	requester: ApprovalRequesterDto
	description: ApprovalRequestDescription
	/**
	 * Whether this Control can say what the request does, from its kind and its stored input. When it cannot (a kind or a
	 * key it does not know), `description` names the kind and shows the raw input, and the request can only be refused.
	 */
	described: boolean
	/** `sha256:<hex>` of the canonical input: the decision posts it back, so it decides only what the page showed. */
	inputDigest: string
	/** How many people decide it, under the environment's settings now. */
	approvers: 1 | 2
	/** Whether the requester's person may approve it, under the environment's settings now. */
	requesterMayApprove: boolean
	/** What deciding it takes beyond the session, under the environment's settings now (ADR-0050 §5). */
	stepUp: StepUpMode
	/** The first of two approvals, while the second is awaited. */
	partialApproval?: ApprovalRequestDecisionDto
	/** Who approved or refused it, once a person did. */
	decision?: ApprovalRequestDecisionDto
	/** When it expires unless decided (unix seconds). */
	deadline: number
	createdAt: number
	updatedAt: number
	/** Recorded before the execution's first external effect. */
	operationId?: string
	/** What the execution answered, once it ran. */
	result?: JsonValue
	/** Why it failed, went stale or is unknown, in Fabrika's words. */
	error?: string
}

/** The requests waiting for the caller to decide. */
export interface ApprovalRequestListResponse extends ListResponse<ApprovalRequestDto> {
	/** Control could not ask IAM what the caller administers, so a request an IAM administrator decides may be left out. */
	iamUnreachable?: true
}

/** Ask a person to approve one action. `input` is the action's own, checked by its kind. */
export interface CreateApprovalRequestInput {
	kind: string
	input: JsonValue
}

/** A created request: its id, the console link to hand the person, and its state. */
export interface CreateApprovalRequestResponse {
	id: string
	url: string
	state: ApprovalRequestState
	/**
	 * For a request that carries a secret value: the first 8 hex characters of the value's SHA-256, which the page shows.
	 * The agent prints it beside the link, so the person can tell the value they approve is the one the agent sent.
	 */
	fingerprint?: string
}

/**
 * The coordinates of a request for the all-environments layer (`env: null` of a secret or a variable) and of an
 * application-wide write (`apps.update`): it reaches every environment of the application.
 */
export const ALL_ENVIRONMENTS = '*'

export interface ApprovalRequestIdInput {
	id: string
}

/** Approve or refuse one request; `inputDigest` is the one the page showed. */
export interface DecideApprovalRequestInput {
	id: string
	decision: 'approve' | 'reject'
	inputDigest: string
	/** The assertion bound to this decision, when deciding it takes a step-up (`ApprovalRequestDto.stepUp`). */
	stepUp?: ApprovalStepUp
}
