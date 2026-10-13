import type { WorkloadKind } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlStatement } from '@fabrika/platform'

import { type AuditEventInput, auditEventStatement, AuditWriter } from './audit'
import { unixNow } from './sql'

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
	/** JSON array of the membership roles whose holders may assign this one; NULL = only an administrator. */
	assignable_by: string | null
	/** 1 when an external principal may hold this membership role (ADR-0051); 0 for every other role. */
	external: 0 | 1
	created_at: number
}

/** A scope-dimension row (the `app_scopes` table). */
export interface AppScopeRow {
	app: string
	scope_type: string
	label: string | null
	/** The dimension containing every value of this one. */
	parent_scope: string | null
	/** The membership role `createScope` grants in a new value. */
	creator_role: string | null
	members_manage: string | null
	members_list: string | null
	/** `labels`: `listMembers` shows labels to a `members.list` holder too. */
	members_directory: 'labels' | null
	/** A JSON array of the actions that look up one member (`findMember`), or null for none. */
	members_lookup: string | null
}

/** A share-link mount (the `app_link_mounts` table). `grants` is a JSON array of exact actions. */
export interface LinkMountRow {
	app: string
	mount: string
	dimension: string
	grants: string
	issued_by: string
	max_days: number
}

/** An endpoint that may spend membership authority (the `app_delegated_endpoints` table). */
export interface DelegatedEndpointRow {
	app: string
	endpoint: string
	action: string
	dimension: string
	purpose: 'members' | 'creates'
}

/**
 * How IAM names an application (the `app_presentation` table). `locale` is stored as reconciled and parsed at read
 * (`presentationFor`); NULL is "not declared".
 */
export interface AppPresentationRow {
	app: string
	locale: string | null
	display_name: string | null
}

/** An application's wording of one IAM e-mail in one language (the `app_mail_templates` table), parsed at render. */
export interface AppMailTemplateRow {
	app: string
	kind: string
	locale: string
	subject: string
	body: string
}

/** An action-catalog row (the `app_actions` table). */
export interface AppActionRow {
	app: string
	action: string
	description: string | null
}

