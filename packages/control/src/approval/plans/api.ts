// Approval plans (ADR-0050 §5): the access change of a commit not yet deployed, read against what its environment
// publishes now, waiting for a person in the console. An approval activates one entry per subject the change's `plan`
// lines touch; a later deploy whose `plan` lines they cover publishes without a second click (`publish.ts`). Who decides,
// how many decide and what deciding takes follow the same settings as a parked run and an approval request.

import type { AuthContext } from '@fabrika/auth'
import {
	type AccessChangeDto,
	type ApprovalMode,
	type ApprovalPlanChallengeInput,
	type ApprovalPlanDto,
	type ApprovalPlanEntryState,
	type ApprovalPlanListResponse,
	type ApprovalPlanState,
	type ApprovalPolicy,
	type ApprovalSettings,
	type ApprovalStepUpChallenge,
	changeCategories,
	CONTROL_ACTIONS,
	type CreateApprovalPlanInput,
	type DecideApprovalPlanInput,
	type LineCategory,
	type PolicyCategory,
	requesterMayApprove,
	requesterPersonId,
	requiredApprovers,
	requiredStepUp,
	type StepUpMode,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { uuidv7 } from '@fabrika/platform'
import { fail } from '../../api/domain'
import { canAtCoordinates } from '../../api/runs'
import type { AppEnvRow, ApprovalPlanDecider, ApprovalPlanEntryRow, ApprovalPlanRow, ControlRepositories } from '../../db'
import { appEnvPolicy, appEnvSettings } from '../categories'
import { classifyAccess } from '../diff'
import { type ConsoleAdmission, isConsolePerson, requireHumanApprover, requireOtherThanRequester } from '../human'
import { parseChanges } from '../publish'
import { approvedSnapshot, snapshotDigest } from '../snapshot'
import { issueStepUpChallenge, type PasskeyStepUpPort, planStepUpBinding, requireStepUp } from '../step-up'
import { fragmentSource, plannedEntries } from './coverage'
import type { PlanCommitReader } from './read'

export interface ApprovalPlanContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** The request the call arrived on: a person in the console is told apart from a bearer by it. */
	readonly admission: ConsoleAdmission
	/** Reads the commit a plan is made for; absent where Control has no commit source, and then no plan can be made. */
	readonly readCommit?: PlanCommitReader
	/** The approver's passkey step-up in IAM; absent, a decision that takes one is refused. */
	readonly stepUp?: PasskeyStepUpPort
	/** The console's public origin, for the plan's link. */
	readonly consoleOrigin?: string
	/** Unix seconds; the repositories' own clock in a test. */
	readonly now?: () => number
}

const LIST_LIMIT = 100

/** A plan's lines are stored on its row, which a D1 row bounds; a larger change is approved on its parked run. */
const MAX_CHANGES_BYTES = 900_000

/** The link a person decides a plan at. */
export function approvalPlanUrl(consoleOrigin: string, id: string): string {
	return `${consoleOrigin}/approvals/plans/${encodeURIComponent(id)}`
}

function nowOf(c: ApprovalPlanContext): number {
	return (c.now ?? (() => Math.floor(Date.now() / 1000)))()
}

/** The strictest mode among a line's categories under `policy`. */
export function lineMode(change: AccessChangeDto, policy: ApprovalPolicy): Exclude<ApprovalMode, 'refuse'> {
	const rank: Record<Exclude<ApprovalMode, 'refuse'>, number> = { off: 0, plan: 1, person: 2 }
	let mode: Exclude<ApprovalMode, 'refuse'> = 'off'
	for (const category of changeCategories(change)) {
		if (category === 'grants') continue
		const held = policy[category]
		if (rank[held] > rank[mode]) mode = held
	}
	return mode
}

