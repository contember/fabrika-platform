// An approval plan (ADR-0050 §5, the `plan` mode of ADR-0083 §2): the access change of a commit that is not deployed,
// compared with what an environment publishes now, approved ahead of the deploy in the console. Each approved plan holds
// one entry per subject the change touches; a later deploy whose `plan` lines those entries cover publishes without a
// second click. These are its wire shapes; `<console>/approvals/plans/<id>` is where a person decides it.

import type { ApprovalMode, StepUpMode } from './approval-policy.js'
import type { ApprovalRequesterDto } from './approval-requests.js'
import type { ApprovalDecision, ApprovalStepUp } from './approval-step-up.js'
import type { AccessChangeDto, ListResponse } from './index.js'

/**
 * `pending` waits for a decision until its deadline, then reads `expired`. `approved` covers deploys until its entries
 * expire, are consumed or are revoked; `revoked` ends it early. `rejected` approved nothing.
 */
export const APPROVAL_PLAN_STATES = ['pending', 'approved', 'rejected', 'expired', 'revoked'] as const

export type ApprovalPlanState = (typeof APPROVAL_PLAN_STATES)[number]

/**
 * One entry of a plan: a subject of the access snapshot (a role, an endpoint, a migration file) and the lines the
 * approver saw for it. `pending` until the plan is approved; `active` covers a deploy; `consumed` names the run that
 * published under it; `revoked` and `expired` cover nothing.
 */
export const APPROVAL_PLAN_ENTRY_STATES = ['pending', 'active', 'consumed', 'revoked', 'expired'] as const

export type ApprovalPlanEntryState = (typeof APPROVAL_PLAN_ENTRY_STATES)[number]

export interface ApprovalPlanEntryDto {
	/** The subject as a change line names it, `<kind>:<name>` (`role:sales`, `migration:0042_add_index.sql`). */
	subject: string
	state: ApprovalPlanEntryState
	/** The run that published under it, once it is consumed. */
	consumedByRunId?: string
}

/** One line of the plan's access change, with what it waits for on the environment under its policy now. */
export interface ApprovalPlanLineDto {
	change: AccessChangeDto
	/**
	 * The strictest mode among the line's categories: `plan` is what this plan lets through, `person` still waits for a
	 * person at the deploy, `off` waits for nothing.
	 */
	mode: Exclude<ApprovalMode, 'refuse'>
}

/** Who asked for the plan: as an approval request's requester, or `console` for a person who made it there. */
export type ApprovalPlanRequesterDto = Omit<ApprovalRequesterDto, 'credential'> & { credential: 'oauth' | 'key' | 'console' }

export interface ApprovalPlanDto {
	id: string
	appId: string
	env: string
	/** The commit whose access change it plans. */
	commitSha: string
	state: ApprovalPlanState
	/** Where a person decides it; absent where Control knows no console origin. */
	url?: string
	requester: ApprovalPlanRequesterDto
	/** `widening` when a line widens, as a deploy's classification says it. */
	outcome: 'none' | 'no-widening' | 'widening'
	lines: ApprovalPlanLineDto[]
	/** The digests of the commit's snapshot and of the one the environment published when the plan was made. */
	candidateDigest: string
	baselineDigest: string
	/** The published run the change was compared with; null when nothing was published. */
	baselineRunId: string | null
	/** How many people decide it, whether the requester's person may, and what deciding takes, under the settings now. */
	approvers: 1 | 2
	requesterMayApprove: boolean
	stepUp: StepUpMode
	/** The first of two approvals, while the second is awaited. */
	partialApproval?: { principalId: string; label: string; at: number }
	/** Who approved, refused or revoked it. */
	decision?: { principalId: string; label: string; at: number }
	/** When it expires unless decided (unix seconds). */
	deadline: number
	/** Until when an approved plan's entries cover a deploy (unix seconds). */
	expiresAt?: number
	entries: ApprovalPlanEntryDto[]
	createdAt: number
}

/** A plan of the commit's access change on one environment. */
export interface CreateApprovalPlanInput {
	appId: string
	env: string
	/** A full 40-hex commit id; the plan reads the commit itself, never a branch that may move. */
	commitSha: string
}

export interface ApprovalPlanIdInput {
	id: string
}

/** One decision of a pending plan, on the digests the page showed. */
export interface DecideApprovalPlanInput {
	id: string
	decision: ApprovalDecision
	candidateDigest: string
	baselineDigest: string
	/** The challenge answered on IAM's page, when deciding takes a step-up. */
	stepUp?: ApprovalStepUp
}

/** A passkey challenge for one decision of a pending plan. */
export type ApprovalPlanChallengeInput = Omit<DecideApprovalPlanInput, 'stepUp'>

export type ApprovalPlanListResponse = ListResponse<ApprovalPlanDto>
