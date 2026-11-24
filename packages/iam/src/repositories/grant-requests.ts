import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter } from './audit'

/**
 * One requested grant change at an application whose console grants wait for approval (ADR-0083). Nothing that resolves
 * permissions reads it; `GrantRepository.applyRequest` writes the change when a person approves it.
 */
export interface GrantRequestRow {
	id: string
	app: string
	kind: 'create' | 'update' | 'revoke'
	principal_id: string
	/** The grant an `update` edits or a `revoke` removes; null for `create`. */
	grant_id: string | null
	role_key: string | null
	/** Inline action-pattern set (JSON array); XOR `role_key`. */
	permissions: string | null
	scope_type: string | null
	scope_value: string | null
	grant_expires_at: number | null
	requested_by: string
	requested_at: number
	expires_at: number
	status: 'pending' | 'approved' | 'rejected' | 'failed'
	/** The approval that claimed it, which the change it wrote carries in its guard. */
	decision_id: string | null
	decided_by: string | null
	decided_at: number | null
}

export interface CreateGrantRequestInput {
	app: string
	kind: GrantRequestRow['kind']
	principalId: string
	grantId: string | null
	roleKey: string | null
	permissions: string[] | null
	scopeType: string | null
	scopeValue: string | null
	grantExpiresAt: number | null
	requestedBy: string
	requestedAt: number
	expiresAt: number
}

export class GrantRequestRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** Whether a grant change at `app` waits for approval. */
	async grantsWait(app: string): Promise<boolean> {
		return (await this.db.prepare('SELECT app FROM app_grant_approvals WHERE app = ?').bind(app).first()) !== null
	}

	/** Make grant changes at `app` wait, or apply at once again; false when it already was so, and nothing is recorded. */
	async setGrantsWait(app: string, required: boolean, now: number, audit: AuditEventInput): Promise<boolean> {
		const change = required
			? { sql: 'INSERT INTO app_grant_approvals (app, created_at) VALUES (?, ?) ON CONFLICT (app) DO NOTHING RETURNING app', binds: [app, now] }
			: { sql: 'DELETE FROM app_grant_approvals WHERE app = ? RETURNING app', binds: [app] }
		return (await this.writer.run([change], audit)).length > 0
	}

	async create(input: CreateGrantRequestInput, audit: (requestId: string) => AuditEventInput): Promise<GrantRequestRow> {
		const id = uuidv7()
		const [created] = await this.writer.run<GrantRequestRow>([{
			sql: `INSERT INTO grant_requests (id, app, kind, principal_id, grant_id, role_key, permissions, scope_type, scope_value,
					grant_expires_at, requested_by, requested_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
			binds: [
				id,
				input.app,
				input.kind,
				input.principalId,
				input.grantId,
				input.roleKey,
				input.permissions === null ? null : JSON.stringify(input.permissions),
				input.scopeType,
				input.scopeValue,
				input.grantExpiresAt,
				input.requestedBy,
				input.requestedAt,
				input.expiresAt,
			],
		}], audit(id))
		if (created === undefined) throw new Error('a grant request insert returned no row')
		return created
	}

	async get(id: string): Promise<GrantRequestRow | null> {
		return await this.db.prepare('SELECT * FROM grant_requests WHERE id = ?').bind(id).first<GrantRequestRow>()
	}

	/** Every request still open at `now`, the oldest first. */
	async listOpen(now: number): Promise<GrantRequestRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM grant_requests WHERE status = 'pending' AND expires_at > ? ORDER BY requested_at, id`)
			.bind(now)
			.all<GrantRequestRow>()
		return results
	}

	/** Reject an open request; null when it was decided or lapsed meanwhile. */
	async reject(id: string, decidedBy: string, now: number, audit: AuditEventInput): Promise<GrantRequestRow | null> {
		const [rejected] = await this.writer.run<GrantRequestRow>([{
			sql: `UPDATE grant_requests SET status = 'rejected', decision_id = ?, decided_by = ?, decided_at = ?
				WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING *`,
			binds: [uuidv7(), decidedBy, now, id, now],
		}], audit)
		return rejected ?? null
	}

	/** Close an approval whose change wrote nothing: a concurrent change took its place after the checks. */
	async markFailed(id: string, decisionId: string): Promise<void> {
		await this.db.prepare(`UPDATE grant_requests SET status = 'failed' WHERE id = ? AND decision_id = ?`).bind(id, decisionId).run()
	}
}
