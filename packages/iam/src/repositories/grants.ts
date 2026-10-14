import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter, type SqlChange, type SqlDialect } from './audit'
import { unixNow } from './sql'

/** A grant written for a workload principal: its authority is its declared actions, never a grant. */
export class WorkloadGrantError extends Error {
	override readonly name = 'WorkloadGrantError'
	constructor() {
		super('a workload principal holds no grant')
	}
}

/** A grant an external principal may not hold: its authority is only roles its application declares external. */
export class ExternalGrantError extends Error {
	override readonly name = 'ExternalGrantError'
	constructor() {
		super('an external principal holds only a role its application declares external')
	}
}

/**
 * The condition every grant write carries (ADR-0051): the principal is internal, or the grant names a role of its app
 * declared external. Binds the principal id, the app and the role key; a null app or role key never matches a role, so
 * an inline, cross-app or built-in grant is refused for an external principal.
 *
 * On Postgres the role row is read `FOR SHARE`, and held to the end of the write's transaction. A reconcile deletes and
 * rewrites every role row of the app, so it waits for a grant write already holding the row, and its batch guard then
 * sees the committed grant; a grant write that comes second waits for the reconcile, and the lock's re-check of the
 * latest row version (the old row is gone) makes it write nothing. SQLite and D1 run one writer at a time.
 */
export function eligibleGrantSql(dialect: SqlDialect): string {
	const lock = dialect === 'postgres' ? ' FOR SHARE' : ''
	return `(NOT EXISTS (SELECT 1 FROM principals ep WHERE ep.id = ? AND ep.affiliation = 'external')
	OR EXISTS (SELECT 1 FROM roles er WHERE er.app = ? AND er.role_key = ? AND er.external = 1${lock}))`
}

/**
 * The first statement of every transaction that removes a grant of a principal: it moves the principal's grant revision
 * on and, on Postgres, takes the principal row first, as every writer of a principal's rows starts. An acceptance
 * writes only while its inviter's revision is the one read before its check of the inviter's live permissions
 * (`InviterCheck`), so a removal of any of its grants between the check and the write is seen.
 */
export function grantRemovalStatement(db: SqlDatabase, target: { principalId: string } | { grantId: string }): SqlStatement {
	return 'principalId' in target
		? db.prepare('UPDATE principals SET grant_revision = grant_revision + 1 WHERE id = ?').bind(target.principalId)
		: db.prepare('UPDATE principals SET grant_revision = grant_revision + 1 WHERE id = (SELECT principal_id FROM grants WHERE id = ?)')
			.bind(target.grantId)
}

export function eligibleGrantBinds(input: { principalId: string; app?: string | null; roleKey?: string | null }): (string | null)[] {
	return [input.principalId, input.app ?? null, input.roleKey ?? null]
}

export interface GrantRow {
	id: string
	principal_id: string
	/** Registered app id this grant applies to; NULL = all apps (cross-app). */
	app: string | null
	/** Named role/policy key; XOR `permissions`. Exactly one is non-null. */
	role_key: string | null
	/** Inline action-pattern set (JSON array); XOR `role_key`. Exactly one is non-null. */
	permissions: string | null
	/** Scope dimension; NULL = global (both scope columns rise/fall together). */
	scope_type: string | null
	/** Opaque, app-owned scope value; NULL = global. */
	scope_value: string | null
	granted_by: string | null
	expires_at: number | null
	created_at: number
}

export interface CreateGrantInput {
	principalId: string
	app?: string | null
	roleKey?: string | null
	permissions?: string[] | null
	scopeType?: string | null
	scopeValue?: string | null
	grantedBy?: string | null
	expiresAt?: number | null
}

