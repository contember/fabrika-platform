import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import { type AuditEventInput, auditEventStatement, AuditWriter, type SqlChange } from './audit'

/** The installation's SCIM bearer token (`scim_tokens`, one row or none); only the hash of the secret is stored. */
export interface ScimTokenRow {
	token_id: string
	created_at: number
}

/**
 * A user principal as SCIM sees it: the principal's own columns, and what the identity provider sent when a
 * `scim_users` row links it (all null for a principal no provider ever provisioned).
 */
export interface ScimUserRecord {
	id: string
	type: 'user' | 'service'
	email: string | null
	label: string
	disabled_at: number | null
	created_at: number
	user_name: string | null
	external_id: string | null
	display_name: string | null
	given_name: string | null
	family_name: string | null
	deleted_at: number | null
	linked_at: number | null
	updated_at: number | null
}

/** What the provider sent for one user, as `scim_users` stores it. */
export interface ScimUserAttributes {
	readonly userName: string
	readonly userNameKey: string
	readonly externalId: string | null
	readonly displayName: string | null
	readonly givenName: string | null
	readonly familyName: string | null
}

const RECORD_COLUMNS = `p.id, p.type, p.email, p.label, p.disabled_at, p.created_at,
	s.user_name, s.external_id, s.display_name, s.given_name, s.family_name, s.deleted_at, s.created_at AS linked_at, s.updated_at`
const FROM = 'FROM principals p LEFT JOIN scim_users s ON s.principal_id = p.id'

