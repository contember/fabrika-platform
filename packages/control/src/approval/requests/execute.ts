// The execution of an approved request (ADR-0083 §8), under its environment's deployment lease: the policy and the
// before-state are judged again, the operation id is recorded, and only then does the kind act. The maintenance sweep
// expires pending requests past their deadline and settles what an interrupted execution left; it authorizes nothing.

import type { AuthContext } from '@fabrika/auth'
import { ALL_ENVIRONMENTS, isFinalApprovalRequestState, REQUEST_TTL_HOURS } from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import type { ApprovalRequestRow, ControlRegistryRepository, ControlRepositories } from '../../db'
import { acquireLease, acquireLeases, type Lease, type LeaseClock, runLeaseKey } from '../../lease'
import type { Vault } from '../../vault'
import type {
	RequestAction,
	RequestExecution,
	RequestExecutionContext,
	RequestKind,
	RequestKindContext,
	RequestKindRegistry,
	RequestOutcome,
} from './kind'
import { REQUEST_SECRET_LABEL_PREFIX } from './kinds/secrets'
import { PRODUCTION_REQUEST_KINDS } from './production'
import { decidersOf, jsonDigest, judging, reachOf, refusingEnvironment, requestCategory, requesterOf } from './rules'

/** What the row says when an execution threw: its outcome was not observed. Never the error itself, which may carry a secret. */
const UNKNOWN_OUTCOME = 'the execution did not report its outcome; Control follows its operation'

/**
 * Why an approved request no longer passes the policy as it stands now (ADR-0083 §8: a policy made stricter after an
 * approval applies at execution), or null when it does. The request is then closed `stale`, never executed, and the agent
 * asks again under the stricter policy.
 */
async function stricterPolicy(repositories: Pick<ControlRepositories, 'registry'>, row: ApprovalRequestRow): Promise<string | null> {
	const reach = await reachOf(repositories.registry, { appId: row.app_id, env: row.env })
	if (reach === null) {
		return row.env === ALL_ENVIRONMENTS
			? `application \`${row.app_id}\` no longer exists`
			: `environment \`${row.env}\` of \`${row.app_id}\` no longer exists`
	}
	if (judging(reach).length === 0) return null
	const category = requestCategory(row)
	if (category === null) return `this Control does not know the category \`${row.category}\``
	const refusing = refusingEnvironment(reach, category)
	if (refusing !== null) return `environment \`${refusing.env}\` now refuses this to an agent or a key (${category}: refuse)`
	const where = row.env === ALL_ENVIRONMENTS ? `an environment of \`${row.app_id}\`` : `environment \`${row.env}\``
	const who = decidersOf(reach, row)
	if (who.approvers === 2 && row.partial_approver_id === null) return `${where} now takes two people to approve it`
	if (!who.requesterMayApprove) {
		const person = requesterOf(row).personId
		if (person === null || person === row.decided_by_id || person === row.partial_approver_id) {
			return `${where} now lets only someone other than the requester's person approve it`
		}
	}
	const confirmed = row.decided_step_up_credential_id !== null && (row.partial_approver_id === null || row.partial_step_up_credential_id !== null)
	if (who.stepUp === 'webauthn' && !confirmed) return `${where} now takes a passkey to decide it`
	return null
}

/**
 * The request's kind and its checked input, or why this Control cannot act on it. The input must read back to the digest
 * the person approved: a kind's schema drops a key it does not know (a later release's), and acting on the rest would
 * act on less than what was approved.
 */
export function actionOf(
	kind: RequestKind | undefined,
	row: Pick<ApprovalRequestRow, 'kind' | 'input_json' | 'input_digest'>,
): RequestAction | string {
	if (kind === undefined) return `this Control cannot execute kind \`${row.kind}\``
	const checked = kind.action(JSON.parse(row.input_json))
	if (!checked.ok) return `this Control cannot read the request's input: ${checked.error}`
	if (jsonDigest(checked.action.inputJson) !== row.input_digest) {
		return "this Control reads the request's input without part of it (a later release's), so what it would execute is not the input that was approved"
	}
	return checked.action
}

/**
 * The leases an execution of the request holds: its environment's deployment lease, or for `ALL_ENVIRONMENTS` the lease
 * of every environment the layer reaches and `<app>:*`, the row's own fence, all or none. Null while any is held
 * elsewhere: a deploy of one environment the layer reaches holds the whole layer off.
 */
