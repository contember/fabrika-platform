import { type SqlDatabase, type SqlStatement } from '@fabrika/platform'

import { firstRow, unixNow } from './sql'

/** A role/policy bundle row (the `roles` table). `permissions` is a JSON array string. */
export interface RoleRow {
	app: string
	role_key: string
	name: string
	description: string | null
	/** JSON array of action patterns, e.g. '["project.read","report.*"]'. */
	permissions: string
	/** 'app' = reconciled from code, 'custom' = admin-composed. */
	origin: 'app' | 'custom'
	/** The scope dimension a membership role is granted in; NULL for every other role. */
	member_scope: string | null
	created_at: number
}

/** A scope-dimension row (the `app_scopes` table). */
export interface AppScopeRow {
	app: string
	scope_type: string
	label: string | null
}

/** An action-catalog row (the `app_actions` table). */
export interface AppActionRow {
	app: string
	action: string
	description: string | null
}

export class AppSchemaRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/**
	 * The set of app ids propustka knows about — the distinct `app` across the schema tables
	 * (`app_actions ∪ app_scopes ∪ roles`). An app registers itself by reconciling its vocabulary
	 * via `PUT /admin/apps/:app/schema`, so this is the live registry (no static config list).
	 */
	async listKnownApps(): Promise<string[]> {
		const { results } = await this.db
			.prepare(`SELECT app FROM app_actions
				UNION SELECT app FROM app_scopes
				UNION SELECT app FROM roles
				ORDER BY app`)
			.all<{ app: string }>()
		return results.map((r) => r.app)
	}

	/** True when the app's schema was compiled from a contract (ADR-0022 rule 6). */
	async isContractApp(app: string): Promise<boolean> {
		return (await this.db.prepare('SELECT app FROM contract_apps WHERE app = ?').bind(app).first<{ app: string }>()) !== null
	}

	// ── App-declared vocabulary (roles, scopes, actions) ──────────────────────

	/** Every role row for an app (origin='app' AND origin='custom') — for resolution + listing. */
	async listRoles(app: string): Promise<RoleRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM roles WHERE app = ? ORDER BY role_key')
			.bind(app)
			.all<RoleRow>()
		return results
	}

	/** Role rows for an app filtered by origin — used to list just the app/custom set. */
	async listRolesByOrigin(app: string, origin: 'app' | 'custom'): Promise<RoleRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM roles WHERE app = ? AND origin = ? ORDER BY role_key')
			.bind(app, origin)
			.all<RoleRow>()
		return results
	}

	async getRole(app: string, roleKey: string): Promise<RoleRow | null> {
		return this.db.prepare('SELECT * FROM roles WHERE app = ? AND role_key = ?').bind(app, roleKey).first<RoleRow>()
	}

	/**
	 * Upsert a single role. `permissions` is JSON-encoded here. ON CONFLICT keeps the
	 * row's PK (app, role_key) and overwrites the mutable columns — origin included, so
	 * a reconcile can (re)assert origin='app' on an existing key. `created_at` is left
	 * untouched on update.
	 */
	async upsertRole(input: {
		app: string
		roleKey: string
		name: string
		description?: string | null
		permissions: string[]
		origin: 'app' | 'custom'
	}): Promise<RoleRow> {
		return firstRow<RoleRow>(
			this.db
				.prepare(`INSERT INTO roles (app, role_key, name, description, permissions, origin, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (app, role_key) DO UPDATE SET
						name = excluded.name,
						description = excluded.description,
						permissions = excluded.permissions,
						origin = excluded.origin
					RETURNING *`)
				.bind(
					input.app,
					input.roleKey,
					input.name,
					input.description ?? null,
					JSON.stringify(input.permissions),
					input.origin,
					unixNow(),
				),
		)
	}

	async deleteRole(app: string, roleKey: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM roles WHERE app = ? AND role_key = ?').bind(app, roleKey).run()
		return (result.meta.changes ?? 0) > 0
	}

	/** The app's action catalog as plain strings — the validation source for patterns. */
	async listActionCatalog(app: string): Promise<string[]> {
		const { results } = await this.db
			.prepare('SELECT action FROM app_actions WHERE app = ? ORDER BY action')
			.bind(app)
			.all<{ action: string }>()
		return results.map((r) => r.action)
	}

	async listAppScopes(app: string): Promise<AppScopeRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM app_scopes WHERE app = ? ORDER BY scope_type')
			.bind(app)
			.all<AppScopeRow>()
		return results
	}

	async listAppActions(app: string): Promise<AppActionRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM app_actions WHERE app = ? ORDER BY action')
			.bind(app)
			.all<AppActionRow>()
		return results
	}

	/**
	 * Idempotent reconcile of an app's declared vocabulary in one atomic batch. Validation (patterns
	 * vs. the new action catalog, and a collision with an admin's custom policy) is the caller's job —
	 * this layer just writes the reconciled state.
	 *
	 * **Clear, then write.** The previous shape upserted the incoming rows and then deleted whatever
	 * was `NOT IN` the incoming set, which put ONE BOUND PARAMETER PER KEPT VALUE in a single
	 * statement — D1 allows 100 bound parameters per query, so an app with a hundred actions could not
	 * reconcile at all (CORR-9). Deleting the app's rows first makes every statement's width constant
	 * and the reconcile independent of catalog size. The batch is one transaction, so there is no
	 * window in which the app has no vocabulary.
	 *
	 * `origin='custom'` roles are NEVER touched: the DELETE names `origin = 'app'`, and the upsert's
	 * `WHERE roles.origin = 'app'` makes a collision with a surviving custom row a no-op instead of
	 * silently flipping an admin's policy to `origin='app'` and making it unmanageable (SEC-3). The
	 * caller refuses that collision outright; this is the second lock on the same rule.
	 */
	async reconcileAppSchema(input: {
		app: string
		scopes: { scopeType: string; label?: string | null }[]
		actions: { action: string; description?: string | null }[]
		roles: { roleKey: string; name: string; description?: string | null; permissions: string[]; memberScope?: string | null }[]
		/** The contract flag is part of the vocabulary: written in the same batch, so it never outlives the roles it constrains. */
		contract?: boolean
	}): Promise<void> {
		const { app } = input
		const statements: SqlStatement[] = [
			this.db.prepare('DELETE FROM app_scopes WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_actions WHERE app = ?').bind(app),
			this.db.prepare(`DELETE FROM roles WHERE app = ? AND origin = 'app'`).bind(app),
			this.db.prepare('DELETE FROM contract_apps WHERE app = ?').bind(app),
		]
		if (input.contract === true) {
			statements.push(this.db.prepare('INSERT INTO contract_apps (app, created_at) VALUES (?, ?)').bind(app, unixNow()))
		}
		for (const role of input.roles) {
			if (role.memberScope == null) continue
			// The caller refuses an incompatible grant with a 409 first; this NOT NULL violation rolls the
			// batch back if one was written in between, so the declaration never lands over it.
			statements.push(
				this.db
					.prepare(`INSERT INTO contract_apps (app, created_at) SELECT ?, NULL WHERE EXISTS (
						SELECT 1 FROM grants WHERE app = ? AND role_key = ? AND (scope_type IS NULL OR scope_type <> ?))`)
					.bind(`${app}#incompatible-membership-grant`, app, role.roleKey, role.memberScope),
			)
		}

		for (const scope of input.scopes) {
			statements.push(
				this.db
					.prepare(`INSERT INTO app_scopes (app, scope_type, label) VALUES (?, ?, ?)
						ON CONFLICT (app, scope_type) DO UPDATE SET label = excluded.label`)
					.bind(app, scope.scopeType, scope.label ?? null),
			)
		}

		for (const action of input.actions) {
			statements.push(
				this.db
					.prepare(`INSERT INTO app_actions (app, action, description) VALUES (?, ?, ?)
						ON CONFLICT (app, action) DO UPDATE SET description = excluded.description`)
					.bind(app, action.action, action.description ?? null),
			)
		}

		for (const role of input.roles) {
			statements.push(
				this.db
					.prepare(`INSERT INTO roles (app, role_key, name, description, permissions, origin, member_scope, created_at)
						VALUES (?, ?, ?, ?, ?, 'app', ?, ?)
						ON CONFLICT (app, role_key) DO UPDATE SET
							name = excluded.name,
							description = excluded.description,
							permissions = excluded.permissions,
							member_scope = excluded.member_scope,
							origin = 'app'
						WHERE roles.origin = 'app'`)
					.bind(app, role.roleKey, role.name, role.description ?? null, JSON.stringify(role.permissions), role.memberScope ?? null, unixNow()),
			)
		}

		await this.db.batch(statements)
	}
}
