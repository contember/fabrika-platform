// The approval surface (ADR-0050 §4–§5): parked runs behind `access.approve`, completed only by a human user
// principal from the console (`./human`), and the `protected` flag and the approval policy (ADR-0083) changed by
// the same rule.

import type { AuthContext } from '@fabrika/auth'
import { appEnvironmentId } from '@fabrika/auth-core'
import type {
	AccessChangeDto,
	AppEnvDto,
	ApprovalChallengeInput,
	ApprovalDto,
	ApprovalStepUpChallenge,
	CompleteApprovalRequest,
	ListResponse,
	SetEnvironmentProtectionRequest,
	StepUpMode,
} from '@fabrika/control-contract'
import {
	changeCategories,
	CONTROL_ACTIONS,
	gate,
	type PolicyCategory,
	requesterMayApprove,
	requiredApprovers,
	requiredStepUp,
} from '@fabrika/control-contract'
import type { DeployLocks } from '@fabrika/platform'
import { fail } from '../api/domain'
import { toAppEnvDto } from '../api/registry/registration'
import { canAtCoordinates, type DeployQueue, toRunDto } from '../api/runs'
import { appEnvCrossOrigins, type AppEnvRow, type ControlRepositories, type RunRow } from '../db'
import { acquireLease, type LeaseClock, runLeaseKey } from '../lease'
import { snapshotAccessMap } from './access-map'
import { appEnvPolicy, appEnvSettings, grantsWait, storedPolicy, storedSettings } from './categories'
import { type ConsoleAdmission, requireHumanApprover, requireOtherThanRequester } from './human'
import {
	classificationCategories,
	classificationPolicy,
	parseApproval,
	parseClassification,
	type StoredApproval,
	type StoredClassification,
} from './publish'
import { deployRequester, parseDeployRequest, toDeployRequestDto } from './request'
import { type AccessSnapshot, parseSnapshot } from './snapshot'
import { issueStepUpChallenge, type PasskeyStepUpPort, requireStepUp, runStepUpBinding } from './step-up'
import { snapshotSurface } from './surface'

/**
 * IAM's switch for whether an application's console grants wait for a second administrator (ADR-0083 §4), set with the
 * provisioning key on the IAM application id `<app>@<env>`. Control is its only writer; `revision` is the environment's
 * protection revision, and IAM ignores one older than it holds.
 */
export interface GrantApprovalPort {
	set(app: string, required: boolean, revision: number): Promise<void>
}

export interface ApprovalUseCaseContext extends ConsoleAdmission {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	readonly queue: DeployQueue
	readonly lock: DeployLocks
	/** Absent on an installation without IAM's issuer or provisioning key: choosing `grants` there is refused. */
	readonly grantApproval?: GrantApprovalPort
	/** The approver's passkey step-up in IAM; absent, a decision that takes one is refused. */
	readonly stepUp?: PasskeyStepUpPort
	readonly leaseClock?: LeaseClock
	readonly now?: () => number
}

const LIST_LIMIT = 100

export async function listApprovalsUseCase(c: ApprovalUseCaseContext): Promise<ListResponse<ApprovalDto>> {
	const rows = await c.repositories.runs.listRunsAwaitingApproval(LIST_LIMIT)
	return { items: await Promise.all(rows.filter((row) => mayApprove(c.auth, row)).map((row) => toApprovalDto(c.repositories, row, 'list'))) }
}

export async function getApprovalUseCase(c: ApprovalUseCaseContext, runId: string): Promise<ApprovalDto> {
	const pending = await c.repositories.runs.getRun(runId)
	// A request's link is handed out when the run is created; it parks once its commit is classified.
	if (
		pending !== null && pending.classification_json === null && pending.request_json !== null && mayApprove(c.auth, pending)
		&& (pending.status === 'pending' || pending.status === 'running')
	) fail(409, 'the deploy is still being classified; open this page again in a minute')
	const run = await requireClassifiedRun(c, runId)
	const approval = await toApprovalDto(c.repositories, run)
	const crossOrigins = await pendingCrossOrigins(c, approval)
	return {
		...approval,
		...(crossOrigins === undefined ? {} : { crossOrigins }),
		...(run.superseded_by === null ? {} : { supersededBy: run.superseded_by }),
	}
}