/** The categories of a plan's lines that wait for a plan under `policy`: they decide who approves it and how. */
function planCategories(changes: readonly AccessChangeDto[], policy: ApprovalPolicy): LineCategory[] {
	const categories = new Set<LineCategory>()
	for (const change of changes) {
		if (lineMode(change, policy) !== 'plan') continue
		for (const category of changeCategories(change)) {
			if (category !== 'grants' && policy[category] === 'plan') categories.add(category)
		}
	}
	return [...categories]
}

/**
 * Plan the access change of a commit on a protected environment: read the commit, classify it against what the
 * environment publishes now, and store it with one pending entry per subject of its `plan` lines. Refused: a caller
 * without `deploy.trigger` at the coordinates (404, as an absent environment answers), an unprotected environment, and a
 * change with no line a plan lets through there (409), and a commit Control cannot read or a deploy would refuse.
 */
export async function createApprovalPlanUseCase(c: ApprovalPlanContext, input: CreateApprovalPlanInput): Promise<ApprovalPlanDto> {
	const principal = c.auth.principal
	if (principal === null) fail(403, 'an anonymous caller cannot plan a change')
	if (!canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_TRIGGER, input.appId, input.env)) fail(404, 'app env not found')
	const app = await c.repositories.registry.getApp(input.appId)
	const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
	if (app === null || appEnv === null) fail(404, 'app env not found')
	if (appEnv.protected !== 1) {
		fail(409, `environment \`${input.env}\` is not protected: nothing waits for approval there, so there is nothing to plan`)
	}
	if (c.readCommit === undefined) fail(503, 'Control has no commit source to read the commit from, so no plan can be made')
	const candidate = await c.readCommit(app, appEnv, input.commitSha)
	const baseline = approvedSnapshot(appEnv)
	const classification = classifyAccess(baseline.snapshot, candidate)
	const changes: AccessChangeDto[] = [...classification.changes]
	const policy = appEnvPolicy(appEnv)
	const planned = changes.filter((change) => lineMode(change, policy) === 'plan')
	if (planned.length === 0) {
		const person = changes.filter((change) => lineMode(change, policy) === 'person').length
		fail(
			409,
			`no line of this change waits for a plan on \`${input.env}\`: ${person} of its ${changes.length} lines wait for a person at the deploy, `
				+ 'and the rest wait for nothing',
		)
	}
	const changesJson = JSON.stringify(changes)
	if (changesJson.length > MAX_CHANGES_BYTES) fail(409, 'the change is too large to plan; deploy it and approve the parked run')
	const entries = plannedEntries(fragmentSource(baseline.snapshot), fragmentSource(candidate), planned)
	const row = await c.repositories.approvalPlans.create({
		id: uuidv7(),
		appId: input.appId,
		env: input.env,
		commitSha: input.commitSha,
		requester: {
			id: principal.id,
			type: principal.type,
			label: principal.label,
			credential: isConsolePerson(c.auth, c.admission) ? 'console' : c.auth.oauth === undefined ? 'key' : 'oauth',
			clientId: c.auth.oauth?.clientId ?? null,
			grantId: c.auth.oauth?.grantId ?? null,
		},
		outcome: classification.outcome,
		changesJson,
		candidateDigest: snapshotDigest(candidate),
		baselineDigest: snapshotDigest(baseline.snapshot),
		baselineRunId: baseline.runId,
		ttlSeconds: appEnvSettings(appEnv).requestTtlHours * 3600,
		entries: entries.map((entry) => ({ id: uuidv7(), ...entry })),
	})
	return toApprovalPlanDto(c, row)
}

/** One plan: the requester's own, or any at coordinates where the caller holds `access.approve`. */
export async function getApprovalPlanUseCase(c: ApprovalPlanContext, id: string): Promise<ApprovalPlanDto> {
	const row = await c.repositories.approvalPlans.get(id)
	if (row === null || (!isRequester(c.auth, row) && !mayDecide(c.auth, row))) fail(404, 'approval plan not found')
	return toApprovalPlanDto(c, row)
}

