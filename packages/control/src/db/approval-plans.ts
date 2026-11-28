import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'

export type ApprovalPlanRowState = 'pending' | 'approved' | 'rejected' | 'revoked'

/** One approval plan (ADR-0050 §5). Its plan fields are written once; each transition fills only its own columns. */
export interface ApprovalPlanRow {
	id: string
	app_id: string
	env: string
	commit_sha: string
	requester_id: string
	requester_type: string
	requester_label: string
	/** `console`: a person in the console made it; `oauth` and `key` as on an approval request. */
	requester_credential: 'oauth' | 'key' | 'console'
	requester_client_id: string | null
	requester_grant_id: string | null
	outcome: 'none' | 'no-widening' | 'widening'
	/** The classification's lines, as the approver reads them. */
	changes_json: string
	candidate_digest: string
	baseline_digest: string
	baseline_run_id: string | null
	state: ApprovalPlanRowState
	partial_approver_id: string | null
	partial_approver_label: string | null
	partial_approved_at: number | null
	partial_step_up_credential_id: string | null
	partial_step_up_at: number | null
	decided_by_id: string | null
	decided_by_label: string | null
	decided_at: number | null
	decided_step_up_credential_id: string | null
	decided_step_up_at: number | null
	revoked_by_id: string | null
	revoked_by_label: string | null
	revoked_at: number | null
	deadline: number
	/** Until when the approved plan's entries cover a deploy; null until it is approved. */
	expires_at: number | null
	created_at: number
	updated_at: number
}

export type ApprovalPlanEntryRowState = 'pending' | 'active' | 'consumed' | 'revoked'

export interface ApprovalPlanEntryRow {
	id: string
	plan_id: string
	app_id: string
	env: string
	/** `<kind>:<name>`, as a change line names its subject. */
	subject: string
	/** `sha256:<hex>` of the subject's fragment in the baseline and in the candidate the approver saw. */
	before_hash: string
	after_hash: string
	/** A JSON array of the `sha256:<hex>` digests of the lines the approver saw for the subject. */
	lines_json: string
	state: ApprovalPlanEntryRowState
	expires_at: number | null
	consumed_by_run: string | null
	consumed_at: number | null
}

export interface ApprovalPlanEntryInput {
	readonly id: string
	readonly subject: string
	readonly beforeHash: string
	readonly afterHash: string
	readonly lines: readonly string[]
}

export interface ApprovalPlanInput {
	readonly id: string
	readonly appId: string
	readonly env: string
	readonly commitSha: string
	readonly requester: {
		readonly id: string
		readonly type: string
		readonly label: string
		readonly credential: 'oauth' | 'key' | 'console'
		readonly clientId: string | null
		readonly grantId: string | null
	}
	readonly outcome: ApprovalPlanRow['outcome']
	readonly changesJson: string
	readonly candidateDigest: string
	readonly baselineDigest: string
	readonly baselineRunId: string | null
	/** How long it waits for a decision: its absolute deadline is this long after it is created. */
	readonly ttlSeconds: number
	readonly entries: readonly ApprovalPlanEntryInput[]
}

/** A person deciding, and the passkey they confirmed it with (its WebAuthn id and when IAM verified it), when it took one. */
export interface ApprovalPlanDecider {
	readonly id: string
	readonly label: string
	readonly stepUp: { readonly credentialId: string; readonly at: number } | null
}

/**
 * Approval plans and their entries. Every transition is one conditional update on the state it leaves; a decision checks
 * the deadline in the same statement, and an approval activates the plan's entries in the same batch. A publication
 * consumes the entries it covered in its own compare-and-swap (`RunRepository.publishRunSnapshot`).
 */
