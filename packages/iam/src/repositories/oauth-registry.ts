import type { OAuthClientProvider, OAuthIdentityRole } from '@fabrika/iam-contract'
import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { AppSchemaRepository, RoleRow } from './app-schema'
import { type AuditEventInput, auditEventStatement, AuditWriter, type SqlChange } from './audit'
import { unixNow } from './sql'

/** An external application (ADR-0089): an app id with no deploy target and its identity resource. */
export interface ExternalAppRow {
	app: string
	resource: string
	created_at: number
	updated_at: number
}

/** A registered OAuth client. `redirect_uris` is a JSON array; `external_app` is null for an MCP authoring client. */
export interface OAuthClientRow {
	client_id: string
	label: OAuthClientProvider
	redirect_uris: string
	metadata_url: string | null
	external_app: string | null
	created_at: number
	updated_at: number
}

/** A client as a write stores it; the caller has checked it. */
export interface OAuthClientWrite {
	clientId: string
	redirectUris: readonly string[]
	metadataUrl: string | null
}

/** An external application as `externalApps.put` replaces it: the record, its name, its roles and its clients. */
export interface ExternalAppWrite {
	app: string
	displayName: string | null
	resource: string
	/** Empty: no roles, and no vocabulary. */
	roles: readonly OAuthIdentityRole[]
	clients: readonly OAuthClientWrite[]
}

/** The records of a change: the change's own, and the one of each client whose grants it revokes. */
export interface RegistryEvents {
	change: AuditEventInput
	revocation: (clientId: string) => AuditEventInput
}

/** A client lookup: before the deploy variable's import the registry answers nothing (IAM serves `OAUTH_CONFIG`). */
export type RegistryClientLookup =
	| { imported: false }
	| { imported: true; client: OAuthClientRow | null; resource: string | null; roles: RoleRow[] }

/** An MCP authoring client as a write stores it. */
export type AuthoringClientWrite = OAuthClientWrite & { label: OAuthClientProvider }

/**
 * The OAuth client registry and the external applications it binds clients to (ADR-0089). Every change writes its record
 * in its own transaction, and an external application's vocabulary in the same one, through the schema reconcile.
 */
