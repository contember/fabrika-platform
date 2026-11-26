import type { SqlDatabase } from '@fabrika/platform'
import { parseJsonOrNull } from '../json'
import { type AuditEventInput, auditEventStatement, AuditWriter, guardedInsert, type SqlChange, type SqlGuard } from './audit'

export interface OAuthGrantRow {
	id: string
	principal_id: string
	session_id: string
	client_id: string
	app: string
	/** The grant's first resource; `resources` lists them all when it was given for several. */
	resource: string
	/** JSON array of every resource of the grant, all of `app`; null when `resource` is the only one. */
	resources: string | null
	/** JSON array of the consented scope names. */
	scopes: string
	created_at: number
	expires_at: number
	revoked_at: number | null
	/** The name the agent gave itself at the device start (ADR-0090); null for an agent that gave none and any other client. */
	agent_label: string | null
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

/** An RFC 8628 attempt. `principal_id`, `session_id` and `grant_expires_at` are set by its approval, `grant_id` by its redemption. */
export interface OAuthDeviceAuthorizationRow {
	device_code_hash: string
	user_code_hash: string
	client_id: string
	app: string
	/** JSON array of the resources the grant will cover, all of `app`. */
	resources: string
	/** JSON array of the requested scope tokens; the approval may replace them with narrower ones. */
	scopes: string
	/** The agent client's name for itself, from the request; null for none and for every other client. */
	agent_label: string | null
	interval_seconds: number
	next_poll_at: number
	created_at: number
	expires_at: number
	status: 'pending' | 'approved' | 'denied' | 'redeemed'
	principal_id: string | null
	session_id: string | null
	grant_expires_at: number | null
	grant_id: string | null
}

export type NewOAuthDeviceAuthorization = Pick<
	OAuthDeviceAuthorizationRow,
	| 'device_code_hash'
	| 'user_code_hash'
	| 'client_id'
	| 'app'
	| 'resources'
	| 'scopes'
	| 'agent_label'
	| 'interval_seconds'
	| 'created_at'
	| 'expires_at'
>

/** A poll arriving this many seconds early still counts as on time, for a client whose timer runs a little fast. */
const POLL_TOLERANCE_SECONDS = 1
/** RFC 8628 §3.5: each `slow_down` adds five seconds; this is where it stops. */
const MAX_POLL_INTERVAL_SECONDS = 60

/** Codes and refresh tokens are addressed by hash only; the plaintext never reaches this layer. */
export class OAuthRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** Record a consent, its one authorization code and `audit` together. */
	async createGrant(grant: OAuthGrantRow, code: Omit<OAuthCodeRow, 'grant_id' | 'used_at'>, audit?: AuditEventInput): Promise<void> {
		const listed = grant.resources === null ? null : parseJsonOrNull(grant.resources)
		if (listed !== null && (!Array.isArray(listed) || listed[0] !== grant.resource)) {
			throw new Error('an OAuth grant names its first resource as `resource`')
		}
		await this.db.batch([
			this.db.prepare(`INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, resources, scopes, created_at, expires_at,
				revoked_at, agent_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).bind(
				grant.id,
				grant.principal_id,
				grant.session_id,
				grant.client_id,
				grant.app,
				grant.resource,
				grant.resources,
				grant.scopes,
				grant.created_at,
				grant.expires_at,
				grant.agent_label,
			),
			this.db.prepare('INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, challenge, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)')
				.bind(code.token_hash, grant.id, code.redirect_uri, code.challenge, code.expires_at),
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit)]),
		])
	}

	grant(id: string): Promise<OAuthGrantRow | null> {
		return this.db.prepare('SELECT * FROM oauth_grants WHERE id = ?').bind(id).first<OAuthGrantRow>()
	}

	async listForPrincipal(principalId: string, before: string | undefined, limit: number): Promise<OAuthGrantRow[]> {
		const { results } = await this.db.prepare(`SELECT * FROM oauth_grants WHERE principal_id = ?${before === undefined ? '' : ' AND id < ?'}
			ORDER BY id DESC LIMIT ?`).bind(principalId, ...(before === undefined ? [] : [before]), limit).all<OAuthGrantRow>()
		return results
	}

	/**
	 * A principal's grants still in force at `now`, newest first: not revoked, not expired, and given under an IAM login
	 * not revoked. A grant ends no later than its login (`grantExpiresAt`), so the login's own expiry needs no check.
	 */
	async listLiveForPrincipal(principalId: string, now: number, limit: number): Promise<OAuthGrantRow[]> {
		const { results } = await this.db.prepare(`SELECT g.* FROM oauth_grants g JOIN sessions s ON s.id = g.session_id
			WHERE g.principal_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND s.revoked_at IS NULL
			ORDER BY g.id DESC LIMIT ?`).bind(principalId, now, limit).all<OAuthGrantRow>()
		return results
	}

	/**
	 * Revoke a grant of `principalId` only; the person's own revocation names a grant id the browser sent. True when this
	 * call revoked it, which is exactly when `audit` is written.
	 */
	async revokeOwnGrant(id: string, principalId: string, now: number, audit: AuditEventInput): Promise<boolean> {
		const changed = await this.writer.run([{
			sql: 'UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL RETURNING id',
			binds: [now, id, principalId],
		}], audit)
		return changed.length > 0
	}

	/** The revocation of every live grant of a principal, as a change an audited deprovisioning groups with others. */
	revokeGrantsForPrincipalChange(principalId: string, now: number): SqlChange {
		return { sql: 'UPDATE oauth_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL RETURNING id', binds: [now, principalId] }
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

	/** Record a device attempt. False when either code's hash is taken already, so the caller draws new codes. */
	async startDeviceAuthorization(row: NewOAuthDeviceAuthorization): Promise<boolean> {
		const inserted = await this.db.prepare(
			`INSERT INTO oauth_device_authorizations (device_code_hash, user_code_hash, client_id, app, resources, scopes, agent_label,
			interval_seconds, next_poll_at, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
			ON CONFLICT DO NOTHING RETURNING device_code_hash`,
		).bind(
			row.device_code_hash,
			row.user_code_hash,
			row.client_id,
			row.app,
			row.resources,
			row.scopes,
			row.agent_label,
			row.interval_seconds,
			row.created_at,
			row.created_at,
			row.expires_at,
		).first<{ device_code_hash: string }>()
		return inserted !== null
	}

	deviceAuthorization(deviceCodeHash: string): Promise<OAuthDeviceAuthorizationRow | null> {
		return this.db.prepare('SELECT * FROM oauth_device_authorizations WHERE device_code_hash = ?').bind(deviceCodeHash)
			.first<OAuthDeviceAuthorizationRow>()
	}

	/** The attempt a person may still decide: pending and unexpired. */
	pendingDeviceAuthorization(userCodeHash: string, now: number): Promise<OAuthDeviceAuthorizationRow | null> {
		return this.db.prepare(`SELECT * FROM oauth_device_authorizations WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`)
			.bind(userCodeHash, now).first<OAuthDeviceAuthorizationRow>()
	}

	/**
	 * Approve a pending attempt under the approver's IAM session. `scopes`, when given, replaces the requested scope tokens
	 * with the ones the person approved. False when it was decided, or expired, meanwhile.
	 */
	async approveDeviceAuthorization(
		userCodeHash: string,
		approval: { principalId: string; sessionId: string; grantExpiresAt: number; scopes?: string },
		now: number,
	): Promise<boolean> {
		const row = await this.db.prepare(
			`UPDATE oauth_device_authorizations SET status = 'approved', principal_id = ?, session_id = ?, grant_expires_at = ?,
			scopes = COALESCE(?, scopes) WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ? RETURNING device_code_hash`,
		)
			.bind(approval.principalId, approval.sessionId, approval.grantExpiresAt, approval.scopes ?? null, userCodeHash, now)
			.first<{ device_code_hash: string }>()
		return row !== null
	}

	async denyDeviceAuthorization(userCodeHash: string, now: number): Promise<boolean> {
		const row = await this.db.prepare(`UPDATE oauth_device_authorizations SET status = 'denied'
			WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ? RETURNING device_code_hash`)
			.bind(userCodeHash, now).first<{ device_code_hash: string }>()
		return row !== null
	}

	/**
	 * Admit one poll of an attempt (RFC 8628 §3.5). A poll before the interval has passed is refused and lengthens the
	 * interval by five seconds, which the client is told to add with `slow_down`.
	 */
	async admitDevicePoll(deviceCodeHash: string, now: number): Promise<boolean> {
		const admitted = await this.db.prepare(`UPDATE oauth_device_authorizations SET next_poll_at = ? + interval_seconds - ?
			WHERE device_code_hash = ? AND next_poll_at <= ? RETURNING device_code_hash`)
			.bind(now, POLL_TOLERANCE_SECONDS, deviceCodeHash, now).first<{ device_code_hash: string }>()
		if (admitted !== null) return true
		await this.db.prepare(`UPDATE oauth_device_authorizations SET
			interval_seconds = CASE WHEN interval_seconds + 5 > ? THEN ? ELSE interval_seconds + 5 END,
			next_poll_at = ? + CASE WHEN interval_seconds + 5 > ? THEN ? ELSE interval_seconds + 5 END - ?
			WHERE device_code_hash = ?`)
			.bind(
				MAX_POLL_INTERVAL_SECONDS,
				MAX_POLL_INTERVAL_SECONDS,
				now,
				MAX_POLL_INTERVAL_SECONDS,
				MAX_POLL_INTERVAL_SECONDS,
				POLL_TOLERANCE_SECONDS,
				deviceCodeHash,
			).run()
		return false
	}

	/**
	 * Spend an approved attempt for `grant`: the claim, the grant, its record and its first refresh token in one batch.
	 * Every write after the claim requires the claim this batch made (`grant_id` names this grant), so exactly one poll
	 * gives a grant, and a refused or failed claim writes nothing. Answers the claimed row, or null.
	 */
	async redeemDeviceAuthorization(
		deviceCodeHash: string,
		grant: OAuthGrantRow,
		refreshTokenHash: string,
		audit: AuditEventInput,
		now: number,
	): Promise<OAuthDeviceAuthorizationRow | null> {
		const claimed: SqlGuard = {
			sql: 'SELECT 1 FROM oauth_device_authorizations WHERE device_code_hash = ? AND grant_id = ?',
			binds: [deviceCodeHash, grant.id],
		}
		const grantInsert = guardedInsert(
			'oauth_grants (id, principal_id, session_id, client_id, app, resource, resources, scopes, created_at, expires_at, revoked_at, agent_label)',
			'?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?',
			[
				grant.id,
				grant.principal_id,
				grant.session_id,
				grant.client_id,
				grant.app,
				grant.resource,
				grant.resources,
				grant.scopes,
				grant.created_at,
				grant.expires_at,
				grant.agent_label,
			],
			claimed,
		)
		const refreshInsert = guardedInsert('oauth_refresh_tokens (token_hash, grant_id, expires_at, used_at)', '?, ?, ?, NULL', [
			refreshTokenHash,
			grant.id,
			grant.expires_at,
		], claimed)
		const [claim] = await this.db.batch<OAuthDeviceAuthorizationRow>([
			this.db.prepare(`UPDATE oauth_device_authorizations SET status = 'redeemed', grant_id = ?
				WHERE device_code_hash = ? AND status = 'approved' AND expires_at > ? RETURNING *`).bind(grant.id, deviceCodeHash, now),
			this.db.prepare(grantInsert.sql).bind(...grantInsert.binds),
			auditEventStatement(this.db, audit, claimed),
			this.db.prepare(refreshInsert.sql).bind(...refreshInsert.binds),
		])
		return claim?.results[0] ?? null
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
	 * Delete codes, refresh tokens, client assertion ids and device attempts past expiry. Spent rows stay until then because they are what
	 * detects a replay. Grants go with their session row (`ON DELETE CASCADE`), which shares their expiry.
	 */
	async prune(now: number): Promise<void> {
		await this.db.batch([
			this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM oauth_client_assertions WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM oauth_device_authorizations WHERE expires_at <= ?').bind(now),
		])
	}
}