export class ApprovalPlanRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	/** The plan and its `pending` entries, in one batch. */
	async create(input: ApprovalPlanInput): Promise<ApprovalPlanRow> {
		const now = this.now()
		const r = input.requester
		await this.db.batch([
			this.db
				.prepare(`INSERT INTO approval_plans (id, app_id, env, commit_sha, requester_id, requester_type, requester_label, requester_credential,
					requester_client_id, requester_grant_id, outcome, changes_json, candidate_digest, baseline_digest, baseline_run_id, state, deadline,
					created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
				.bind(
					input.id,
					input.appId,
					input.env,
					input.commitSha,
					r.id,
					r.type,
					r.label,
					r.credential,
					r.clientId,
					r.grantId,
					input.outcome,
					input.changesJson,
					input.candidateDigest,
					input.baselineDigest,
					input.baselineRunId,
					now + input.ttlSeconds,
					now,
					now,
				),
			...input.entries.map((entry) =>
				this.db
					.prepare(`INSERT INTO approval_plan_entries (id, plan_id, app_id, env, subject, before_hash, after_hash, lines_json, state)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
					.bind(entry.id, input.id, input.appId, input.env, entry.subject, entry.beforeHash, entry.afterHash, JSON.stringify(entry.lines))
			),
		])
		return firstRow<ApprovalPlanRow>(this.db.prepare('SELECT * FROM approval_plans WHERE id = ?').bind(input.id))
	}

	async get(id: string): Promise<ApprovalPlanRow | null> {
		return this.db.prepare('SELECT * FROM approval_plans WHERE id = ?').bind(id).first<ApprovalPlanRow>()
	}

	async entries(planId: string): Promise<ApprovalPlanEntryRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM approval_plan_entries WHERE plan_id = ? ORDER BY subject, id')
			.bind(planId)
			.all<ApprovalPlanEntryRow>()
		return results
	}

	/**
	 * Plans waiting for a decision before their deadline, and approved ones with an entry that still covers a deploy,
	 * newest first, older than `before` when it is given.
	 */
	async listOpen(limit: number, before: string | null = null): Promise<ApprovalPlanRow[]> {
		const now = this.now()
		const { results } = await this.db
			.prepare(
				`SELECT * FROM approval_plans p WHERE ((p.state = 'pending' AND p.deadline > ?)
				 OR (p.state = 'approved' AND EXISTS (
				 	SELECT 1 FROM approval_plan_entries e WHERE e.plan_id = p.id AND e.state = 'active' AND e.expires_at > ?
				 )))${before === null ? '' : ' AND p.id < ?'}
				 ORDER BY p.id DESC LIMIT ?`,
			)
			.bind(now, now, ...(before === null ? [] : [before]), limit)
			.all<ApprovalPlanRow>()
		return results
	}

	/** The entries that cover a publication of the environment now: active, of an approved plan, before their expiry. */
	async activeEntries(appId: string, env: string): Promise<ApprovalPlanEntryRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM approval_plan_entries WHERE app_id = ? AND env = ? AND state = 'active' AND expires_at > ? ORDER BY id`)
			.bind(appId, env, this.now())
			.all<ApprovalPlanEntryRow>()
		return results
	}

	/** Record the first of two approvals; only while none is recorded, before the deadline. */
	async recordPartialApproval(id: string, approver: ApprovalPlanDecider): Promise<boolean> {
		const now = this.now()
		return this.changed(
			`UPDATE approval_plans SET partial_approver_id = ?, partial_approver_label = ?, partial_approved_at = ?,
				partial_step_up_credential_id = ?, partial_step_up_at = ?, updated_at = ?
			WHERE id = ? AND state = 'pending' AND deadline > ? AND partial_approver_id IS NULL`,
			[approver.id, approver.label, now, approver.stepUp?.credentialId ?? null, approver.stepUp?.at ?? null, now, id, now],
		)
	}

	/**
	 * `pending` → `approved` before the deadline, while the plan holds the first approval the decision read
	 * (`partialApproverId`, null for none), and its entries `pending` → `active` until `expiresAt`, in one batch.
	 */
	async approve(id: string, decider: ApprovalPlanDecider, partialApproverId: string | null, expiresAt: number): Promise<boolean> {
		const now = this.now()
		const results = await this.db.batch<{ id: string }>([
			this.db
				.prepare(`UPDATE approval_plans SET state = 'approved', decided_by_id = ?, decided_by_label = ?, decided_at = ?,
					decided_step_up_credential_id = ?, decided_step_up_at = ?, expires_at = ?, updated_at = ?
				WHERE id = ? AND state = 'pending' AND deadline > ? AND partial_approver_id IS NOT DISTINCT FROM ?
				RETURNING id`)
				.bind(
					decider.id,
					decider.label,
					now,
					decider.stepUp?.credentialId ?? null,
					decider.stepUp?.at ?? null,
					expiresAt,
					now,
					id,
					now,
					partialApproverId,
				),
			this.db
				.prepare(`UPDATE approval_plan_entries SET state = 'active', expires_at = ?
				WHERE plan_id = ? AND state = 'pending'
					AND EXISTS (SELECT 1 FROM approval_plans WHERE approval_plans.id = ? AND approval_plans.state = 'approved' AND approval_plans.decided_at = ?)`)
				.bind(expiresAt, id, id, now),
		])
		return (results[0]?.results.length ?? 0) > 0
	}

	/** `pending` → `rejected` before the deadline. Its entries stay `pending` and cover nothing. */
	async reject(id: string, decider: ApprovalPlanDecider): Promise<boolean> {
		const now = this.now()
		return this.changed(
			`UPDATE approval_plans SET state = 'rejected', decided_by_id = ?, decided_by_label = ?, decided_at = ?,
				decided_step_up_credential_id = ?, decided_step_up_at = ?, updated_at = ?
			WHERE id = ? AND state = 'pending' AND deadline > ?`,
			[decider.id, decider.label, now, decider.stepUp?.credentialId ?? null, decider.stepUp?.at ?? null, now, id, now],
		)
	}

	/** `approved` → `revoked`, and every entry still `active` with it: a consumed entry keeps the run it covered. */
	async revoke(id: string, by: { readonly id: string; readonly label: string }): Promise<boolean> {
		const now = this.now()
		const results = await this.db.batch<{ id: string }>([
			this.db
				.prepare(`UPDATE approval_plans SET state = 'revoked', revoked_by_id = ?, revoked_by_label = ?, revoked_at = ?, updated_at = ?
				WHERE id = ? AND state = 'approved' RETURNING id`)
				.bind(by.id, by.label, now, now, id),
			this.db
				.prepare(`UPDATE approval_plan_entries SET state = 'revoked'
				WHERE plan_id = ? AND state = 'active'
					AND EXISTS (SELECT 1 FROM approval_plans WHERE approval_plans.id = ? AND approval_plans.state = 'revoked')`)
				.bind(id, id),
		])
		return (results[0]?.results.length ?? 0) > 0
	}

	private async changed(sql: string, values: (string | number | null)[]): Promise<boolean> {
		const result = await this.db.prepare(`${sql} RETURNING id`).bind(...values).all<{ id: string }>()
		return result.results.length > 0
	}
}