export class AppSchemaRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

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

	/** The app's declared locale and display name, or null when it declares neither. */
	async getPresentation(app: string): Promise<AppPresentationRow | null> {
		return this.db.prepare('SELECT * FROM app_presentation WHERE app = ?').bind(app).first<AppPresentationRow>()
	}

	/** The app's template of one message in one language, or null when it declares none. */
	async getMailTemplate(app: string, kind: string, locale: string): Promise<AppMailTemplateRow | null> {
		return this.db
			.prepare('SELECT * FROM app_mail_templates WHERE app = ? AND kind = ? AND locale = ?')
			.bind(app, kind, locale)
			.first<AppMailTemplateRow>()
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
	}, audit?: AuditEventInput): Promise<RoleRow> {
		const upsert = this.db
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
			)
		const results = await this.db.batch<RoleRow>([
			this.bumpRevisionStatement(input.app),
			upsert,
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit)]),
		])
		const row = results[1]?.results[0]
		if (row === undefined) throw new Error('expected a row from a RETURNING statement, got none')
		return row
	}

	/** Delete a role. `audit` is written exactly when this call deleted it. */
	async deleteRole(app: string, roleKey: string, audit?: AuditEventInput): Promise<boolean> {
		const remove = this.writer.changed([{ sql: 'DELETE FROM roles WHERE app = ? AND role_key = ? RETURNING role_key', binds: [app, roleKey] }], audit)
		const results = await this.db.batch([this.bumpRevisionStatement(app), ...remove.statements])
		return remove.rows(results, 1).length > 0
	}

	/**
	 * The revision of the app's schema and policies (`app_schema_revisions`); 0 for an app IAM never reconciled. A check
	 * that authorizes a later write reads it FIRST, before the rows it checks, and the write requires it unchanged
	 * (`schemaRevisionSql`): a reconcile in between then makes the write change nothing.
	 */
	async getSchemaRevision(app: string): Promise<number> {
		const row = await this.db.prepare('SELECT revision FROM app_schema_revisions WHERE app = ?').bind(app).first<{ revision: number }>()
		return row?.revision ?? 0
	}

	/** The first statement of every write of the app's schema or policies: it moves the revision on, and on Postgres locks it. */
	private bumpRevisionStatement(app: string): SqlStatement {
		return this.db
			.prepare(`INSERT INTO app_schema_revisions (app, revision) VALUES (?, 1)
				ON CONFLICT (app) DO UPDATE SET revision = app_schema_revisions.revision + 1`)
			.bind(app)
	}

	/** The app's action catalog as plain strings — the validation source for patterns. */
	async listActionCatalog(app: string): Promise<string[]> {
		const { results } = await this.db
			.prepare('SELECT action FROM app_actions WHERE app = ? ORDER BY action')
			.bind(app)
			.all<{ action: string }>()
		return results.map((r) => r.action)
	}

	async getScope(app: string, scopeType: string): Promise<AppScopeRow | null> {
		return this.db.prepare('SELECT * FROM app_scopes WHERE app = ? AND scope_type = ?').bind(app, scopeType).first<AppScopeRow>()
	}

	async getLinkMount(app: string, mount: string): Promise<LinkMountRow | null> {
		return this.db.prepare('SELECT * FROM app_link_mounts WHERE app = ? AND mount = ?').bind(app, mount).first<LinkMountRow>()
	}

	async listLinkMounts(app: string): Promise<LinkMountRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM app_link_mounts WHERE app = ? ORDER BY mount').bind(app).all<LinkMountRow>()
		return results
	}

	async getDelegatedEndpoint(app: string, endpoint: string): Promise<DelegatedEndpointRow | null> {
		return this.db
			.prepare('SELECT * FROM app_delegated_endpoints WHERE app = ? AND endpoint = ?')
			.bind(app, endpoint)
			.first<DelegatedEndpointRow>()
	}

	async listDelegatedEndpoints(app: string): Promise<DelegatedEndpointRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM app_delegated_endpoints WHERE app = ? ORDER BY endpoint')
			.bind(app)
			.all<DelegatedEndpointRow>()
		return results
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
		scopes: {
			scopeType: string
			label?: string | null
			parentScope?: string | null
			creatorRole?: string | null
			members?: { manage: string; list: string } | null
			directory?: 'labels' | null
			lookups?: string[] | null
		}[]
		actions: { action: string; description?: string | null }[]
		roles: {
			roleKey: string
			name: string
			description?: string | null
			permissions: string[]
			memberScope?: string | null
			assignableBy?: string[] | null
			external?: boolean
		}[]
		/** The contract flag is part of the vocabulary: written in the same batch, so it never outlives the roles it constrains. */
		contract?: boolean
		links?: { mount: string; dimension: string; grants: string[]; issuedBy: string; maxDays: number }[]
		delegations?: { endpoint: string; action: string; dimension: string; purpose: 'members' | 'creates' }[]
		workloads?: { kind: WorkloadKind; name: string; actions: string[]; issues?: string }[]
		/** How IAM names the app; a field left out is "not declared", and both left out remove the row. */
		presentation?: { locale: string | null; displayName: string | null }
		/** The app's e-mail templates; every row of the app is replaced, and none left out removes them all. */
		mail?: { kind: string; locale: string; subject: string; text: string }[]
	}, audit?: AuditEventInput): Promise<void> {
		const { app } = input
		const statements: SqlStatement[] = [
			this.bumpRevisionStatement(app),
			this.db.prepare('DELETE FROM app_scopes WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_actions WHERE app = ?').bind(app),
			this.db.prepare(`DELETE FROM roles WHERE app = ? AND origin = 'app'`).bind(app),
			this.db.prepare('DELETE FROM contract_apps WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_link_mounts WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_delegated_endpoints WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_workloads WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_presentation WHERE app = ?').bind(app),
			this.db.prepare('DELETE FROM app_mail_templates WHERE app = ?').bind(app),
		]
		for (const template of input.mail ?? []) {
			statements.push(
				this.db
					.prepare('INSERT INTO app_mail_templates (app, kind, locale, subject, body) VALUES (?, ?, ?, ?, ?)')
					.bind(app, template.kind, template.locale, template.subject, template.text),
			)
		}
		const presentation = input.presentation
		if (presentation !== undefined && (presentation.locale !== null || presentation.displayName !== null)) {
			statements.push(
				this.db
					.prepare('INSERT INTO app_presentation (app, locale, display_name) VALUES (?, ?, ?)')
					.bind(app, presentation.locale, presentation.displayName),
			)
		}
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
					.prepare(
						`INSERT INTO app_scopes (app, scope_type, label, parent_scope, creator_role, members_manage, members_list, members_directory, members_lookup)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (app, scope_type) DO UPDATE SET
							label = excluded.label,
							parent_scope = excluded.parent_scope,
							creator_role = excluded.creator_role,
							members_manage = excluded.members_manage,
							members_list = excluded.members_list,
							members_directory = excluded.members_directory,
							members_lookup = excluded.members_lookup`,
					)
					.bind(
						app,
						scope.scopeType,
						scope.label ?? null,
						scope.parentScope ?? null,
						scope.creatorRole ?? null,
						scope.members?.manage ?? null,
						scope.members?.list ?? null,
						scope.directory ?? null,
						scope.lookups == null || scope.lookups.length === 0 ? null : JSON.stringify(scope.lookups),
					),
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
					.prepare(`INSERT INTO roles (app, role_key, name, description, permissions, origin, member_scope, assignable_by, external, created_at)
						VALUES (?, ?, ?, ?, ?, 'app', ?, ?, ?, ?)
						ON CONFLICT (app, role_key) DO UPDATE SET
							name = excluded.name,
							description = excluded.description,
							permissions = excluded.permissions,
							member_scope = excluded.member_scope,
							assignable_by = excluded.assignable_by,
							external = excluded.external,
							origin = 'app'
						WHERE roles.origin = 'app'`)
					.bind(
						app,
						role.roleKey,
						role.name,
						role.description ?? null,
						JSON.stringify(role.permissions),
						role.memberScope ?? null,
						role.assignableBy == null ? null : JSON.stringify(role.assignableBy),
						role.external === true ? 1 : 0,
						unixNow(),
					),
			)
		}
		// The caller refuses a role an external principal holds and the schema no longer declares external with a 409
		// first; this NOT NULL violation rolls the batch back if such a grant was written in between (ADR-0051).
		statements.push(
			this.db
				.prepare(`INSERT INTO contract_apps (app, created_at) SELECT ?, NULL WHERE EXISTS (
					SELECT 1 FROM grants g
					JOIN principals p ON p.id = g.principal_id
					JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
					WHERE g.app = ? AND p.affiliation = 'external' AND r.external = 0)`)
				.bind(`${app}#internal-role-of-external-principal`, app),
		)

		for (const link of input.links ?? []) {
			statements.push(
				this.db
					.prepare('INSERT INTO app_link_mounts (app, mount, dimension, grants, issued_by, max_days) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(app, link.mount, link.dimension, JSON.stringify(link.grants), link.issuedBy, link.maxDays),
			)
		}
		for (const delegation of input.delegations ?? []) {
			statements.push(
				this.db
					.prepare('INSERT INTO app_delegated_endpoints (app, endpoint, action, dimension, purpose) VALUES (?, ?, ?, ?, ?)')
					.bind(app, delegation.endpoint, delegation.action, delegation.dimension, delegation.purpose),
			)
		}
		for (const workload of input.workloads ?? []) {
			statements.push(
				this.db
					.prepare('INSERT INTO app_workloads (app, kind, name, actions, issues) VALUES (?, ?, ?, ?, ?)')
					.bind(app, workload.kind, workload.name, JSON.stringify(workload.actions), workload.issues ?? null),
			)
		}
		// A workload no longer declared keeps no key: its keys are revoked in the same transaction.
		statements.push(
			this.db
				.prepare(`UPDATE credentials SET revoked_at = ?
					WHERE revoked_at IS NULL AND principal_id IN (
						SELECT w.principal_id FROM workload_principals w
						WHERE w.app = ? AND NOT EXISTS (
							SELECT 1 FROM app_workloads a WHERE a.app = w.app AND a.kind = w.kind AND a.name = w.name))`)
				.bind(unixNow(), app),
		)
		// Removing a link mount, or moving it to another dimension, revokes its keys in the same transaction.
		statements.push(
			this.db
				.prepare(`UPDATE credentials SET revoked_at = ?
					WHERE app = ? AND link_mount IS NOT NULL AND revoked_at IS NULL AND NOT EXISTS (
						SELECT 1 FROM app_link_mounts m
						WHERE m.app = credentials.app AND m.mount = credentials.link_mount AND m.dimension = credentials.link_dimension)`)
				.bind(unixNow(), app),
		)
		// An app left with no delegated endpoint, no link mount and no dimension that lists its members calls no membership
		// operation, so it keeps no transport key.
		statements.push(
			this.db
				.prepare(`DELETE FROM membership_transport_keys
					WHERE app = ? AND NOT EXISTS (SELECT 1 FROM app_delegated_endpoints d WHERE d.app = ?)
						AND NOT EXISTS (SELECT 1 FROM app_link_mounts m WHERE m.app = ?)
						AND NOT EXISTS (SELECT 1 FROM app_scopes s WHERE s.app = ? AND s.members_list IS NOT NULL)`)
				.bind(app, app, app, app),
		)
		if (audit !== undefined) {
			statements.push(auditEventStatement(this.db, audit))
		}

		await this.db.batch(statements)
	}
}