export async function acquireRequestLease(
	lock: DeployLocks,
	registry: Pick<ControlRegistryRepository, 'listAppEnvs'>,
	row: Pick<ApprovalRequestRow, 'app_id' | 'env'>,
	clock?: LeaseClock,
): Promise<Lease | null> {
	const own = runLeaseKey(row.app_id, row.env)
	if (row.env !== ALL_ENVIRONMENTS) return acquireLease(lock, own, clock)
	const reach = await registry.listAppEnvs(row.app_id)
	return acquireLeases(lock, [own, ...reach.map((appEnv) => runLeaseKey(appEnv.app_id, appEnv.env))], own, clock)
}

/**
 * Execute an approved request with the approver's authority (`c.auth`), under `lease`. The policy as it stands now and
 * the before-state are checked first; either closes the request `stale`. The operation id is recorded before the kind
 * acts, and a throw leaves the request `unknown` for the sweep to follow.
 */
export async function executeApprovedRequest(c: RequestExecutionContext, kind: RequestKind, row: ApprovalRequestRow, lease: Lease): Promise<void> {
	const requests = c.repositories.approvalRequests
	if (row.state !== 'approved') return
	const close = async (state: 'stale' | 'failed', error: string): Promise<void> => {
		if (await requests.closeApproved(row.id, state, error, lease.fence())) await discardRequest(kind, c, row)
	}
	const action = actionOf(kind, row)
	if (typeof action === 'string') {
		await close('failed', action)
		return
	}
	const stricter = await stricterPolicy(c.repositories, row)
	if (stricter !== null) {
		await close('stale', `${stricter} since it was approved, so it was not executed; ask again`)
		return
	}
	if (jsonDigest(await action.captureBefore(c)) !== row.before_digest) {
		await close('stale', 'what the request acts on changed since it was asked for, so it was not executed; ask again')
		return
	}
	const operationId = uuidv7()
	if (!(await requests.startExecution(row.id, operationId, lease.fence()))) return
	const execution = { requestId: row.id, operationId, signal: lease.signal }
	let outcome: RequestOutcome
	try {
		outcome = await action.execute(c, execution)
	} catch {
		await requests.markUnknown(row.id, operationId, UNKNOWN_OUTCOME, lease.fence())
		await auditExecution(c.auth, row, operationId, 'unknown')
		return
	}
	const finished = await requests.finish(row.id, operationId, stored(outcome), lease.fence())
	await auditExecution(c.auth, row, operationId, outcome.state)
	if (finished) await discardRequest(kind, c, row)
}

/** The change the approver made, recorded under the approver with the requester beside them. */
async function auditExecution(
	auth: AuthContext,
	row: ApprovalRequestRow,
	operationId: string,
	state: 'executed' | 'failed' | 'unknown',
): Promise<void> {
	await auth.audit({
		action: row.kind,
		resourceType: 'approval_request',
		resourceId: row.id,
		metadata: {
			appId: row.app_id,
			env: row.env,
			category: row.category,
			state,
			operationId,
			inputDigest: row.input_digest,
			requester: {
				id: row.requester_id,
				label: row.requester_label,
				...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
			},
		},
	})
}

/** An outcome as the row stores it. */
function stored(
	outcome: RequestOutcome,
): { readonly state: 'executed'; readonly resultJson: string } | { readonly state: 'failed'; readonly error: string } {
	return outcome.state === 'executed' ? { state: 'executed', resultJson: JSON.stringify(outcome.result) } : outcome
}

/** The kind's settlement of an unknown execution, or null while it stays unknown, a throw included. */
async function follow(action: RequestAction, c: RequestKindContext, execution: RequestExecution): Promise<RequestOutcome | null> {
	try {
		const followed = await action.follow(c, execution)
		return followed.state === 'unknown' ? null : followed
	} catch {
		return null
	}
}

/**
 * Let the request's kind release what the request held (a sealed secret), once it is closed: refused, expired, stale,
 * failed or executed, never while its outcome is unknown, which its kind's `follow` compares against. That write is
 * done, so a throw only leaves the held state behind; it is logged without the error, which may carry a secret.
 */
export async function discardRequest(kind: RequestKind | undefined, c: RequestKindContext, row: ApprovalRequestRow): Promise<void> {
	const discard = kind?.discard
	if (discard === undefined) return
	try {
		await discard({ repositories: c.repositories, ...(c.vault === undefined ? {} : { vault: c.vault }) }, row)
	} catch {
		console.warn(`approval request ${row.id}: kind ${row.kind} could not discard what the request held`)
	}
}

/** What the request sweep did. */
export interface ApprovalRequestSweepSummary {
	/** Pending requests past their deadline. */
	expired: number
	/** Approved requests whose execution never started: closed `failed`, nothing having happened. */
	interrupted: number
	/** Unknown executions the kind settled as executed or failed. */
	settled: number
	/** Sealed copies deleted that no open request held: its request was closed, or never written. */
	orphans: number
}

