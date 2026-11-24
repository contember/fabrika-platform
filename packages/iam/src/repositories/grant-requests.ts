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
	/** The first of the requested values, or the only one; null for a global grant. */
	scope_value: string | null
	/** Every requested value (JSON array) when there are several (ADR-0085); read through `requestScopeValues`. */
	scope_values: string | null
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
	/** Sorted and distinct; null for a global grant. */
	scopeValues: string[] | null
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
		const row = await this.db.prepare('SELECT required FROM app_grant_approvals WHERE app = ?').bind(app).first<{ required: number }>()
		return row?.required === 1
	}

	/**
	 * Set whether grant changes at `app` wait, as of Control's protection `revision`. An older revision than the stored one
	 * changes nothing, so a caller that lost the environment's lease cannot undo its successor's gate. The record is written
	 * only when `required` changes.
	 */
	async setGrantsWait(
		app: string,
		required: boolean,
		revision: number,
		now: number,
		audit: AuditEventInput,
	): Promise<{ required: boolean; revision: number }> {
		const current = this.db
			.prepare(`INSERT INTO app_grant_approvals (app, required, revision, updated_at) VALUES (?, 0, ?, ?)
				ON CONFLICT (app) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
				WHERE app_grant_approvals.revision <= excluded.revision`)
			.bind(app, revision, now)
		const change = this.writer.changed([{
			sql: 'UPDATE app_grant_approvals SET required = ? WHERE app = ? AND revision = ? AND required <> ? RETURNING app',
			binds: [required ? 1 : 0, app, revision, required ? 1 : 0],
		}], audit)
		const read = this.db.prepare('SELECT required, revision FROM app_grant_approvals WHERE app = ?').bind(app)
		const results = await this.db.batch<{ required: number; revision: number }>([current, ...change.statements, read])
		const [stored] = results[results.length - 1]?.results ?? []
		if (stored === undefined) throw new Error('the grant gate row is missing after its upsert')
		return { required: stored.required === 1, revision: stored.revision }
	}

	async create(input: CreateGrantRequestInput, audit: (requestId: string) => AuditEventInput): Promise<GrantRequestRow> {
		const id = uuidv7()
		const [created] = await this.writer.run<GrantRequestRow>([{
			sql: `INSERT INTO grant_requests (id, app, kind, principal_id, grant_id, role_key, permissions, scope_type, scope_value,
					scope_values, grant_expires_at, requested_by, requested_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
			binds: [
				id,
				input.app,
				input.kind,
				input.principalId,
				input.grantId,
				input.roleKey,
				input.permissions === null ? null : JSON.stringify(input.permissions),
				input.scopeType,
				input.scopeValues?.[0] ?? null,
				input.scopeValues !== null && input.scopeValues.length > 1 ? JSON.stringify(input.scopeValues) : null,
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
}
