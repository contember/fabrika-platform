// The execution of an approved request (ADR-0083 §8), under its environment's deployment lease: the policy and the
// before-state are judged again, the operation id is recorded, and only then does the kind act. The maintenance sweep
// expires pending requests past their deadline and settles what an interrupted execution left; it authorizes nothing.

import type { AuthContext } from '@fabrika/auth'
import { gate } from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import type { ApprovalRequestRow, ControlRepositories } from '../../db'
import { acquireLease, type Lease, type LeaseClock, runLeaseKey } from '../../lease'
import {
	PRODUCTION_REQUEST_KINDS,
	type RequestAction,
	type RequestExecution,
	type RequestKind,
	type RequestKindContext,
	type RequestKindRegistry,
	type RequestOutcome,
} from './kind'
import { deciders, jsonDigest, policyOf, requestCategory, requesterOf, settingsOf } from './rules'

/** What the row says when an execution threw: its outcome was not observed. Never the error itself, which may carry a secret. */
const UNKNOWN_OUTCOME = 'the execution did not report its outcome; Control follows its operation'

/**
 * Why an approved request no longer passes the policy as it stands now (ADR-0083 §8: a policy made stricter after an
 * approval applies at execution), or null when it does. The request is then closed `stale`, never executed, and the agent
 * asks again under the stricter policy.
 */
async function stricterPolicy(repositories: Pick<ControlRepositories, 'registry'>, row: ApprovalRequestRow): Promise<string | null> {
	const appEnv = await repositories.registry.getAppEnv(row.app_id, row.env)
	if (appEnv === null) return `environment \`${row.env}\` of \`${row.app_id}\` no longer exists`
	if (appEnv.protected !== 1) return null
	const category = requestCategory(row)
	if (category === null) return `this Control does not know the category \`${row.category}\``
	if (gate({ lines: [], actions: [category] }, policyOf(appEnv)).kind === 'refuse') {
		return `environment \`${row.env}\` now refuses this to an agent or a key (${category}: refuse)`
	}
	const who = deciders(settingsOf(appEnv), row)
	if (who.approvers === 2 && row.partial_approver_id === null) return `environment \`${row.env}\` now takes two people to approve it`
	if (!who.requesterMayApprove) {
		const person = requesterOf(row).personId
		if (person === null || person === row.decided_by_id || person === row.partial_approver_id) {
			return `environment \`${row.env}\` now lets only someone other than the requester's person approve it`
		}
	}
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
 * Execute an approved request with the approver's authority (`c.auth`), under `lease`. The policy as it stands now and
 * the before-state are checked first; either closes the request `stale`. The operation id is recorded before the kind
 * acts, and a throw leaves the request `unknown` for the sweep to follow.
 */
export async function executeApprovedRequest(
	c: RequestKindContext & { readonly auth: AuthContext },
	kind: RequestKind,
	row: ApprovalRequestRow,
	lease: Lease,
): Promise<void> {
	const requests = c.repositories.approvalRequests
	if (row.state !== 'approved') return
	const action = actionOf(kind, row)
	if (typeof action === 'string') {
		await requests.closeApproved(row.id, 'failed', action, lease.fence())
		return
	}
	const stricter = await stricterPolicy(c.repositories, row)
	if (stricter !== null) {
		await requests.closeApproved(row.id, 'stale', `${stricter} since it was approved, so it was not executed; ask again`, lease.fence())
		return
	}
	if (jsonDigest(await action.captureBefore(c)) !== row.before_digest) {
		await requests.closeApproved(
			row.id,
			'stale',
			'what the request acts on changed since it was asked for, so it was not executed; ask again',
			lease.fence(),
		)
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
	await requests.finish(row.id, operationId, stored(outcome), lease.fence())
	await auditExecution(c.auth, row, operationId, outcome.state)
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
async function follow(action: RequestAction, repositories: ControlRepositories, execution: RequestExecution): Promise<RequestOutcome | null> {
	try {
		const followed = await action.follow({ repositories }, execution)
		return followed.state === 'unknown' ? null : followed
	} catch {
		return null
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
}

export interface ApprovalRequestSweepDeps {
	readonly repositories: ControlRepositories
	readonly lock: DeployLocks
	readonly leaseClock?: LeaseClock
	readonly kinds?: RequestKindRegistry
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
	const summary: ApprovalRequestSweepSummary = { expired: 0, interrupted: 0, settled: 0 }
	for (const listed of await requests.listToSweep()) {
		if (listed.state === 'pending') {
			if (await requests.expire(listed.id)) summary.expired++
			continue
		}
		// An unknown request this Control cannot follow (a later release's kind, after a rollback) stays unknown for the
		// release that can; its kind and input never change, so the sweep need not take the environment's lease to see it.
		if (listed.state === 'unknown' && typeof actionOf(kinds.get(listed.kind), listed) === 'string') continue
		const lease = await acquireLease(deps.lock, runLeaseKey(listed.app_id, listed.env), deps.leaseClock)
		if (lease === null) continue
		try {
			const row = await requests.get(listed.id)
			if (row === null) continue
			if (row.state === 'approved') {
				const error = 'Control stopped after the approval and before the execution started, so nothing changed; ask again'
				if (await requests.closeApproved(row.id, 'failed', error, lease.fence())) summary.interrupted++
				continue
			}
			if ((row.state !== 'executing' && row.state !== 'unknown') || row.operation_id === null) continue
			const operationId = row.operation_id
			if (row.state === 'executing' && !(await requests.markUnknown(row.id, operationId, UNKNOWN_OUTCOME, lease.fence()))) continue
			const action = actionOf(kinds.get(row.kind), row)
			if (typeof action === 'string') continue
			const followed = await follow(action, deps.repositories, { requestId: row.id, operationId, signal: lease.signal })
			if (followed === null) continue
			if (await requests.finish(row.id, operationId, stored(followed), lease.fence())) summary.settled++
		} finally {
			await lease.release()
		}
	}
	return summary
}
