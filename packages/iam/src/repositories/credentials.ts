import type { Scope } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'

import { type AuditEventInput, auditEventStatement } from './audit'
import { unixNow } from './sql'

/** What a new credential carries: its secret's hash, its binding and its inline grants. */
export interface CreateCredentialInput {
	tokenHash: string
	label?: string | null
	principalId?: string | null
	/** The app the credential mints for. NULL = cross-app; illegal for an anonymous credential. */
	app?: string | null
	issuedBy: string
	expiresAt?: number | null
	grants: { action: string; scopeType?: string | null; scopeValue?: string | null }[]
}

/** A unified credential row (the `credentials` table). Only the secret's hash is stored. */
export interface CredentialRow {
	id: string
	token_hash: string
	label: string | null
	/** Bound principal (live perms), or NULL for an anonymous (frozen inline-grant) credential. */
	principal_id: string | null
	/**
	 * The app this credential may mint for. NULL = cross-app, which is legal ONLY for a
	 * principal-bound credential (its permissions are still resolved per app through `grants`) and is
	 * REFUSED for an anonymous one, whose frozen grants were delegation-checked against exactly one
	 * app at issue time. See `resolveCredential`.
	 */
	app: string | null
	issued_by: string | null
	expires_at: number | null
	revoked_at: number | null
	created_at: number
	/** The link mount of a share link; NULL on every other credential. */
	link_mount: string | null
	/** The dimension of the object the link is bound to, as the mount declared it at issue. */
	link_dimension: string | null
	/** JSON array of the link's containment chain (`{type, value}`, the object first). */
	link_chain: string | null
}

/** One inline grant on a credential (the `credential_grants` table). Matched by `permits`. */
export interface CredentialGrantRow {
	credential_id: string
	action: string
	scope_type: string | null
	scope_value: string | null
}

