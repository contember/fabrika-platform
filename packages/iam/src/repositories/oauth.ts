import type { SqlDatabase } from '@fabrika/platform'
import { type AuditEventInput, auditEventStatement, AuditWriter } from './audit'

export interface OAuthGrantRow {
	id: string
	principal_id: string
	session_id: string
	client_id: string
	app: string
	resource: string
	/** JSON array of the consented scope names. */
	scopes: string
	created_at: number
	expires_at: number
	revoked_at: number | null
}

export interface OAuthCodeRow {
	token_hash: string
	grant_id: string
	redirect_uri: string
	challenge: string
	expires_at: number
	used_at: number | null
}

export interface OAuthRefreshTokenRow {
	token_hash: string
	grant_id: string
	expires_at: number
	used_at: number | null
}

/** Codes and refresh tokens are addressed by hash only; the plaintext never reaches this layer. */
export class OAuthRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** Record a consent, its one authorization code and `audit` together. */
	async createGrant(grant: OAuthGrantRow, code: Omit<OAuthCodeRow, 'grant_id' | 'used_at'>, audit?: AuditEventInput): Promise<void> {
		await this.db.batch([
			this.db.prepare(`INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at, revoked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(
				grant.id,
				grant.principal_id,
				grant.session_id,
				grant.client_id,
				grant.app,
				grant.resource,
				grant.scopes,
				grant.created_at,
				grant.expires_at,
			),
			this.db.prepare('INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, challenge, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)')
				.bind(code.token_hash, grant.id, code.redirect_uri, code.challenge, code.expires_at),
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit)]),
		])
	}

	grant(id: string): Promise<OAuthGrantRow | null> {
		return this.db.prepare('SELECT * FROM oauth_grants WHERE id = ?').bind(id).first<OAuthGrantRow>()
	}

	/** Revoke a grant; `audit` is written exactly when this call revoked it. */
	async revokeGrant(id: string, now: number, audit?: AuditEventInput): Promise<void> {
		await this.writer.run([{ sql: 'UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id', binds: [now, id] }], audit)
	}

	/** Spend a code. Exactly one caller gets the row back; a replay gets null and finds it via `code`. */
	consumeCode(tokenHash: string, now: number): Promise<OAuthCodeRow | null> {
		return this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING *')
			.bind(now, tokenHash).first<OAuthCodeRow>()
	}

	code(tokenHash: string): Promise<OAuthCodeRow | null> {
		return this.db.prepare('SELECT * FROM oauth_codes WHERE token_hash = ?').bind(tokenHash).first<OAuthCodeRow>()
	}

	async insertRefreshToken(row: Omit<OAuthRefreshTokenRow, 'used_at'>): Promise<void> {
		await this.db.prepare('INSERT INTO oauth_refresh_tokens (token_hash, grant_id, expires_at, used_at) VALUES (?, ?, ?, NULL)')
			.bind(row.token_hash, row.grant_id, row.expires_at).run()
	}

	/** Spend a refresh token for rotation. A second presentation gets null and finds the spent row via `refreshToken`. */
	consumeRefreshToken(tokenHash: string, now: number): Promise<OAuthRefreshTokenRow | null> {
		return this.db.prepare('UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING *')
			.bind(now, tokenHash).first<OAuthRefreshTokenRow>()
	}

	refreshToken(tokenHash: string): Promise<OAuthRefreshTokenRow | null> {
		return this.db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').bind(tokenHash).first<OAuthRefreshTokenRow>()
	}

	/** Record an accepted client assertion's `jti`. False when the client already presented it: a replay. */
	async recordClientAssertion(clientId: string, jti: string, expiresAt: number): Promise<boolean> {
		const row = await this.db.prepare(
			'INSERT INTO oauth_client_assertions (client_id, jti, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING jti',
		)
			.bind(clientId, jti, expiresAt).first<{ jti: string }>()
		return row !== null
	}

	/**
	 * Delete codes, refresh tokens and client assertion ids past expiry. Spent rows stay until then because they are what
	 * detects a replay. Grants go with their session row (`ON DELETE CASCADE`), which shares their expiry.
	 */
	async prune(now: number): Promise<void> {
		await this.db.batch([
			this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM oauth_client_assertions WHERE expires_at <= ?').bind(now),
		])
	}
}