/** SCIM provisioning state (ADR-0091): the installation's token and the users an identity provider manages. */
export class ScimRepository {
	constructor(
		protected readonly db: SqlDatabase,
		readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	// ── The token ──────────────────────────────────────────────────────────

	async getToken(): Promise<ScimTokenRow | null> {
		return this.db.prepare('SELECT token_id, created_at FROM scim_tokens WHERE id = 1').first<ScimTokenRow>()
	}

	/** The id of the live token whose secret hashes to `tokenHash`, or null. */
	async tokenIdOf(tokenHash: string): Promise<string | null> {
		const row = await this.db.prepare('SELECT token_id FROM scim_tokens WHERE token_hash = ?').bind(tokenHash).first<{ token_id: string }>()
		return row?.token_id ?? null
	}

	/** Replace the token (or create the first) with its record, in one batch: the previous secret stops working at once. */
	async rotateToken(input: { tokenId: string; tokenHash: string; now: number }, audit: AuditEventInput): Promise<ScimTokenRow> {
		await this.db.batch([
			this.db
				.prepare(`INSERT INTO scim_tokens (id, token_id, token_hash, created_at) VALUES (1, ?, ?, ?)
					ON CONFLICT (id) DO UPDATE SET token_id = excluded.token_id, token_hash = excluded.token_hash, created_at = excluded.created_at`)
				.bind(input.tokenId, input.tokenHash, input.now),
			auditEventStatement(this.db, audit),
		])
		return { token_id: input.tokenId, created_at: input.now }
	}

	/** Remove the token; returns whether there was one, and `audit` is written only then. */
	async revokeToken(audit: AuditEventInput): Promise<boolean> {
		return (await this.writer.run([{ sql: 'DELETE FROM scim_tokens WHERE id = 1 RETURNING token_id', binds: [] }], audit)).length > 0
	}

	// ── Users ──────────────────────────────────────────────────────────────

	async getRecord(principalId: string): Promise<ScimUserRecord | null> {
		return this.db.prepare(`SELECT ${RECORD_COLUMNS} ${FROM} WHERE p.id = ?`).bind(principalId).first<ScimUserRecord>()
	}

	/** The provisioned, not deleted user whose userName compares equal to `userNameKey`. */
	async getByUserName(userNameKey: string): Promise<ScimUserRecord | null> {
		return this.db
			.prepare(`SELECT ${RECORD_COLUMNS} ${FROM} WHERE s.user_name_key = ? AND s.deleted_at IS NULL`)
			.bind(userNameKey)
			.first<ScimUserRecord>()
	}

	/** The provisioned, not deleted users the provider knows by `externalId` (unique in practice, not enforced). */
	async listByExternalId(externalId: string, limit: number): Promise<ScimUserRecord[]> {
		const { results } = await this.db
			.prepare(`SELECT ${RECORD_COLUMNS} ${FROM} WHERE s.external_id = ? AND s.deleted_at IS NULL ORDER BY p.id LIMIT ?`)
			.bind(externalId, limit)
			.all<ScimUserRecord>()
		return results
	}

	/** The user holding a normalized mailbox, linked or not. */
	async getByMailbox(mailbox: string): Promise<ScimUserRecord | null> {
		return this.db.prepare(`SELECT ${RECORD_COLUMNS} ${FROM} WHERE p.type = 'user' AND p.email = ?`).bind(mailbox).first<ScimUserRecord>()
	}

	/** One page of the provisioned, not deleted users in id order, and how many there are. */
	async listUsers(offset: number, limit: number): Promise<{ total: number; records: ScimUserRecord[] }> {
		const count = await this.db.prepare('SELECT COUNT(*) AS n FROM scim_users WHERE deleted_at IS NULL').first<{ n: number | string }>()
		const { results } = await this.db
			.prepare(`SELECT ${RECORD_COLUMNS} ${FROM} WHERE s.deleted_at IS NULL ORDER BY p.id LIMIT ? OFFSET ?`)
			.bind(limit, offset)
			.all<ScimUserRecord>()
		return { total: Number(count?.n ?? 0), records: results }
	}

	/**
	 * Link a principal to the provider with these attributes, or update its link (clearing `deleted_at`), as a change that
	 * returns a row only when something it stores differs.
	 */
	linkChange(principalId: string, attributes: ScimUserAttributes, now: number): SqlChange {
		const values = [
			attributes.userName,
			attributes.userNameKey,
			attributes.externalId,
			attributes.displayName,
			attributes.givenName,
			attributes.familyName,
		]
		return {
			sql:
				`INSERT INTO scim_users (principal_id, user_name, user_name_key, external_id, display_name, given_name, family_name, deleted_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
				ON CONFLICT (principal_id) DO UPDATE SET user_name = excluded.user_name, user_name_key = excluded.user_name_key,
					external_id = excluded.external_id, display_name = excluded.display_name, given_name = excluded.given_name,
					family_name = excluded.family_name, deleted_at = NULL, updated_at = excluded.updated_at
				WHERE scim_users.user_name IS DISTINCT FROM excluded.user_name OR scim_users.external_id IS DISTINCT FROM excluded.external_id
					OR scim_users.display_name IS DISTINCT FROM excluded.display_name OR scim_users.given_name IS DISTINCT FROM excluded.given_name
					OR scim_users.family_name IS DISTINCT FROM excluded.family_name OR scim_users.deleted_at IS NOT NULL
				RETURNING principal_id`,
			binds: [principalId, ...values, now, now],
		}
	}

	/** Create a provisioned principal (`principal`, its INSERT and mailbox reservation), its link and its record, in one batch. */
	async provision(principal: SqlStatement[], principalId: string, attributes: ScimUserAttributes, now: number, audit: AuditEventInput): Promise<void> {
		await this.db.batch([...principal, this.linkStatement(principalId, attributes, now), auditEventStatement(this.db, audit)])
	}

	/** The link's INSERT for a principal created in the same batch. */
	linkStatement(principalId: string, attributes: ScimUserAttributes, now: number): SqlStatement {
		const change = this.linkChange(principalId, attributes, now)
		return this.db.prepare(change.sql).bind(...change.binds)
	}

	/** Mark a link deleted: the provider no longer finds the user. */
	deleteChange(principalId: string, now: number): SqlChange {
		return {
			sql: 'UPDATE scim_users SET deleted_at = ?, updated_at = ? WHERE principal_id = ? AND deleted_at IS NULL RETURNING principal_id',
			binds: [now, now, principalId],
		}
	}
}