/** A parked run as a decision reads it: still waiting, on the digests the page showed, before its deadline. */
interface PendingRunDecision {
	readonly approver: { readonly id: string; readonly label: string }
	readonly run: RunRow
	readonly storedClassification: string
	readonly classification: StoredClassification
	readonly now: number
	readonly deciders: RunDeciders
	readonly partial: StoredApproval | null
}

/** The checks every decision of a parked run passes first, and the passkey challenge for one before it is posted. */
async function pendingRunDecision(c: ApprovalUseCaseContext, input: ApprovalChallengeInput): Promise<PendingRunDecision> {
	const approver = requireHumanApprover(c.auth, c)
	const run = await requireClassifiedRun(c, input.runId)
	if (run.failure_cause === 'expired') fail(410, expiredMessage(run))
	if (run.status !== 'awaiting_approval' || run.classification_json === null) fail(409, 'the run is not waiting for approval')
	const storedClassification = run.classification_json
	const classification = parseClassification(await c.repositories.runs.document(storedClassification))
	if (classification.candidateDigest !== input.candidateDigest || classification.baselineDigest !== input.baselineDigest) {
		fail(409, 'the change was classified again since it was read; reload it and decide again')
	}
	const now = (c.now ?? (() => Math.floor(Date.now() / 1000)))()
	if (run.approval_deadline !== null && run.approval_deadline <= now) fail(410, expiredMessage(run))
	const deciders = await runDeciders(c.repositories, run, classification)
	return { approver, run, storedClassification, classification, now, deciders, partial: heldPartialApproval(run, classification) }
}

/** What a decision of a run is bound to when it takes a step-up: the run, the decision and the digests it was read on. */
function runBinding(pending: PendingRunDecision, decision: CompleteApprovalRequest['decision']): string {
	return runStepUpBinding(pending.run.id, decision, pending.classification.candidateDigest, pending.classification.baselineDigest)
}

/**
 * A single-use passkey challenge bound to one decision of a parked run whose deciding takes a step-up (ADR-0050 §5):
 * the same person, right and checks as the decision, so nobody is asked for a passkey for a decision Control refuses.
 */
export async function challengeApprovalUseCase(c: ApprovalUseCaseContext, input: ApprovalChallengeInput): Promise<ApprovalStepUpChallenge> {
	const pending = await pendingRunDecision(c, input)
	if (pending.deciders.stepUp === 'none') fail(409, 'deciding this run takes no passkey')
	if (input.decision === 'approve' && !pending.deciders.requesterMayApprove && pending.run.request_json !== null) {
		requireOtherThanRequester(pending.approver, deployRequester(parseDeployRequest(pending.run.request_json)), 'deploy')
	}
	return await issueStepUpChallenge(c.stepUp, runBinding(pending, input.decision))
}

/**
 * Approve or refuse one parked run. Only a human user principal, on a console request from its own origin, holding
 * `access.approve` at the run's coordinates; the approval names the two digests the approver read, so a run that was
 * classified again since refuses it. An approved run is queued again and classified once more before it publishes. A
 * decision after the run's deadline changes nothing (ADR-0050 §4). Where two people decide (`approvers: 2`), the first
 * approval is recorded on the digests and the run keeps waiting; the same person approving again changes nothing.
 * Under `stepUp: webauthn` either decision carries a passkey assertion bound to it, which IAM verifies before anything
 * is written (ADR-0050 §5).
 */
