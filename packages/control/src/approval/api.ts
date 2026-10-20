// The approval surface (ADR-0050 §4–§5): parked runs behind `access.approve`, completed only by a human user
// principal from the console (`./human`), and the `protected` flag changed by the same rule.

import type { AuthContext } from '@fabrika/auth'
import type {
	AccessChangeDto,
	AppEnvDto,
	ApprovalDto,
	CompleteApprovalRequest,
	ListResponse,
	SetEnvironmentProtectionRequest,
} from '@fabrika/control-contract'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import type { DeployLocks } from '@fabrika/platform'
import { fail } from '../api/domain'
import { toAppEnvDto } from '../api/registry/registration'
import { canAtCoordinates, type DeployQueue, toRunDto } from '../api/runs'
import { appEnvCrossOrigins, type AppEnvRow, type ControlRepositories, type RunRow } from '../db'
import { acquireLease, type LeaseClock, runLeaseKey } from '../lease'
import { type ConsoleAdmission, requireHumanApprover } from './human'
import { parseApproval, parseClassification, type StoredApproval } from './publish'
import { parseSnapshot } from './snapshot'
import { snapshotSurface } from './surface'

export interface ApprovalUseCaseContext extends ConsoleAdmission {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	readonly queue: DeployQueue
	readonly lock: DeployLocks
	readonly leaseClock?: LeaseClock
	readonly now?: () => number
}

const LIST_LIMIT = 100

export async function listApprovalsUseCase(c: ApprovalUseCaseContext): Promise<ListResponse<ApprovalDto>> {
	const rows = await c.repositories.runs.listRunsAwaitingApproval(LIST_LIMIT)
	return { items: rows.filter((row) => mayApprove(c.auth, row)).map(toApprovalDto) }
}

export async function getApprovalUseCase(c: ApprovalUseCaseContext, runId: string): Promise<ApprovalDto> {
	const approval = toApprovalDto(await requireClassifiedRun(c, runId))
	const crossOrigins = await pendingCrossOrigins(c, approval)
	return crossOrigins === undefined ? approval : { ...approval, crossOrigins }
}

/**
 * Approve or refuse one parked run. Only a human user principal, on a console request from its own origin, holding
 * `access.approve` at the run's coordinates; the approval names the two digests the approver read, so a run that was
 * classified again since refuses it. An approved run is queued again and classified once more before it publishes.
 */
export async function completeApprovalUseCase(c: ApprovalUseCaseContext, input: CompleteApprovalRequest): Promise<ApprovalDto> {
	const approver = requireHumanApprover(c.auth, c)
	const run = await requireClassifiedRun(c, input.runId)
	if (run.status !== 'awaiting_approval' || run.classification_json === null) fail(409, 'the run is not waiting for approval')
	const classification = parseClassification(run.classification_json)
	if (classification.candidateDigest !== input.candidateDigest || classification.baselineDigest !== input.baselineDigest) {
		fail(409, 'the change was classified again since it was read; reload it and decide again')
	}
	const lease = await acquireLease(c.lock, runLeaseKey(run.app_id, run.env), c.leaseClock)
	if (lease === null) fail(409, 'the environment is deploying; try again in a moment')
	try {
		const fence = lease.fence()
		const approval: StoredApproval = {
			principalId: approver.id,
			label: approver.label,
			approvedAt: (c.now ?? (() => Math.floor(Date.now() / 1000)))(),
			candidateDigest: classification.candidateDigest,
			baselineDigest: classification.baselineDigest,
		}
		const changed = input.decision === 'approve'
			? await c.repositories.runs.approveParkedRun(run.id, run.classification_json, JSON.stringify(approval), fence)
			: await c.repositories.runs.rejectParkedRun(run.id, run.classification_json, fence)
		if (!changed) fail(409, 'the run is not waiting for approval')
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
			candidateDigest: classification.candidateDigest,
			baselineDigest: classification.baselineDigest,
		},
	})
	if (input.decision === 'approve') await c.queue.send({ runId: run.id })
	return toApprovalDto(await requireClassifiedRun(c, run.id))
}

/** Set an environment's `protected` flag: the same human rule as approving, and audited (ADR-0050 §4). */
export async function setEnvironmentProtectionUseCase(c: ApprovalUseCaseContext, input: SetEnvironmentProtectionRequest): Promise<AppEnvDto> {
	requireHumanApprover(c.auth, c)
	if (!canAtCoordinates(c.auth, CONTROL_ACTIONS.ACCESS_APPROVE, input.appId, input.env)) fail(404, 'app env not found')
	const before = await c.repositories.registry.getAppEnv(input.appId, input.env)
	if (before === null) fail(404, 'app env not found')
	// ADR-0050: a dev environment runs unreviewed workspace heads, and approval never applies to it.
	if (before.kind === 'dev' && input.protected) fail(409, 'a dev environment is never protected')
	// A job started under the old flag would still apply what it allowed, so the change waits for the deployment.
	const lease = await acquireLease(c.lock, runLeaseKey(input.appId, input.env), c.leaseClock)
	if (lease === null) fail(409, 'a deployment is running; retry')
	let row: AppEnvRow | null
	try {
		row = await c.repositories.registry.setAppEnvProtected(input.appId, input.env, input.protected, lease.fence())
	} finally {
		await lease.release()
	}
	if (row === null) {
		if ((await c.repositories.registry.getAppEnv(input.appId, input.env)) === null) fail(404, 'app env not found')
		fail(409, 'a deployment is running; retry')
	}
	await c.auth.audit({
		action: 'access.protect',
		resourceType: 'app_env',
		resourceId: `${input.appId}/${input.env}`,
		metadata: { appId: input.appId, env: input.env, from: before.protected === 1, to: input.protected },
	})
	return toAppEnvDto(row)
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
function namedEndpoints(run: RunRow, changes: readonly AccessChangeDto[]): ApprovalDto['endpoints'] {
	if (run.snapshot_json === null) return []
	const named = new Set(changes.flatMap((change) => (change.subject?.kind === 'endpoint' ? [change.subject.name] : [])))
	return snapshotSurface(parseSnapshot(run.snapshot_json)).filter((endpoint) => named.has(endpoint.id))
}

function toApprovalDto(run: RunRow): ApprovalDto {
	if (run.classification_json === null) throw new Error(`run ${run.id} has no classification`)
	const classification = parseClassification(run.classification_json)
	const approval = run.approval_json === null ? null : parseApproval(run.approval_json)
	return {
		run: toRunDto(run),
		outcome: classification.outcome,
		changes: [...classification.changes],
		endpoints: namedEndpoints(run, classification.changes),
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
		baselineRunId: classification.baselineRunId,
		protected: classification.protected,
		approval: approval === null ? null : {
			principalId: approval.principalId,
			label: approval.label,
			approvedAt: approval.approvedAt,
			holds: approval.candidateDigest === classification.candidateDigest && approval.baselineDigest === classification.baselineDigest,
		},
	}
}