export class CredentialRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/**
	 * Insert a credential + its inline grant rows (if any) in one batch, with `audit` when given. Only the hash is
	 * stored. `principalId` null = an anonymous (frozen-grant) credential; non-null = principal-bound.
	 */
	async createCredential(input: CreateCredentialInput, audit?: (credentialId: string) => AuditEventInput): Promise<string> {
		const id = uuidv7()
		await this.db.batch([...this.credentialStatements(id, input), ...(audit === undefined ? [] : [auditEventStatement(this.db, audit(id))])])
		return id
	}

	/** The INSERTs of one credential with a caller-generated id and its inline grants, for a batch with its record. */
	credentialStatements(id: string, input: CreateCredentialInput): SqlStatement[] {
		const statements: SqlStatement[] = [
			this.db
				.prepare(`INSERT INTO credentials (id, token_hash, label, principal_id, app, issued_by, expires_at, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					id,
					input.tokenHash,
					input.label ?? null,
					input.principalId ?? null,
					input.app ?? null,
					input.issuedBy,
					input.expiresAt ?? null,
					unixNow(),
				),
		]
		for (const grant of input.grants) {
			statements.push(
				this.db
					.prepare('INSERT INTO credential_grants (credential_id, action, scope_type, scope_value) VALUES (?, ?, ?, ?)')
					.bind(id, grant.action, grant.scopeType ?? null, grant.scopeValue ?? null),
			)
		}
		return statements
	}

	/**
	 * Insert a share link and its grants only while its mount still exists with the dimension it was
	 * issued for, in one transaction. The first statement locks the mount row with the one row lock
	 * SQLite and Postgres share (D1 runs a batch serially anyway): a reconcile that is deleting the row
	 * makes this wait and then insert nothing, and one that comes later waits for this key and revokes
	 * it. Returns the id, or null when the mount is gone; `audit` is written exactly when the key is.
	 */
	async createLinkCredential(
		input: {
			tokenHash: string
			label: string
			app: string
			issuedBy: string
			expiresAt: number
			grants: { action: string; scopeType: string; scopeValue: string }[]
			link: { mount: string; chain: Scope[] }
		},
		audit?: (credentialId: string) => AuditEventInput,
	): Promise<string | null> {
		const id = uuidv7()
		const dimension = input.link.chain[0]?.type ?? ''
		const statements: SqlStatement[] = [
			this.db
				.prepare('UPDATE app_link_mounts SET max_days = max_days WHERE app = ? AND mount = ? AND dimension = ?')
				.bind(input.app, input.link.mount, dimension),
			this.db
				.prepare(
					`INSERT INTO credentials (id, token_hash, label, principal_id, app, issued_by, expires_at, created_at, link_mount, link_dimension, link_chain)
					SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM app_link_mounts WHERE app = ? AND mount = ? AND dimension = ?)
					RETURNING id`,
				)
				.bind(
					id,
					input.tokenHash,
					input.label,
					input.app,
					input.issuedBy,
					input.expiresAt,
					unixNow(),
					input.link.mount,
					dimension,
					JSON.stringify(input.link.chain),
					input.app,
					input.link.mount,
					dimension,
				),
		]
		for (const grant of input.grants) {
			statements.push(
				this.db
					.prepare(`INSERT INTO credential_grants (credential_id, action, scope_type, scope_value)
						SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ?)`)
					.bind(id, grant.action, grant.scopeType, grant.scopeValue, id),
			)
		}
		if (audit !== undefined) {
			statements.push(auditEventStatement(this.db, audit(id), { sql: 'EXISTS (SELECT 1 FROM credentials WHERE id = ?)', binds: [id] }))
		}
		const [, inserted] = await this.db.batch<{ id: string }>(statements)
		return (inserted?.results.length ?? 0) > 0 ? id : null
	}

	/**
	 * Look up a credential by the secret's hash, but ONLY while still valid (not revoked, not
	 * expired). An invalid/absent credential returns null. Single-statement so the validity check
	 * and the read can't race a concurrent revoke.
	 */
	async getActiveCredentialByHash(tokenHash: string): Promise<CredentialRow | null> {
		return this.db
			.prepare(`SELECT * FROM credentials
				WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
			.bind(tokenHash, unixNow())
			.first<CredentialRow>()
	}

	async getCredentialById(id: string): Promise<CredentialRow | null> {
		return this.db.prepare('SELECT * FROM credentials WHERE id = ?').bind(id).first<CredentialRow>()
	}

	async getCredentialGrants(credentialId: string): Promise<CredentialGrantRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM credential_grants WHERE credential_id = ?')
			.bind(credentialId)
			.all<CredentialGrantRow>()
		return results
	}

	/** Credentials for a principal (admin list / bulk revoke on disable). */
	async listCredentialsForPrincipal(principalId: string): Promise<CredentialRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM credentials WHERE principal_id = ? ORDER BY created_at DESC, id DESC')
			.bind(principalId)
			.all<CredentialRow>()
		return results
	}

	/**
	 * Anonymous credentials — the share links (no bound principal). The admin share-links list.
	 *
	 * One page at a time, keyset-ordered by the UUIDv7 id like every other admin list, and REVOKED
	 * rows are excluded unless asked for: the console's default view is "links that still work", and
	 * an installation that has been revoking links for a year should not have to scroll through them.
	 * `app` filters to one app's links — with the credential now bound to an app there is finally
	 * something to filter on (SEC-2).
	 */
	async listAnonymousCredentials(filter: { app?: string; includeRevoked?: boolean; before?: string; limit: number }): Promise<CredentialRow[]> {
		const where: string[] = ['principal_id IS NULL']
		const binds: (string | number)[] = []
		if (filter.app !== undefined) {
			where.push('app = ?')
			binds.push(filter.app)
		}
		if (filter.includeRevoked !== true) {
			where.push('revoked_at IS NULL')
		}
		if (filter.before !== undefined) {
			where.push('id < ?')
			binds.push(filter.before)
		}
		binds.push(filter.limit)
		const { results } = await this.db
			.prepare(`SELECT * FROM credentials WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
			.bind(...binds)
			.all<CredentialRow>()
		return results
	}

	/**
	 * Inline grants for a PAGE of credentials, in one statement. The admin lists used to issue one
	 * query per row, so a page cost 1+N round trips against an unbounded N (SEC-22); the page is
	 * bounded, so the `IN` list is too.
	 */
	async getCredentialGrantsFor(credentialIds: readonly string[]): Promise<CredentialGrantRow[]> {
		if (credentialIds.length === 0) {
			return []
		}
		const placeholders = credentialIds.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(`SELECT * FROM credential_grants WHERE credential_id IN (${placeholders})`)
			.bind(...credentialIds)
			.all<CredentialGrantRow>()
		return results
	}

	/**
	 * Revoke a credential by id (idempotent — already-revoked → false). `audit` is written only when this call revoked
	 * it: the row is locked first, so a concurrent revoke waits and then finds it revoked.
	 */
	async revokeCredential(id: string, audit?: AuditEventInput): Promise<boolean> {
		const revoke = this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id').bind(unixNow(), id)
		if (audit === undefined) {
			return (await revoke.all()).results.length > 0
		}
		const [, , revoked] = await this.db.batch([
			this.db.prepare('UPDATE credentials SET created_at = created_at WHERE id = ?').bind(id),
			auditEventStatement(this.db, audit, { sql: 'EXISTS (SELECT 1 FROM credentials WHERE id = ? AND revoked_at IS NULL)', binds: [id] }),
			revoke,
		])
		return (revoked?.results.length ?? 0) > 0
	}

	/** Revoke every active credential bound to a principal (key revoke / rotate). Returns the count. */
	async revokeCredentialsForPrincipal(principalId: string): Promise<number> {
		const result = await this.revokeCredentialsForPrincipalStatement(principalId).run()
		return result.meta.changes ?? 0
	}

	/** Revoke every active credential of a principal except `keep`, for a batch that also writes its record. */
	revokeCredentialsForPrincipalStatement(principalId: string, keep: readonly string[] = []): SqlStatement {
		const kept = keep.map(() => ' AND id <> ?').join('')
		return this.db
			.prepare(`UPDATE credentials SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL${kept}`)
			.bind(unixNow(), principalId, ...keep)
	}
}
