import type { SqlDatabase } from '@fabrika/platform'
import type { LeaseFence } from '../lease'
import { firstRow } from './returning'

export type ApprovalRequestRowState = 'pending' | 'approved' | 'rejected' | 'expired' | 'executing' | 'executed' | 'failed' | 'unknown' | 'stale'

/** One approval request (ADR-0083 §8). Its request fields are written once; each transition fills only its own columns. */
export interface ApprovalRequestRow {
	id: string
	kind: string
	/** The kind's input in canonical JSON (keys sorted), as it was checked. */
	input_json: string
	/** `sha256:<hex>` of `input_json`. */
	input_digest: string
	app_id: string
	env: string
	category: string
	requester_id: string
	requester_type: string
	requester_label: string
	requester_credential: 'oauth' | 'key'
	requester_client_id: string | null
	requester_grant_id: string | null
	requester_issuer_id: string | null
	/** What the action depends on, captured at creation, in canonical JSON. */
	before_json: string
	before_digest: string
	state: ApprovalRequestRowState
	partial_approver_id: string | null
	partial_approver_label: string | null
	partial_approved_at: number | null
	/** Fresh per decision, so a second tap that lost the race is told apart from the one that won. */
	decision_id: string | null
	decided_by_id: string | null
	decided_by_label: string | null
	decided_at: number | null
	operation_id: string | null
	result_json: string | null
	error: string | null
	deadline: number
	created_at: number
	updated_at: number
}

export interface ApprovalRequestInput {
	id: string
	kind: string
	inputJson: string
	inputDigest: string
	appId: string
	env: string
	category: string
	requester: {
		readonly id: string
		readonly type: string
		readonly label: string
		readonly credential: 'oauth' | 'key'
		readonly clientId: string | null
		readonly grantId: string | null
		readonly issuerId: string | null
	}
	beforeJson: string
	beforeDigest: string
	/** How long it waits for a decision: its absolute deadline is this long after it is created. */
	ttlSeconds: number
}

/** A person deciding: who, under a fresh decision id. */
export interface ApprovalRequestDecider {
	readonly decisionId: string
	readonly id: string
	readonly label: string
}

/**
 * Approval requests. Every transition is one conditional update on the state it leaves; the decision checks the deadline
 * in the same statement. The writes made under the environment's deployment lease (the final approval and everything
 * after it) are fenced on it, as a run's lifecycle writes are.
 */