export class OAuthRegistryRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly writer: AuditWriter,
		private readonly appSchema: AppSchemaRepository,
	) {}

	/** Whether the deploy variable was imported; until it is, IAM serves `OAUTH_CONFIG`'s clients. */
	async imported(): Promise<boolean> {
		return (await this.db.prepare('SELECT id FROM oauth_registry WHERE id = 1').first<{ id: number }>()) !== null
	}

	/** The registry's answer for one client id, with its application's resource and roles when it is bound to one. */
	async lookupClient(clientId: string): Promise<RegistryClientLookup> {
		const row = await this.db
			.prepare(`SELECT r.id AS registry, c.client_id, c.label, c.redirect_uris, c.metadata_url, c.external_app, c.created_at, c.updated_at,
					e.resource
				FROM oauth_registry r
				LEFT JOIN oauth_clients c ON c.client_id = ?
				LEFT JOIN external_apps e ON e.app = c.external_app
				WHERE r.id = 1`)
			.bind(clientId)
			.first<{ registry: number; resource: string | null } & { [K in keyof OAuthClientRow]: OAuthClientRow[K] | null }>()
		if (row === null) return { imported: false }
		const { client_id, label, redirect_uris, created_at, updated_at } = row
		if (client_id === null || label === null || redirect_uris === null || created_at === null || updated_at === null) {
			return { imported: true, client: null, resource: null, roles: [] }
		}
		const client: OAuthClientRow = {
			client_id,
			label,
			redirect_uris,
			metadata_url: row.metadata_url,
			external_app: row.external_app,
			created_at,
			updated_at,
		}
		const roles = client.external_app === null ? [] : await this.appSchema.listRolesByOrigin(client.external_app, 'app')
		return { imported: true, client, resource: row.resource, roles }
	}

	async client(clientId: string): Promise<OAuthClientRow | null> {
		return this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first<OAuthClientRow>()
	}

	async listClients(): Promise<OAuthClientRow[]> {
		return (await this.db.prepare('SELECT * FROM oauth_clients ORDER BY client_id').all<OAuthClientRow>()).results
	}

	async clientsOf(app: string): Promise<OAuthClientRow[]> {
		return (await this.db.prepare('SELECT * FROM oauth_clients WHERE external_app = ? ORDER BY client_id').bind(app).all<OAuthClientRow>()).results
	}

	async externalApp(app: string): Promise<ExternalAppRow | null> {
		return this.db.prepare('SELECT * FROM external_apps WHERE app = ?').bind(app).first<ExternalAppRow>()
	}

	async externalAppWithResource(resource: string): Promise<ExternalAppRow | null> {
		return this.db.prepare('SELECT * FROM external_apps WHERE resource = ?').bind(resource).first<ExternalAppRow>()
	}

	async listExternalApps(): Promise<ExternalAppRow[]> {
		return (await this.db.prepare('SELECT * FROM external_apps ORDER BY app').all<ExternalAppRow>()).results
	}

	/**
	 * What IAM holds under `app` beyond what an external application's reconcile writes (roles granting no action), named
	 * by kind; empty when the id may be adopted as an external application, with every grant of its roles.
	 */
	async foreignVocabulary(app: string): Promise<string[]> {
		const { results } = await this.db
			.prepare(`SELECT 'actions' AS kind FROM app_actions WHERE app = ?
				UNION SELECT 'scopes' AS kind FROM app_scopes WHERE app = ?
				UNION SELECT 'roles granting actions' AS kind FROM roles WHERE app = ?
					AND (permissions <> '[]' OR member_scope IS NOT NULL OR assignable_by IS NOT NULL OR external <> 0 OR via IS NOT NULL)
				UNION SELECT 'a contract' AS kind FROM contract_apps WHERE app = ?
				UNION SELECT 'link mounts' AS kind FROM app_link_mounts WHERE app = ?
				UNION SELECT 'delegated endpoints' AS kind FROM app_delegated_endpoints WHERE app = ?
				UNION SELECT 'workloads' AS kind FROM app_workloads WHERE app = ?
				UNION SELECT 'people' AS kind FROM app_members WHERE app = ?
				UNION SELECT 'a terminal page' AS kind FROM app_terminals WHERE app = ?
				UNION SELECT 'e-mail templates' AS kind FROM app_mail_templates WHERE app = ?
				UNION SELECT 'return origins' AS kind FROM app_return_origins WHERE app = ?`)
			.bind(app, app, app, app, app, app, app, app, app, app, app)
			.all<{ kind: string }>()
		return results.map((row) => row.kind).sort()
	}

	/**
	 * Replace an external application: its record, its vocabulary (its roles, each granting no action, or none) and name,
	 * and its clients, with the record of the change, in one transaction. A client it no longer lists is removed and its
	 * grants revoked. A client id another writer owns rolls the whole change back.
	 */
	async putExternalApp(write: ExternalAppWrite, events: RegistryEvents): Promise<void> {
		const removed = (await this.clientsOf(write.app)).map((row) => row.client_id).filter((id) => !write.clients.some((c) => c.clientId === id))
		await this.db.batch(this.externalAppStatements(write, removed, events))
	}

	/**
	 * Remove an external application: its clients (their grants revoked), its vocabulary and name, and its record, in one
	 * transaction. The caller has found the record; the change's record is written exactly when this call removed it.
	 */
	async deleteExternalApp(app: string, events: RegistryEvents): Promise<boolean> {
		const clients = await this.clientsOf(app)
		const remove = this.writer.changed([{ sql: 'DELETE FROM external_apps WHERE app = ? RETURNING app', binds: [app] }], events.change)
		const statements = [
			...this.appSchema.reconcileStatements({ app, scopes: [], actions: [], roles: [], presentation: { locale: null, displayName: null } }),
			...clients.flatMap((client) => this.revocationStatements(client.client_id, events)),
			this.db.prepare('DELETE FROM oauth_clients WHERE external_app = ?').bind(app),
		]
		const results = await this.db.batch([...statements, ...remove.statements])
		return remove.rows(results, statements.length).length > 0
	}

	/** Write an MCP authoring client; null, writing nothing, when the id is a client of an external application. */
	async putAuthoringClient(client: AuthoringClientWrite, audit: AuditEventInput): Promise<OAuthClientRow | null> {
		const [row] = await this.writer.run<OAuthClientRow>([this.authoringClientChange(client)], audit)
		return row ?? null
	}

	/** Remove an MCP authoring client and revoke its grants; false, writing nothing, when it is no authoring client. */
	async deleteAuthoringClient(clientId: string, events: RegistryEvents): Promise<boolean> {
		const authoring = 'EXISTS (SELECT 1 FROM oauth_clients WHERE client_id = ? AND external_app IS NULL)'
		const revoke = this.writer.changed([{
			sql: `UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL AND ${authoring} RETURNING id`,
			binds: [unixNow(), clientId, clientId],
		}], events.revocation(clientId))
		const remove = this.writer.changed([{
			sql: 'DELETE FROM oauth_clients WHERE client_id = ? AND external_app IS NULL RETURNING client_id',
			binds: [clientId],
		}], events.change)
		const results = await this.db.batch([...revoke.statements, ...remove.statements])
		return remove.rows(results, revoke.statements.length).length > 0
	}

	/**
	 * The deploy variable's one import: every external application, every authoring client, their records and the mark,
	 * in one transaction. False, writing nothing, when the mark exists already, a concurrent import's included.
	 */
	async importOnce(
		apps: readonly { write: ExternalAppWrite; events: RegistryEvents }[],
		authoring: readonly { write: AuthoringClientWrite; event: AuditEventInput }[],
		audit: AuditEventInput,
	): Promise<boolean> {
		if (await this.imported()) return false
		const statements: SqlStatement[] = [
			// Plain INSERT: a concurrent import that marked first makes this one fail and roll back whole.
			this.db.prepare('INSERT INTO oauth_registry (id, imported_at) VALUES (1, ?)').bind(unixNow()),
			...apps.flatMap(({ write, events }) => this.externalAppStatements(write, [], events)),
			...authoring.flatMap(({ write, event }) => this.writer.changed([this.authoringClientChange(write)], event).statements),
			auditEventStatement(this.db, audit),
		]
		try {
			await this.db.batch(statements)
			return true
		} catch (error) {
			if (await this.imported()) return false
			throw error
		}
	}

	private externalAppStatements(write: ExternalAppWrite, removedClients: readonly string[], events: RegistryEvents): SqlStatement[] {
		const now = unixNow()
		const { app } = write
		const record = this.writer.changed([{
			sql: `INSERT INTO external_apps (app, resource, created_at, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (app) DO UPDATE SET resource = excluded.resource, updated_at = excluded.updated_at RETURNING app`,
			binds: [app, write.resource, now, now],
		}], events.change)
		const kept = write.clients.map((client) => client.clientId)
		const statements: SqlStatement[] = [
			...this.appSchema.reconcileStatements({
				app,
				scopes: [],
				actions: [],
				roles: write.roles.map((role) => ({ roleKey: role.key, name: role.name, permissions: [] })),
				presentation: { locale: null, displayName: write.displayName },
			}),
			...record.statements,
			...removedClients.flatMap((clientId) => this.revocationStatements(clientId, events)),
			kept.length === 0
				? this.db.prepare('DELETE FROM oauth_clients WHERE external_app = ?').bind(app)
				: this.db.prepare(`DELETE FROM oauth_clients WHERE external_app = ? AND client_id NOT IN (${kept.map(() => '?').join(', ')})`)
					.bind(app, ...kept),
		]
		for (const client of write.clients) {
			statements.push(
				this.db
					.prepare(`INSERT INTO oauth_clients (client_id, label, redirect_uris, metadata_url, external_app, created_at, updated_at)
						VALUES (?, 'external', ?, ?, ?, ?, ?)
						ON CONFLICT (client_id) DO UPDATE SET redirect_uris = excluded.redirect_uris, metadata_url = excluded.metadata_url,
							updated_at = excluded.updated_at
						WHERE oauth_clients.external_app = excluded.external_app`)
					.bind(client.clientId, JSON.stringify(client.redirectUris), client.metadataUrl, app, now, now),
			)
		}
		if (kept.length > 0) {
			// The caller refuses a client id another writer owns first; this NOT NULL violation rolls the change back if one
			// was written in between, so no client is left with the other writer.
			statements.push(
				this.db
					.prepare(`INSERT INTO external_apps (app, resource, created_at, updated_at) SELECT ?, NULL, 0, 0 WHERE EXISTS (
						SELECT 1 FROM oauth_clients WHERE client_id IN (${kept.map(() => '?').join(', ')})
							AND (external_app IS NULL OR external_app <> ?))`)
					.bind(`${app}#client-owned-elsewhere`, ...kept, app),
			)
		}
		return statements
	}

	/** Revoke every live grant of a client, recorded once when any was revoked. */
	private revocationStatements(clientId: string, events: RegistryEvents): SqlStatement[] {
		const revoke: SqlChange = {
			sql: 'UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL RETURNING id',
			binds: [unixNow(), clientId],
		}
		return this.writer.changed([revoke], events.revocation(clientId)).statements
	}

	private authoringClientChange(client: AuthoringClientWrite): SqlChange {
		const now = unixNow()
		return {
			sql: `INSERT INTO oauth_clients (client_id, label, redirect_uris, metadata_url, external_app, created_at, updated_at)
				VALUES (?, ?, ?, ?, NULL, ?, ?)
				ON CONFLICT (client_id) DO UPDATE SET label = excluded.label, redirect_uris = excluded.redirect_uris,
					metadata_url = excluded.metadata_url, updated_at = excluded.updated_at
				WHERE oauth_clients.external_app IS NULL
				RETURNING *`,
			binds: [client.clientId, client.label, JSON.stringify(client.redirectUris), client.metadataUrl, now, now],
		}
	}
}