/** The plans waiting for a decision at coordinates where the caller holds `access.approve`, newest first. */
export async function listApprovalPlansUseCase(c: ApprovalPlanContext): Promise<ApprovalPlanListResponse> {
	const rows = await c.repositories.approvalPlans.listPending(LIST_LIMIT)
	return { items: await Promise.all(rows.filter((row) => mayDecide(c.auth, row)).map((row) => toApprovalPlanDto(c, row))) }
}

/** Who decides a plan, and what deciding it takes, under its environment's settings now. */
interface PlanDeciders {
	readonly approvers: 1 | 2
	readonly requesterMayApprove: boolean
	readonly stepUp: StepUpMode
}

interface PendingPlanDecision {
	readonly approver: { readonly id: string; readonly label: string }
	readonly row: ApprovalPlanRow
	readonly deciders: PlanDeciders
	readonly settings: ApprovalSettings
}

/**
 * The checks every decision of a plan passes first: a person in the console with `access.approve` at its coordinates,
 * on the digests the page showed, while it waits, before its deadline.
 */
async function pendingPlanDecision(c: ApprovalPlanContext, input: ApprovalPlanChallengeInput): Promise<PendingPlanDecision> {
	const approver = requireHumanApprover(c.auth, c.admission)
	const row = await c.repositories.approvalPlans.get(input.id)
	if (row === null || !mayDecide(c.auth, row)) fail(404, 'approval plan not found')
	const now = nowOf(c)
	if (row.state === 'pending' && row.deadline <= now) fail(410, expiredMessage(row))
	if (row.state !== 'pending') fail(409, `the plan is ${row.state}, no longer waiting for a decision; reload it`)
	if (row.candidate_digest !== input.candidateDigest || row.baseline_digest !== input.baselineDigest) {
		fail(409, 'the plan is not the one the page showed; reload it and decide again')
	}
	const { deciders, settings } = await planDeciders(c.repositories, row)
	return { approver, row, deciders, settings }
}

function bindingOf(row: ApprovalPlanRow, decision: DecideApprovalPlanInput['decision']): string {
	return planStepUpBinding(row.id, decision, row.candidate_digest, row.baseline_digest)
}

/** A single-use passkey challenge bound to one decision of a plan whose deciding takes a step-up. */
export async function challengeApprovalPlanUseCase(c: ApprovalPlanContext, input: ApprovalPlanChallengeInput): Promise<ApprovalStepUpChallenge> {
	const pending = await pendingPlanDecision(c, input)
	if (pending.deciders.stepUp === 'none') fail(409, 'deciding this plan takes no passkey')
	if (input.decision === 'approve' && !pending.deciders.requesterMayApprove) {
		requireOtherThanRequester(pending.approver, requesterOf(pending.row), 'plan')
	}
	return await issueStepUpChallenge(c.stepUp, bindingOf(pending.row, input.decision))
}

/**
 * Approve or refuse a pending plan: a person in the console with `access.approve` at its coordinates, posting the digests
 * the page showed, before its deadline. Under `approvers: 2` the first approval is partial and a different person
 * completes it; either may refuse. Under `requesterMayApprove: false` the requester's person may only refuse. Under
 * `stepUp: webauthn` either decision carries a passkey assertion bound to it. A completing approval activates the plan's
 * entries until `planTtlDays` from now.
 */