export class ApprovalRequestRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async create(input: ApprovalRequestInput): Promise<ApprovalRequestRow> {
		const now = this.now()
		const r = input.requester
		return firstRow<ApprovalRequestRow>(
			this.db
				.prepare(`INSERT INTO approval_requests (id, kind, input_json, input_digest, app_id, env, category, requester_id, requester_type,
					requester_label, requester_credential, requester_client_id, requester_grant_id, requester_issuer_id, before_json, before_digest,
					state, deadline, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING *`)
				.bind(
					input.id,
					input.kind,
					input.inputJson,
					input.inputDigest,
					input.appId,
					input.env,
					input.category,
					r.id,
					r.type,
					r.label,
					r.credential,
					r.clientId,
					r.grantId,
					r.issuerId,
					input.beforeJson,
					input.beforeDigest,
					now + input.ttlSeconds,
					now,
					now,
				),
		)
	}

	async get(id: string): Promise<ApprovalRequestRow | null> {
		return this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').bind(id).first<ApprovalRequestRow>()
	}

	/** Requests still waiting for a decision before their deadline, newest first. */
	async listPending(limit: number): Promise<ApprovalRequestRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM approval_requests WHERE state = 'pending' AND deadline > ? ORDER BY id DESC LIMIT ?`)
			.bind(this.now(), limit)
			.all<ApprovalRequestRow>()
		return results
	}

	/** Record the first of two approvals; only while none is recorded, before the deadline. */
	async recordPartialApproval(id: string, approver: { readonly id: string; readonly label: string }): Promise<boolean> {
		const now = this.now()
		return this.changed(
			`UPDATE approval_requests SET partial_approver_id = ?, partial_approver_label = ?, partial_approved_at = ?, updated_at = ?
			WHERE id = ? AND state = 'pending' AND deadline > ? AND partial_approver_id IS NULL`,
			[approver.id, approver.label, now, now, id, now],
		)
	}

	/**
	 * `pending` → `approved` under a fresh decision id, before the deadline, while the request still holds the first
	 * approval the decision read (`partialApproverId`, null for none). Fenced on the environment's lease, which the
	 * execution that follows holds.
	 */
	async approve(id: string, decider: ApprovalRequestDecider, partialApproverId: string | null, fence: LeaseFence): Promise<boolean> {
		const now = this.now()
		return this.fenced(
			id,
			`UPDATE approval_requests SET state = 'approved', decision_id = ?, decided_by_id = ?, decided_by_label = ?, decided_at = ?, updated_at = ?
			WHERE id = ? AND state = 'pending' AND deadline > ? AND partial_approver_id IS NOT DISTINCT FROM ?`,
			[decider.decisionId, decider.id, decider.label, now, now, id, now, partialApproverId],
			fence,
		)
	}

	/** `pending` → `rejected` under a fresh decision id, before the deadline. */
	async reject(id: string, decider: ApprovalRequestDecider): Promise<boolean> {
		const now = this.now()
		return this.changed(
			`UPDATE approval_requests SET state = 'rejected', decision_id = ?, decided_by_id = ?, decided_by_label = ?, decided_at = ?, updated_at = ?
			WHERE id = ? AND state = 'pending' AND deadline > ?`,
			[decider.decisionId, decider.id, decider.label, now, now, id, now],
		)
	}

	/** `pending` → `expired` once the deadline passed. Authorizes nothing: a decision checks the deadline itself. */
	async expire(id: string): Promise<boolean> {
		const now = this.now()
		return this.changed(
			`UPDATE approval_requests SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'pending' AND deadline <= ?`,
			[now, id, now],
		)
	}

	/** `approved` → `executing`, recording the operation id before any external effect. */
	async startExecution(id: string, operationId: string, fence: LeaseFence): Promise<boolean> {
		return this.fenced(
			id,
			`UPDATE approval_requests SET state = 'executing', operation_id = ?, updated_at = ? WHERE id = ? AND state = 'approved'`,
			[operationId, this.now(), id],
			fence,
		)
	}

	/** `approved` → `stale` or `failed`, with why, when it never reached its execution. Nothing external happened. */
	async closeApproved(id: string, state: 'stale' | 'failed', error: string, fence: LeaseFence): Promise<boolean> {
		return this.fenced(
			id,
			`UPDATE approval_requests SET state = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'approved'`,
			[state, error, this.now(), id],
			fence,
		)
	}

	/** `executing` or `unknown` → `executed` with the result, or `failed` with why, for the operation the row records. */
	async finish(
		id: string,
		operationId: string,
		outcome: { readonly state: 'executed'; readonly resultJson: string } | { readonly state: 'failed'; readonly error: string },
		fence: LeaseFence,
	): Promise<boolean> {
		return this.fenced(
			id,
			`UPDATE approval_requests SET state = ?, result_json = ?, error = ?, updated_at = ?
			WHERE id = ? AND state IN ('executing', 'unknown') AND operation_id = ?`,
			[
				outcome.state,
				outcome.state === 'executed' ? outcome.resultJson : null,
				outcome.state === 'failed' ? outcome.error : null,
				this.now(),
				id,
				operationId,
			],
			fence,
		)
	}

	/** `executing` → `unknown`: the execution did not say what happened, so Control follows the operation. */
	async markUnknown(id: string, operationId: string, error: string, fence: LeaseFence): Promise<boolean> {
		return this.fenced(
			id,
			`UPDATE approval_requests SET state = 'unknown', error = ?, updated_at = ? WHERE id = ? AND state = 'executing' AND operation_id = ?`,
			[error, this.now(), id, operationId],
			fence,
		)
	}

	/**
	 * What the maintenance sweep settles: pending requests past their deadline, and approved, executing and unknown ones,
	 * which it reaches only once it holds their environment's lease.
	 */
	async listToSweep(): Promise<ApprovalRequestRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM approval_requests
				WHERE (state = 'pending' AND deadline <= ?) OR state IN ('approved', 'executing', 'unknown') ORDER BY id`)
			.bind(this.now())
			.all<ApprovalRequestRow>()
		return results
	}

	private async changed(sql: string, values: (string | number | null)[]): Promise<boolean> {
		const result = await this.db.prepare(`${sql} RETURNING id`).bind(...values).all<{ id: string }>()
		return result.results.length > 0
	}

	/** The lease row stays locked through the write, as a run's lifecycle write keeps it (an EXISTS alone races on Postgres). */
	private async fenced(id: string, sql: string, values: (string | number | null)[], fence: LeaseFence): Promise<boolean> {
		const results = await this.db.batch<{ id: string }>([
			this.db.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM approval_requests WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(id, fence.holder, fence.nowMs),
			this.db.prepare(`${sql}
				AND EXISTS (SELECT 1 FROM deploy_locks
					WHERE lock_key = approval_requests.app_id || ':' || approval_requests.env AND holder = ? AND expires_at > ?)
				RETURNING id`).bind(...values, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}
