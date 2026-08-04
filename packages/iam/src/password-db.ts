import { uuidv7 } from '@fabrika/auth-core'
import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { PrincipalRow } from './db'
import type { StoredPasswordHash } from './password-crypto'

export type PasswordActionPurpose = 'enrollment' | 'reset'
export type PasswordAccountState = 'disabled' | 'pending' | 'enabled'

export interface PasswordAccountRow {
	principal_id: string
	state: PasswordAccountState
	created_at: number
	updated_at: number
}

export interface PasswordCredentialRow {
	principal_id: string
	algorithm: string
	parameters: string
	salt: string
	password_hash: string
	created_at: number
	updated_at: number
}

export interface PasswordActionTokenRow {
	id: string
	principal_id: string
	purpose: PasswordActionPurpose
	token_hash: string
	issued_by: string | null
	expires_at: number
	consumed_at: number | null
	consumption_id: string | null
	created_at: number
}

export interface PasswordLoginThrottleRow {
	login_key_hash: string
	window_started_at: number
	attempt_count: number
	blocked_until: number | null
	updated_at: number
}

export type PasswordLoginLookup =
	| { status: 'missing' }
	| { status: 'ambiguous' }
	| { status: 'found'; principal: PrincipalRow; credential: PasswordCredentialRow }

export type PasswordActionUserLookup =
	| { status: 'missing' }
	| { status: 'ambiguous' }
	| { status: 'found'; principal: PrincipalRow; account: PasswordAccountRow | null }

function unixNow(): number {
	return Math.floor(Date.now() / 1000)
}

async function firstRow<T>(statement: SqlStatement): Promise<T> {
	const row = await statement.first<T>()
	if (row === null) {
		throw new Error('expected a row from a RETURNING statement, got none')
	}
	return row
}

export class PasswordRepository {
	constructor(protected readonly db: SqlDatabase) {}

	async getAccount(principalId: string): Promise<PasswordAccountRow | null> {
		return this.db.prepare('SELECT * FROM password_accounts WHERE principal_id = ?').bind(principalId).first<PasswordAccountRow>()
	}