export async function completeApprovalUseCase(c: ApprovalUseCaseContext, input: CompleteApprovalRequest): Promise<ApprovalDto> {
	const pending = await pendingRunDecision(c, input)
	const { approver, run, storedClassification, classification, now, partial } = pending
	const { approvers, requesterMayApprove, stepUp: stepUpMode } = pending.deciders
	if (input.decision === 'approve' && approvers === 2 && partial?.principalId === approver.id) {
		return await toApprovalDto(c.repositories, run)
	}
	if (input.decision === 'approve' && !requesterMayApprove && run.request_json !== null) {
		requireOtherThanRequester(approver, deployRequester(parseDeployRequest(run.request_json)), 'deploy')
	}
	const stepUp = await requireStepUp(c.stepUp, stepUpMode, runBinding(pending, input.decision), approver, input.stepUp)
	const lease = await acquireLease(c.lock, runLeaseKey(run.app_id, run.env), c.leaseClock)
	if (lease === null) fail(409, 'the environment is deploying; try again in a moment')
	const completes = input.decision === 'approve' && (approvers === 1 || partial !== null)
	try {
		const fence = lease.fence()
		const approval: StoredApproval = {
			principalId: approver.id,
			label: approver.label,
			approvedAt: now,
			candidateDigest: classification.candidateDigest,
			baselineDigest: classification.baselineDigest,
			...(stepUp === null ? {} : { stepUp }),
		}
		const expected = { classification: storedClassification, partial: run.partial_approval_json }
		const changed = input.decision === 'reject'
			? await c.repositories.runs.rejectParkedRun(run.id, storedClassification, fence)
			: completes
			? await c.repositories.runs.approveParkedRun(run.id, expected, JSON.stringify(approval), fence)
			: await c.repositories.runs.recordPartialApproval(run.id, expected, JSON.stringify(approval), fence)
		if (!changed) {
			const latest = await c.repositories.runs.getRun(run.id)
			if (latest !== null && latest.approval_deadline !== null && latest.approval_deadline <= now) fail(410, expiredMessage(latest))
			fail(409, 'the run is not waiting for approval, or another decision landed first; reload it')
		}
	} finally {
		await lease.release()
	}
	await c.auth.audit({
		action: CONTROL_ACTIONS.ACCESS_APPROVE,
		resourceType: 'run',
		resourceId: run.id,
		metadata: {
			appId: run.app_id,
			env: run.env,
			decision: input.decision,
			...(input.decision === 'approve' && !completes ? { partial: true } : {}),
			candidateDigest: classification.candidateDigest,
			baselineDigest: classification.baselineDigest,
			...(stepUp === null ? {} : { stepUp: { credentialId: stepUp.credentialId, at: stepUp.at } }),
		},
	})
	if (completes) await c.queue.send({ runId: run.id })
	return await toApprovalDto(c.repositories, await requireClassifiedRun(c, run.id))
}

function expiredMessage(run: Pick<RunRow, 'approval_deadline'>): string {
	const at = run.approval_deadline === null ? '' : ` at ${new Date(run.approval_deadline * 1000).toISOString()}`
	return `nobody decided this deploy before its deadline${at}, so it expired and deploys nothing; a new deploy asks again`
}

/**
 * The categories a parked run waits for: those of the lines no evidence lets through, and `deploy-request` when a
 * non-person asked for it. Each takes the environment's `approvers`, and the most among them decide it (ADR-0083 §8).
 */
export function waitingCategoriesOf(run: Pick<RunRow, 'park_reason'>, classification: StoredClassification): PolicyCategory[] {
	const policy = classificationPolicy(classification)
	const outcome = gate({ lines: classification.changes }, policy)
	const lines = outcome.kind === 'wait' ? outcome.lines.flatMap((line) => changeCategories(line).filter((category) => policy[category] !== 'off')) : []
	return run.park_reason === 'requested' ? [...lines, 'deploy-request'] : lines
}

/** Who decides a parked run, and what deciding it takes, under its environment's settings now. */
interface RunDeciders {
	readonly approvers: 1 | 2
	readonly requesterMayApprove: boolean
	readonly stepUp: StepUpMode
}

/**
 * Who decides a parked run: how many people, the most any of its waiting categories asks for, whether the requester's
 * own person may be one of them, which no waiting category may refuse, and whether deciding takes a passkey, which any
 * waiting category may ask for (ADR-0083 §8).
 */
async function runDeciders(
	repositories: Pick<ControlRepositories, 'registry'>,
	run: RunRow,
	classification: StoredClassification,
): Promise<RunDeciders> {
	const appEnv = await repositories.registry.getAppEnv(run.app_id, run.env)
	const settings = appEnvSettings(appEnv ?? { approval_settings: null })
	const categories = waitingCategoriesOf(run, classification)
	return {
		approvers: requiredApprovers(settings, categories),
		requesterMayApprove: requesterMayApprove(settings, categories),
		stepUp: requiredStepUp(settings, categories),
	}
}

