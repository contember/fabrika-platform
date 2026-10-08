import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { firstRow, unixNow } from './sql'

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
	constructor(protected readonly db: SqlDatabase) {}

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
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE principal_id = ?
					AND ${appFilter}
					AND (expires_at IS NULL OR expires_at > ?)`)
			.bind(principalId, app, unixNow())
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
	 */
	async createGrant(input: CreateGrantInput): Promise<GrantRow> {
		return firstRow<GrantRow>(this.insertGrant(input, ''))
	}

	/**
	 * Create a ROLE grant, or answer null when the principal already holds it. The conflict target is
	 * the one unique index this grant falls under (`idx_grants_uq_scoped` / `idx_grants_uq_global`), so
	 * the statement itself decides on both engines and any other failure still throws.
	 */
	async createRoleGrantUnlessHeld(input: CreateGrantInput & { roleKey: string; permissions?: null }): Promise<GrantRow | null> {
		const target = input.scopeValue == null
			? `(principal_id, role_key, COALESCE(app, '*')) WHERE role_key IS NOT NULL AND scope_value IS NULL`
			: `(principal_id, role_key, scope_type, scope_value, COALESCE(app, '*')) WHERE role_key IS NOT NULL AND scope_value IS NOT NULL`
		return this.insertGrant(input, `ON CONFLICT ${target} DO NOTHING`).first<GrantRow>()
	}

	private insertGrant(input: CreateGrantInput, onConflict: string): SqlStatement {
		return this.db
			.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict} RETURNING *`)
			.bind(
				uuidv7(),
				input.principalId,
				input.app ?? null,
				input.roleKey ?? null,
				input.permissions == null ? null : JSON.stringify(input.permissions),
				input.scopeType ?? null,
				input.scopeValue ?? null,
				input.grantedBy ?? null,
				input.expiresAt ?? null,
				unixNow(),
			)
	}

	async deleteGrant(id: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM grants WHERE id = ?').bind(id).run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Delete all grants for a principal (revocation). */
	async deleteGrantsForPrincipal(principalId: string): Promise<void> {
		await this.db.prepare('DELETE FROM grants WHERE principal_id = ?').bind(principalId).run()
	}
}