	/** Preserve the administrator's opt-in independently of enrollment token lifetime. */
	async enableEnrollment(principalId: string): Promise<void> {
		const now = unixNow()
		await this.db.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at)
			VALUES (?, 'pending', ?, ?)
			ON CONFLICT (principal_id) DO UPDATE SET
				state = CASE WHEN password_accounts.state = 'enabled' THEN 'enabled' ELSE 'pending' END,
				updated_at = excluded.updated_at`)
			.bind(principalId, now, now)
			.run()
	}

	async getCredential(principalId: string): Promise<PasswordCredentialRow | null> {
		return this.db.prepare('SELECT * FROM password_credentials WHERE principal_id = ?').bind(principalId).first<PasswordCredentialRow>()
	}

	/** Match login email case-insensitively, but fail closed when legacy case variants collide. */
	async lookupLogin(email: string): Promise<PasswordLoginLookup> {
		const lookup = await this.lookupActionUser(email)
		if (lookup.status !== 'found') {
			return lookup
		}
		const { principal, account } = lookup
		if (principal.disabled_at !== null || principal.activated_at === null || account?.state !== 'enabled') {
			return { status: 'missing' }
		}
		const credential = await this.getCredential(principal.id)
		return credential === null ? { status: 'missing' } : { status: 'found', principal, credential }
	}

	/** Resolve enrollment/reset/bootstrap candidates without choosing between case variants. */
	async lookupActionUser(email: string): Promise<PasswordActionUserLookup> {
		const { results } = await this.db.prepare(`SELECT * FROM principals
			WHERE type = 'user' AND LOWER(email) = LOWER(?)
			ORDER BY id
			LIMIT 2`)
			.bind(email.trim())
			.all<PrincipalRow>()
		if (results.length === 0) {
			return { status: 'missing' }
		}
		if (results.length > 1) {
			return { status: 'ambiguous' }
		}
		const principal = results[0]
		if (principal === undefined) {
			return { status: 'missing' }
		}
		return { status: 'found', principal, account: await this.getAccount(principal.id) }
	}

	/** Replace the password, activate the principal, and revoke prior password sessions atomically. */
	async upsertCredential(principalId: string, password: StoredPasswordHash): Promise<void> {
		const now = unixNow()
		await this.db.batch([
			this.db.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at)
				VALUES (?, 'enabled', ?, ?)
				ON CONFLICT (principal_id) DO UPDATE SET state = 'enabled', updated_at = excluded.updated_at`)
				.bind(principalId, now, now),
			this.db.prepare(`INSERT INTO password_credentials
				(principal_id, algorithm, parameters, salt, password_hash, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (principal_id) DO UPDATE SET
					algorithm = excluded.algorithm,
					parameters = excluded.parameters,
					salt = excluded.salt,
					password_hash = excluded.password_hash,
					updated_at = excluded.updated_at`)
				.bind(principalId, password.algorithm, password.parameters, password.salt, password.passwordHash, now, now),
			this.db.prepare(`UPDATE principals SET activated_at = COALESCE(activated_at, ?)
				WHERE id = ? AND type = 'user'`).bind(now, principalId),
			this.revokePasswordSessionsStatement(principalId, now),
		])
	}

	/** Remove password login and revoke only sessions that originated from a password. */
	async disableCredential(principalId: string): Promise<void> {
		const now = unixNow()
		await this.db.batch([
			this.db.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at)
				VALUES (?, 'disabled', ?, ?)
				ON CONFLICT (principal_id) DO UPDATE SET state = 'disabled', updated_at = excluded.updated_at`)
				.bind(principalId, now, now),
			this.db.prepare('DELETE FROM password_credentials WHERE principal_id = ?').bind(principalId),
			this.db.prepare(`UPDATE password_action_tokens SET consumed_at = ?
				WHERE principal_id = ? AND consumed_at IS NULL`).bind(now, principalId),
			this.revokePasswordSessionsStatement(principalId, now),
		])
	}

	async revokePasswordSessions(principalId: string): Promise<number> {
		const result = await this.revokePasswordSessionsStatement(principalId, unixNow()).run()
		return result.meta.changes
	}

	private revokePasswordSessionsStatement(principalId: string, now: number): SqlStatement {
		return this.db.prepare(`UPDATE sessions SET revoked_at = ?
			WHERE principal_id = ? AND authentication_method = 'password' AND revoked_at IS NULL`).bind(now, principalId)
	}

	/** Supersede active tokens for the same action, then persist only the new token hash. */
	async issueActionToken(input: {
		principalId: string
		purpose: PasswordActionPurpose
		tokenHash: string
		issuedBy?: string | null
		expiresAt: number
	}): Promise<string> {
		const id = uuidv7()
		const now = unixNow()
		try {
			await this.replaceActionToken(id, now, input)
		} catch {
			// A concurrent issuer may win the active-token unique index; retry once for last-writer-wins.
			await this.replaceActionToken(id, now, input)
		}
		return id
	}

	private async replaceActionToken(
		id: string,
		now: number,
		input: {
			principalId: string
			purpose: PasswordActionPurpose
			tokenHash: string
			issuedBy?: string | null
			expiresAt: number
		},
	): Promise<void> {
		await this.db.batch([
			this.db.prepare(`UPDATE password_action_tokens SET consumed_at = ?
				WHERE principal_id = ? AND purpose = ? AND consumed_at IS NULL`).bind(now, input.principalId, input.purpose),
			this.db.prepare(`INSERT INTO password_action_tokens
				(id, principal_id, purpose, token_hash, issued_by, expires_at, consumed_at, consumption_id, created_at)
				VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
				.bind(id, input.principalId, input.purpose, input.tokenHash, input.issuedBy ?? null, input.expiresAt, now),
		])
	}

	/** Atomically mark one valid action token used and return it; concurrent consumers lose. */
	async consumeActionToken(tokenHash: string, purpose: PasswordActionPurpose): Promise<PasswordActionTokenRow | null> {
		const now = unixNow()
		return this.db.prepare(`UPDATE password_action_tokens SET consumed_at = ?
			WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
			RETURNING *`).bind(now, tokenHash, purpose, now).first<PasswordActionTokenRow>()
	}

	/** Validate a scanner-safe GET without consuming the token. */
	async inspectActionToken(tokenHash: string, purpose: PasswordActionPurpose): Promise<PasswordActionTokenRow | null> {
		return this.db.prepare(`SELECT t.* FROM password_action_tokens t
			JOIN principals p ON p.id = t.principal_id
			JOIN password_accounts a ON a.principal_id = t.principal_id
			WHERE t.token_hash = ? AND t.purpose = ? AND t.consumed_at IS NULL AND t.expires_at > ?
				AND p.disabled_at IS NULL AND a.state <> 'disabled'`)
			.bind(tokenHash, purpose, unixNow())
			.first<PasswordActionTokenRow>()
	}

	/** Consume an action token and replace the credential as one race-safe transaction. */
	async completeAction(input: {
		tokenHash: string
		purpose: PasswordActionPurpose
		password: StoredPasswordHash
	}): Promise<{ principalId: string } | null> {
		const now = unixNow()
		const consumptionId = uuidv7()
		const results = await this.db.batch<PasswordActionTokenRow>([
			this.db.prepare(`UPDATE password_action_tokens SET consumed_at = ?, consumption_id = ?
				WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
					AND EXISTS (
						SELECT 1 FROM principals p
						JOIN password_accounts a ON a.principal_id = p.id
						WHERE p.id = password_action_tokens.principal_id
							AND p.disabled_at IS NULL AND a.state <> 'disabled'
					)
				RETURNING *`).bind(now, consumptionId, input.tokenHash, input.purpose, now),
			this.db.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at)
				SELECT principal_id, 'enabled', ?, ? FROM password_action_tokens WHERE consumption_id = ?
				ON CONFLICT (principal_id) DO UPDATE SET state = 'enabled', updated_at = excluded.updated_at`)
				.bind(now, now, consumptionId),
			this.db.prepare(`INSERT INTO password_credentials
				(principal_id, algorithm, parameters, salt, password_hash, created_at, updated_at)
				SELECT principal_id, ?, ?, ?, ?, ?, ? FROM password_action_tokens WHERE consumption_id = ?
				ON CONFLICT (principal_id) DO UPDATE SET
					algorithm = excluded.algorithm,
					parameters = excluded.parameters,
					salt = excluded.salt,
					password_hash = excluded.password_hash,
					updated_at = excluded.updated_at`)
				.bind(input.password.algorithm, input.password.parameters, input.password.salt, input.password.passwordHash, now, now, consumptionId),
			this.db.prepare(`UPDATE principals SET activated_at = COALESCE(activated_at, ?)
				WHERE id = (SELECT principal_id FROM password_action_tokens WHERE consumption_id = ?)
					AND type = 'user'`).bind(now, consumptionId),
			this.db.prepare(`UPDATE sessions SET revoked_at = ?
				WHERE principal_id = (SELECT principal_id FROM password_action_tokens WHERE consumption_id = ?)
					AND authentication_method = 'password' AND revoked_at IS NULL`).bind(now, consumptionId),
		])
		const principalId = results[0]?.results[0]?.principal_id
		return principalId === undefined ? null : { principalId }
	}

	async getLoginThrottle(loginKeyHash: string): Promise<PasswordLoginThrottleRow | null> {
		return this.db.prepare('SELECT * FROM password_login_throttles WHERE login_key_hash = ?')
			.bind(loginKeyHash)
			.first<PasswordLoginThrottleRow>()
	}

	/** Atomically record one failed login and establish a fixed-window block at the threshold. */
	async recordLoginFailure(input: {
		loginKeyHash: string
		windowSeconds: number
		maxAttempts: number
		blockSeconds: number
	}): Promise<PasswordLoginThrottleRow> {
		if (!Number.isSafeInteger(input.windowSeconds) || input.windowSeconds <= 0) {
			throw new Error('windowSeconds must be a positive integer')
		}
		if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
			throw new Error('maxAttempts must be a positive integer')
		}
		if (!Number.isSafeInteger(input.blockSeconds) || input.blockSeconds <= 0) {
			throw new Error('blockSeconds must be a positive integer')
		}
		const now = unixNow()
		const windowCutoff = now - input.windowSeconds
		return firstRow<PasswordLoginThrottleRow>(
			this.db.prepare(`INSERT INTO password_login_throttles
				(login_key_hash, window_started_at, attempt_count, blocked_until, updated_at)
				VALUES (?, ?, 1, CASE WHEN ? <= 1 THEN ? ELSE NULL END, ?)
				ON CONFLICT (login_key_hash) DO UPDATE SET
					window_started_at = CASE
						WHEN password_login_throttles.window_started_at <= ? THEN excluded.window_started_at
						ELSE password_login_throttles.window_started_at END,
					attempt_count = CASE
						WHEN password_login_throttles.blocked_until > ? THEN password_login_throttles.attempt_count
						WHEN password_login_throttles.window_started_at <= ? THEN 1
						ELSE password_login_throttles.attempt_count + 1 END,
					blocked_until = CASE
						WHEN password_login_throttles.blocked_until > ? THEN password_login_throttles.blocked_until
						WHEN password_login_throttles.window_started_at <= ? AND ? <= 1 THEN ?
						WHEN password_login_throttles.window_started_at > ? AND password_login_throttles.attempt_count + 1 >= ? THEN ?
						ELSE NULL END,
					updated_at = excluded.updated_at
				RETURNING *`)
				.bind(
					input.loginKeyHash,
					now,
					input.maxAttempts,
					now + input.blockSeconds,
					now,
					windowCutoff,
					now,
					windowCutoff,
					now,
					windowCutoff,
					input.maxAttempts,
					now + input.blockSeconds,
					windowCutoff,
					input.maxAttempts,
					now + input.blockSeconds,
				),
		)
	}

	async clearLoginFailures(loginKeyHash: string): Promise<void> {
		await this.db.prepare('DELETE FROM password_login_throttles WHERE login_key_hash = ?').bind(loginKeyHash).run()
	}

	async pruneLoginThrottles(olderThan: number): Promise<number> {
		const result = await this.db.prepare('DELETE FROM password_login_throttles WHERE updated_at < ? AND (blocked_until IS NULL OR blocked_until < ?)')
			.bind(olderThan, unixNow())
			.run()
		return result.meta.changes
	}

	async pruneActionTokens(olderThan: number): Promise<number> {
		const result = await this.db.prepare(`DELETE FROM password_action_tokens
			WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)`)
			.bind(olderThan, olderThan)
			.run()
		return result.meta.changes
	}
}