/** The first of two approvals, while it names the digests the run shows now; a run that parked again dropped it. */
function heldPartialApproval(run: RunRow, classification: StoredClassification): StoredApproval | null {
	if (run.partial_approval_json === null) return null
	const partial = parseApproval(run.partial_approval_json)
	return partial.candidateDigest === classification.candidateDigest && partial.baselineDigest === classification.baselineDigest ? partial : null
}

/**
 * Set an environment's `protected` flag and, when given, its approval policy: the same human rule as approving, and
 * audited (ADR-0050 §4, ADR-0083 §2). IAM's grant gate follows every change, the stricter side first: IAM holds grants
 * before Control says so and releases them only after, so a failure between the two writes leaves grants waiting rather
 * than not, and the next change repairs it (ADR-0083 §4).
 */
export async function setEnvironmentProtectionUseCase(c: ApprovalUseCaseContext, input: SetEnvironmentProtectionRequest): Promise<AppEnvDto> {
	requireHumanApprover(c.auth, c)
	if (!canAtCoordinates(c.auth, CONTROL_ACTIONS.ACCESS_APPROVE, input.appId, input.env)) fail(404, 'app env not found')
	const before = await c.repositories.registry.getAppEnv(input.appId, input.env)
	if (before === null) fail(404, 'app env not found')
	// ADR-0050: a dev environment runs unreviewed workspace heads, and approval never applies to it.
	if (before.kind === 'dev' && input.protected) fail(409, 'a dev environment is never protected')
	if (before.authoring === 1 && input.protected) fail(409, authoringNeverProtected(input.env))
	const policy = input.policy === undefined ? undefined : storedPolicy(input.policy)
	const settings = input.settings === undefined ? undefined : storedSettings(input.settings)
	const iamApp = appEnvironmentId(input.appId, input.env)
	// A job started under the old setting would still apply what it allowed, so the change waits for the deployment. The
	// lease also serializes the two stores of the `grants` choice, so IAM's is written against what Control holds.
	const lease = await acquireLease(c.lock, runLeaseKey(input.appId, input.env), c.leaseClock)
	if (lease === null) fail(409, 'a deployment is running; retry')
	let row: AppEnvRow | null = null
	try {
		const held = await c.repositories.registry.getAppEnv(input.appId, input.env) ?? fail(404, 'app env not found')
		const grantsAfter = grantsWait({
			protected: input.protected ? 1 : 0,
			approval_categories: policy === undefined ? held.approval_categories : policy.categories,
			approval_policy: policy === undefined ? held.approval_policy : policy.policy,
		})
		const grantApproval = c.grantApproval
			?? (grantsAfter && !grantsWait(held) ? fail(503, 'IAM is not reachable with the provisioning key; console grants cannot wait here') : null)
		// The write below bumps the revision by one. Nothing reverts IAM when it fails: this call may have lost the lease,
		// and releasing then could undo its successor's gate.
		if (grantApproval !== null && grantsAfter) await setGrantApproval(grantApproval, iamApp, true, held.protection_revision + 1)
		row = await c.repositories.registry.setAppEnvProtected(input.appId, input.env, input.protected, policy, settings, lease.fence())
		if (row !== null) {
			await c.auth.audit({
				action: 'access.protect',
				resourceType: 'app_env',
				resourceId: `${input.appId}/${input.env}`,
				metadata: {
					appId: input.appId,
					env: input.env,
					from: held.protected === 1,
					to: input.protected,
					policyFrom: appEnvPolicy(held),
					policyTo: appEnvPolicy(row),
					settingsFrom: appEnvSettings(held),
					settingsTo: appEnvSettings(row),
				},
			})
			if (grantApproval !== null && !grantsAfter) await setGrantApproval(grantApproval, iamApp, false, row.protection_revision)
		}
	} finally {
		await lease.release()
	}
	if (row === null) {
		const now = await c.repositories.registry.getAppEnv(input.appId, input.env)
		if (now === null) fail(404, 'app env not found')
		if (now.authoring === 1 && input.protected) fail(409, authoringNeverProtected(input.env))
		fail(409, 'a deployment is running; retry')
	}
	return toAppEnvDto(row)
}

async function setGrantApproval(port: GrantApprovalPort, app: string, required: boolean, revision: number): Promise<void> {
	try {
		await port.set(app, required, revision)
	} catch {
		fail(
			502,
			required
				? 'IAM did not take the change, so nothing changed; try again'
				: 'approvals are saved, but IAM may still hold console grants for approval; save again to release them',
		)
	}
}