export async function decideApprovalPlanUseCase(c: ApprovalPlanContext, input: DecideApprovalPlanInput): Promise<ApprovalPlanDto> {
	const { approver, row, deciders, settings } = await pendingPlanDecision(c, input)
	if (input.decision === 'approve' && deciders.approvers === 2 && row.partial_approver_id === approver.id) return toApprovalPlanDto(c, row)
	if (input.decision === 'approve' && !deciders.requesterMayApprove) requireOtherThanRequester(approver, requesterOf(row), 'plan')
	const stepUp = await requireStepUp(c.stepUp, deciders.stepUp, bindingOf(row, input.decision), approver, input.stepUp, 'decision')
	const decider: ApprovalPlanDecider = { id: approver.id, label: approver.label, stepUp }
	const plans = c.repositories.approvalPlans
	const partial = input.decision === 'approve' && deciders.approvers === 2 && row.partial_approver_id === null
	const changed = input.decision === 'reject'
		? await plans.reject(row.id, decider)
		: partial
		? await plans.recordPartialApproval(row.id, decider)
		: await plans.approve(row.id, decider, row.partial_approver_id, nowOf(c) + settings.planTtlDays * 86_400)
	if (!changed) {
		const latest = await plans.get(row.id)
		if (latest !== null && latest.state === 'pending' && latest.deadline <= nowOf(c)) fail(410, expiredMessage(latest))
		fail(409, 'another decision landed first, or the plan is no longer waiting; reload it')
	}
	await c.auth.audit({
		action: CONTROL_ACTIONS.ACCESS_APPROVE,
		resourceType: 'approval_plan',
		resourceId: row.id,
		metadata: {
			appId: row.app_id,
			env: row.env,
			commitSha: row.commit_sha,
			decision: input.decision,
			...(partial ? { partial: true } : {}),
			candidateDigest: row.candidate_digest,
			baselineDigest: row.baseline_digest,
			...(stepUp === null ? {} : { stepUp: { credentialId: stepUp.credentialId, at: stepUp.at } }),
		},
	})
	return toApprovalPlanDto(c, await requireRow(c, row.id))
}

/**
 * End an approved plan early: its active entries cover nothing from now on, and a consumed one keeps the run it covered.
 * A person in the console with `access.approve` at its coordinates; a publication that read an entry before the
 * revocation loses its compare-and-swap and classifies again.
 */
export async function revokeApprovalPlanUseCase(c: ApprovalPlanContext, id: string): Promise<ApprovalPlanDto> {
	const person = requireHumanApprover(c.auth, c.admission)
	const row = await c.repositories.approvalPlans.get(id)
	if (row === null || !mayDecide(c.auth, row)) fail(404, 'approval plan not found')
	if (row.state !== 'approved') fail(409, `the plan is ${stateOf(row, nowOf(c))}; only an approved plan is revoked`)
	if (!(await c.repositories.approvalPlans.revoke(row.id, person))) fail(409, 'the plan changed since it was read; reload it')
	await c.auth.audit({
		action: CONTROL_ACTIONS.ACCESS_APPROVE,
		resourceType: 'approval_plan',
		resourceId: row.id,
		metadata: { appId: row.app_id, env: row.env, commitSha: row.commit_sha, decision: 'revoke' },
	})
	return toApprovalPlanDto(c, await requireRow(c, row.id))
}

function expiredMessage(row: Pick<ApprovalPlanRow, 'deadline'>): string {
	return `nobody decided this plan before its deadline, ${new Date(row.deadline * 1000).toISOString()}, so it expired and covers nothing; `
		+ 'plan the commit again'
}

async function requireRow(c: ApprovalPlanContext, id: string): Promise<ApprovalPlanRow> {
	return (await c.repositories.approvalPlans.get(id)) ?? fail(404, 'approval plan not found')
}

function mayDecide(auth: AuthContext, row: Pick<ApprovalPlanRow, 'app_id' | 'env'>): boolean {
	return canAtCoordinates(auth, CONTROL_ACTIONS.ACCESS_APPROVE, row.app_id, row.env)
}

/** The same principal through the same OAuth client, or through none: another agent of the same person sees only its own. */
function isRequester(auth: AuthContext, row: ApprovalPlanRow): boolean {
	return auth.principal !== null && row.requester_id === auth.principal.id && row.requester_client_id === (auth.oauth?.clientId ?? null)
}

function requesterOf(row: ApprovalPlanRow): { readonly personId: string | null; readonly label: string } {
	return { personId: requesterPersonId({ id: row.requester_id, type: row.requester_type }), label: row.requester_label }
}