export interface ApprovalRequestSweepDeps {
	readonly repositories: ControlRepositories
	/** Where a request's sealed secret waits: an expired request's is deleted, an unknown execution's compared. */
	readonly vault?: () => Promise<Vault>
	readonly lock: DeployLocks
	readonly leaseClock?: LeaseClock
	readonly kinds?: RequestKindRegistry
	/** Unix seconds; the system clock when absent. */
	readonly now?: () => number
}

/**
 * Settle approval requests in maintenance (ADR-0083 §8). A pending request past its deadline expires. One the sweep holds
 * the environment's lease for is not being executed, since an execution holds it throughout: an `approved` one never
 * reached its operation id, so nothing happened and it closes `failed`; an `executing` one was interrupted and becomes
 * `unknown`; an `unknown` one is followed or retried through its kind's own hook. Nothing here decides or executes a
 * request anew.
 */
export async function sweepApprovalRequests(deps: ApprovalRequestSweepDeps): Promise<ApprovalRequestSweepSummary> {
	const requests = deps.repositories.approvalRequests
	const kinds = deps.kinds ?? PRODUCTION_REQUEST_KINDS
	const summary: ApprovalRequestSweepSummary = { expired: 0, interrupted: 0, settled: 0, orphans: 0 }
	for (const listed of await requests.listToSweep()) {
		if (listed.state === 'pending') {
			if (await requests.expire(listed.id)) {
				summary.expired++
				await discardRequest(kinds.get(listed.kind), deps, listed)
			}
			continue
		}
		// An unknown request this Control cannot follow (a later release's kind, after a rollback) stays unknown for the
		// release that can; its kind and input never change, so the sweep need not take the environment's lease to see it.
		if (listed.state === 'unknown' && typeof actionOf(kinds.get(listed.kind), listed) === 'string') continue
		const lease = await acquireRequestLease(deps.lock, deps.repositories.registry, listed, deps.leaseClock)
		if (lease === null) continue
		try {
			const row = await requests.get(listed.id)
			if (row === null) continue
			if (row.state === 'approved') {
				const error = 'Control stopped after the approval and before the execution started, so nothing changed; ask again'
				if (await requests.closeApproved(row.id, 'failed', error, lease.fence())) {
					summary.interrupted++
					await discardRequest(kinds.get(row.kind), deps, row)
				}
				continue
			}
			if ((row.state !== 'executing' && row.state !== 'unknown') || row.operation_id === null) continue
			const operationId = row.operation_id
			if (row.state === 'executing' && !(await requests.markUnknown(row.id, operationId, UNKNOWN_OUTCOME, lease.fence()))) continue
			const action = actionOf(kinds.get(row.kind), row)
			if (typeof action === 'string') continue
			const followed = await follow(action, deps, { requestId: row.id, operationId, signal: lease.signal })
			if (followed === null) continue
			if (await requests.finish(row.id, operationId, stored(followed), lease.fence())) {
				summary.settled++
				await discardRequest(kinds.get(row.kind), deps, row)
			}
		} finally {
			await lease.release()
		}
	}
	summary.orphans = await deleteOrphanedCopies(deps)
	return summary
}

/**
 * How old a sealed copy must be before the sweep judges it: past the longest a request waits, and an hour more, since a
 * value is sealed before its request is written.
 */
const ORPHAN_AGE_SECONDS = (REQUEST_TTL_HOURS.max + 1) * 3600

/**
 * Delete the sealed copies no request may still need: its request closed (refused, expired, stale, failed or executed)
 * or never written, once older than `ORPHAN_AGE_SECONDS`. They are left by a crash between sealing and the row's insert
 * or between closing and the discard, by a discard that threw, and by a release without request kinds that closed one.
 * A copy of an open or `unknown` request stays: its kind compares against it.
 */
async function deleteOrphanedCopies(deps: ApprovalRequestSweepDeps): Promise<number> {
	if (deps.vault === undefined) return 0
	let vault: Vault
	try {
		vault = await deps.vault()
	} catch {
		// Without a vault nothing was sealed.
		return 0
	}
	const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
	let deleted = 0
	for (const sealed of await vault.listSealed('platform', REQUEST_SECRET_LABEL_PREFIX, now - ORPHAN_AGE_SECONDS)) {
		const requestId = sealed.label.slice(REQUEST_SECRET_LABEL_PREFIX.length)
		const request = await deps.repositories.approvalRequests.get(requestId)
		if (request !== null && !isFinalApprovalRequestState(request.state)) continue
		if (await vault.delete(sealed.ref)) deleted++
	}
	return deleted
}