/** ADR-0049 rule 7: an agent deploys unreviewed workspace heads to the authoring target, and a protected one takes a person. */
function authoringNeverProtected(env: string): string {
	return `environment \`${env}\` is the app's authoring target, where an agent deploys unreviewed workspace heads, so it cannot be `
		+ 'protected; clear its authoring flag with apps.environments.put first'
}

function mayApprove(auth: AuthContext, run: RunRow): boolean {
	return canAtCoordinates(auth, CONTROL_ACTIONS.ACCESS_APPROVE, run.app_id, run.env)
}

async function requireClassifiedRun(c: ApprovalUseCaseContext, runId: string): Promise<RunRow> {
	const run = await c.repositories.runs.getRun(runId)
	if (run === null || run.classification_json === null || !mayApprove(c.auth, run)) fail(404, 'approval not found')
	return run
}

/**
 * The run's environment's cross-origin list as it stands now, while the run waits for a decision and one of its lines
 * opens an endpoint to that list: context for the approver, not part of the change. A decided run gets none, since the
 * list may have changed since and no approval covers it; nor does a run whose environment is gone, since its list is
 * unknown rather than empty.
 */
async function pendingCrossOrigins(c: ApprovalUseCaseContext, approval: ApprovalDto): Promise<string[] | undefined> {
	if (approval.run.status !== 'awaiting_approval' || !approval.changes.some((change) => change.environmentOrigins === true)) return undefined
	const appEnv = await c.repositories.registry.getAppEnv(approval.run.appId, approval.run.env)
	return appEnv === null ? undefined : appEnvCrossOrigins(appEnv)
}

/** The candidate's surface of the endpoints the lines name, so the page shows what stands in front of each. */
function namedEndpoints(snapshot: AccessSnapshot | null, changes: readonly AccessChangeDto[]): ApprovalDto['endpoints'] {
	if (snapshot === null) return []
	const named = new Set(changes.flatMap((change) => (change.subject?.kind === 'endpoint' ? [change.subject.name] : [])))
	return named.size === 0 ? [] : snapshotSurface(snapshot, named)
}

/**
 * The approval as the console reads it. The list reads no snapshot: it shows no endpoint, and one stored snapshot that
 * no longer parses must not take the whole list down with it.
 */
async function toApprovalDto(
	repositories: Pick<ControlRepositories, 'registry' | 'runs'>,
	run: RunRow,
	view: 'list' | 'detail' = 'detail',
): Promise<ApprovalDto> {
	const runs = repositories.runs
	if (run.classification_json === null) throw new Error(`run ${run.id} has no classification`)
	const classification = parseClassification(await runs.document(run.classification_json))
	const approval = run.approval_json === null ? null : parseApproval(run.approval_json)
	const snapshot = view === 'list' || run.snapshot_json === null ? null : parseSnapshot(await runs.document(run.snapshot_json))
	const waiting = run.status === 'awaiting_approval'
	const partial = waiting ? heldPartialApproval(run, classification) : null
	const request = await toDeployRequestDto(repositories, run)
	return {
		run: toRunDto(run),
		outcome: classification.outcome,
		changes: [...classification.changes],
		endpoints: namedEndpoints(snapshot, classification.changes),
		...(snapshot === null ? {} : { accessMap: snapshotAccessMap(snapshot) }),
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
		baselineRunId: classification.baselineRunId,
		protected: classification.protected,
		categories: [...classificationCategories(classification)],
		...await runDeciders(repositories, run, classification),
		...(partial === null ? {} : { partialApproval: { principalId: partial.principalId, label: partial.label, approvedAt: partial.approvedAt } }),
		...(waiting && run.approval_deadline !== null ? { deadline: run.approval_deadline } : {}),
		...(request === undefined ? {} : { request }),
		approval: approval === null ? null : {
			principalId: approval.principalId,
			label: approval.label,
			approvedAt: approval.approvedAt,
			// An approval moves the run out of waiting in the same write, and a run parks again only when the approval does not
			// match its new classification, so a waiting run's approval has lapsed. A refusal or a cancellation drops it, and a
			// run that published after it ran with what it was approved for, or with no widening left.
			holds: run.status !== 'awaiting_approval',
		},
	}
}