/** The plan's lines, read through the schema a run's stored classification is read through. */
function changesOf(row: ApprovalPlanRow): AccessChangeDto[] {
	return parseChanges(row.changes_json)
}

/** The policy and settings a plan is read under: its environment's now, the defaults when the environment is gone. */
async function planRules(repositories: Pick<ControlRepositories, 'registry'>, row: ApprovalPlanRow): Promise<{
	readonly appEnv: AppEnvRow | null
	readonly policy: ApprovalPolicy
	readonly settings: ApprovalSettings
}> {
	const appEnv = await repositories.registry.getAppEnv(row.app_id, row.env)
	return appEnv === null
		? { appEnv, policy: STRICT_POLICY, settings: STRICT_SETTINGS }
		: { appEnv, policy: appEnvPolicy(appEnv), settings: appEnvSettings(appEnv) }
}

async function planDeciders(
	repositories: Pick<ControlRepositories, 'registry'>,
	row: ApprovalPlanRow,
): Promise<{ readonly deciders: PlanDeciders; readonly settings: ApprovalSettings }> {
	const { policy, settings } = await planRules(repositories, row)
	const categories: PolicyCategory[] = planCategories(changesOf(row), policy)
	return {
		settings,
		deciders: {
			approvers: requiredApprovers(settings, categories),
			requesterMayApprove: requesterMayApprove(settings, categories),
			stepUp: requiredStepUp(settings, categories),
		},
	}
}

function stateOf(row: ApprovalPlanRow, now: number): ApprovalPlanState {
	return row.state === 'pending' && row.deadline <= now ? 'expired' : row.state
}

function entryStateOf(entry: ApprovalPlanEntryRow, now: number): ApprovalPlanEntryState {
	return entry.state === 'active' && entry.expires_at !== null && entry.expires_at <= now ? 'expired' : entry.state
}

export async function toApprovalPlanDto(c: ApprovalPlanContext, row: ApprovalPlanRow): Promise<ApprovalPlanDto> {
	const now = nowOf(c)
	const changes = changesOf(row)
	const { policy } = await planRules(c.repositories, row)
	const { deciders } = await planDeciders(c.repositories, row)
	const entries = await c.repositories.approvalPlans.entries(row.id)
	const state = stateOf(row, now)
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		commitSha: row.commit_sha,
		state,
		...(c.consoleOrigin === undefined ? {} : { url: approvalPlanUrl(c.consoleOrigin, row.id) }),
		requester: {
			principal: { id: row.requester_id, type: row.requester_type, label: row.requester_label },
			credential: row.requester_credential,
			...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
			...(row.requester_grant_id === null ? {} : { grantId: row.requester_grant_id }),
			personId: requesterOf(row).personId,
		},
		outcome: row.outcome,
		lines: changes.map((change) => ({ change, mode: lineMode(change, policy) })),
		candidateDigest: row.candidate_digest,
		baselineDigest: row.baseline_digest,
		baselineRunId: row.baseline_run_id,
		...deciders,
		...(state === 'pending' && row.partial_approver_id !== null && row.partial_approver_label !== null && row.partial_approved_at !== null
			? { partialApproval: { principalId: row.partial_approver_id, label: row.partial_approver_label, at: row.partial_approved_at } }
			: {}),
		...(row.state === 'revoked' && row.revoked_by_id !== null && row.revoked_by_label !== null && row.revoked_at !== null
			? { decision: { principalId: row.revoked_by_id, label: row.revoked_by_label, at: row.revoked_at } }
			: row.decided_by_id !== null && row.decided_by_label !== null && row.decided_at !== null
			? { decision: { principalId: row.decided_by_id, label: row.decided_by_label, at: row.decided_at } }
			: {}),
		deadline: row.deadline,
		...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
		entries: entries.map((entry) => ({
			subject: entry.subject,
			state: entryStateOf(entry, now),
			...(entry.consumed_by_run === null ? {} : { consumedByRunId: entry.consumed_by_run }),
		})),
		createdAt: row.created_at,
	}
}