export class GrantRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** Active (non-expired) grants for a principal, ALL apps (admin/effective view). */
	async getActiveGrants(principalId: string): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE principal_id = ? AND (expires_at IS NULL OR expires_at > ?)`)
			.bind(principalId, unixNow())
			.all<GrantRow>()
		return results
	}

	/**
	 * Active grants that apply to the calling `app` — the authz path. A grant counts when its `app`
	 * equals the verified calling app, and a cross-app (NULL) grant counts only when `includeCrossApp`
	 * says so: `resolvePermissionsAt` decides that, and it is true for platform audiences only.
	 */
	async getActiveGrantsForApp(principalId: string, app: string, options: { includeCrossApp: boolean }): Promise<GrantRow[]> {
		const appFilter = options.includeCrossApp ? '(app = ? OR app IS NULL)' : 'app = ?'
		// A workload principal resolves no grant on any path: its authority is its declared actions (ADR-0022).
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE principal_id = ?
					AND ${appFilter}
					AND (expires_at IS NULL OR expires_at > ?)
					AND NOT EXISTS (SELECT 1 FROM workload_principals w WHERE w.principal_id = grants.principal_id)`)
			.bind(principalId, app, unixNow())
			.all<GrantRow>()
		return results
	}

	/** Grants of `roleKey` at `app` held by an external principal. */
	async listExternalHoldersOfRole(app: string, roleKey: string): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT g.* FROM grants g JOIN principals p ON p.id = g.principal_id
				WHERE g.app = ? AND g.role_key = ? AND p.affiliation = 'external'
				ORDER BY g.id`)
			.bind(app, roleKey)
			.all<GrantRow>()
		return results
	}

	/** Grants of `roleKey` at `app` that are not in a value of `scopeType` — global ones included. */
	async listRoleGrantsOutsideScope(app: string, roleKey: string, scopeType: string): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE app = ? AND role_key = ? AND (scope_type IS NULL OR scope_type <> ?)
				ORDER BY id`)
			.bind(app, roleKey, scopeType)
			.all<GrantRow>()
		return results
	}

	/** All grants for a principal (admin view, incl. expired). */
	async listGrants(principalId: string): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM grants WHERE principal_id = ? ORDER BY created_at DESC, id DESC')
			.bind(principalId)
			.all<GrantRow>()
		return results
	}

	/**
	 * All grants for a PAGE of principals, in one statement — the api-keys list used to run one query
	 * per row over an unbounded roster (SEC-22). The page is bounded, so the `IN` list is too.
	 */
	async listGrantsFor(principalIds: readonly string[]): Promise<GrantRow[]> {
		if (principalIds.length === 0) {
			return []
		}
		const placeholders = principalIds.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(`SELECT * FROM grants WHERE principal_id IN (${placeholders}) ORDER BY created_at DESC, id DESC`)
			.bind(...principalIds)
			.all<GrantRow>()
		return results
	}

	async getGrantById(id: string): Promise<GrantRow | null> {
		return this.db.prepare('SELECT * FROM grants WHERE id = ?').bind(id).first<GrantRow>()
	}

	/**
	 * Create a grant. EITHER `roleKey` (named role/policy) OR `permissions` (an inline
	 * action-pattern set, JSON-encoded here) — the caller MUST supply exactly one; the
	 * DB CHECK rejects both/neither. `scopeType`/`scopeValue` are both-or-neither (both
	 * null = global). The handler validates which is set; this layer just persists it.
	 * `audit` is the change's record, written in the same batch. Throws `ExternalGrantError`, writing
	 * nothing, for a grant the principal may not hold (ADR-0051).
	 */
	async createGrant(input: CreateGrantInput, audit?: (grantId: string) => AuditEventInput): Promise<GrantRow> {
		await this.refuseWorkload(input.principalId)
		const id = uuidv7()
		const [created] = await this.writer.run<GrantRow>([this.grantChange(id, input, '')], audit?.(id))
		if (created === undefined) {
			// The insert carries the eligibility condition, so the only way it writes nothing is an ineligible grant.
			throw new ExternalGrantError()
		}
		return created
	}

	/** Whether `principalId` may hold this grant: it is internal, or the role is one its app declares external. */
	async isEligibleGrant(input: { principalId: string; app?: string | null; roleKey?: string | null }): Promise<boolean> {
		return (await this.db.prepare(`SELECT 1 AS eligible WHERE ${eligibleGrantSql('sqlite')}`).bind(...eligibleGrantBinds(input)).first()) !== null
	}

	/** Whether `principalId` is a job's, a webhook's or a connector's principal, which holds no grant. */
	async isWorkloadPrincipal(principalId: string): Promise<boolean> {
		return (await this.db.prepare('SELECT principal_id FROM workload_principals WHERE principal_id = ?').bind(principalId).first()) !== null
	}

	/** A principal is a workload from the batch that creates it, so this check cannot race a later change. */
	private async refuseWorkload(principalId: string): Promise<void> {
		if (await this.isWorkloadPrincipal(principalId)) {
			throw new WorkloadGrantError()
		}
	}

	/**
	 * Create a ROLE grant, or answer null when the principal already holds it. The conflict target is
	 * the one unique index this grant falls under (`idx_grants_uq_scoped` / `idx_grants_uq_global`), so
	 * the statement itself decides on both engines and any other failure still throws. A grant the
	 * principal may not hold writes nothing and throws `ExternalGrantError` (ADR-0051).
	 */
	async createRoleGrantUnlessHeld(
		input: CreateGrantInput & { roleKey: string; permissions?: null },
		audit?: (grantId: string) => AuditEventInput,
	): Promise<GrantRow | null> {
		await this.refuseWorkload(input.principalId)
		const target = input.scopeValue == null
			? `(principal_id, role_key, COALESCE(app, '*')) WHERE role_key IS NOT NULL AND scope_value IS NULL`
			: `(principal_id, role_key, scope_type, scope_value, COALESCE(app, '*')) WHERE role_key IS NOT NULL AND scope_value IS NOT NULL`
		const id = uuidv7()
		const [created] = await this.writer.run<GrantRow>([this.grantChange(id, input, `ON CONFLICT ${target} DO NOTHING`)], audit?.(id))
		if (created === undefined && !(await this.isEligibleGrant(input))) {
			throw new ExternalGrantError()
		}
		return created ?? null
	}

	/** The INSERT of one grant with a caller-generated id, for a batch that also writes its principal and record. */
	grantStatement(id: string, input: CreateGrantInput, onConflict: string = ''): SqlStatement {
		const insert = this.grantChange(id, input, onConflict)
		return this.db.prepare(insert.sql).bind(...insert.binds)
	}

	private grantChange(id: string, input: CreateGrantInput, onConflict: string): SqlChange {
		return {
			sql: `INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${eligibleGrantSql(this.writer.dialect)} ${onConflict} RETURNING *`,
			binds: [
				id,
				input.principalId,
				input.app ?? null,
				input.roleKey ?? null,
				input.permissions == null ? null : JSON.stringify(input.permissions),
				input.scopeType ?? null,
				input.scopeValue ?? null,
				input.grantedBy ?? null,
				input.expiresAt ?? null,
				unixNow(),
				...eligibleGrantBinds(input),
			],
		}
	}

	/** Delete a grant, after its principal's revision (`grantRemovalStatement`). `audit` is written exactly when this call deleted it. */
	async deleteGrant(id: string, audit?: AuditEventInput): Promise<boolean> {
		const removal = this.writer.changed([{ sql: 'DELETE FROM grants WHERE id = ? RETURNING id', binds: [id] }], audit)
		const results = await this.db.batch([grantRemovalStatement(this.db, { grantId: id }), ...removal.statements])
		return removal.rows(results, 1).length > 0
	}

	/** Delete all grants for a principal (revocation), after its revision (`grantRemovalStatement`). */
	async deleteGrantsForPrincipal(principalId: string): Promise<void> {
		const removal = this.db.prepare('DELETE FROM grants WHERE principal_id = ?').bind(principalId)
		await this.db.batch([grantRemovalStatement(this.db, { principalId }), removal])
	}

	/**
	 * Every grant of a principal, as a change an audited revocation groups with others. It moves no grant revision, so
	 * the group must disable the principal in the same transaction, which an acceptance sees as surely (`InviterCheck`).
	 */
	deleteGrantsForPrincipalChange(principalId: string): SqlChange {
		return { sql: 'DELETE FROM grants WHERE principal_id = ? RETURNING id', binds: [principalId] }
	}
}
