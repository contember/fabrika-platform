import { uuidv7 } from '@fabrika/auth-core'
import { type SqlDatabase } from '@fabrika/platform'

import { unixNow } from './sql'

/**
 * How a session's holder proved who they were. `local_dev` is the `LOCAL_DEV_LOGIN` bypass — it has a
 * value of its own so `sessionUsable` can ask whether the method is still enabled with no special case.
 */
export type AuthenticationMethod = 'oidc' | 'password' | 'local_dev'

/** A browser session row (the `sessions` table). Only the cookie's hash is stored, never plaintext. */
export interface SessionRow {
	id: string
	token_hash: string
	principal_id: string
	idp_sub: string | null
	email: string | null
	authentication_method: AuthenticationMethod
	created_at: number
	expires_at: number
	revoked_at: number | null
	/** NULL = an IAM session. Non-NULL = an app-bound child session (ADR-0021) that mints only for it. */
	app: string | null
	/** The IAM session this was derived from; revoking that one revokes this. NULL on an IAM session. */
	parent_session_id: string | null
}

export class SessionRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/** Create a session. Only the hash of the opaque cookie value is stored; returns the new id. */
	async createSession(input: {
		tokenHash: string
		principalId: string
		idpSub?: string | null
		email?: string | null
		authenticationMethod?: AuthenticationMethod
		expiresAt: number
		/** Bind this session to ONE app (ADR-0021). Omitted = an IAM session, usable for any app. */
		app?: string | null
		/** The IAM session this is derived from. Revoking that one revokes this. */
		parentSessionId?: string | null
	}): Promise<string> {
		const id = uuidv7()
		const authenticationMethod = input.authenticationMethod ?? 'oidc'
		// `password` is the only method with no upstream subject — the same pairing the row CHECK states.
		if (authenticationMethod !== 'password' && input.idpSub == null) {
			throw new Error(`A ${authenticationMethod} session requires an IdP subject`)
		}
		await this.db
			.prepare(
				`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, email, authentication_method, expires_at, created_at, app, parent_session_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				input.tokenHash,
				input.principalId,
				input.idpSub ?? null,
				input.email ?? null,
				authenticationMethod,
				input.expiresAt,
				unixNow(),
				input.app ?? null,
				input.parentSessionId ?? null,
			)
			.run()
		return id
	}

	/**
	 * Look up a session by the cookie's hash, but ONLY while still valid (not revoked, not expired).
	 * An invalid/absent session returns null — the caller re-authenticates. Single-statement so the
	 * validity check and the read can't race a concurrent revoke.
	 *
	 * A CHILD session is valid only while its parent is: the join is what makes "log out of IAM" reach
	 * app sessions on hosts IAM cannot set a cookie for. `ON DELETE CASCADE` does not cover this —
	 * revocation writes `revoked_at`, it does not delete the row.
	 */
	async getActiveSessionByHash(tokenHash: string): Promise<SessionRow | null> {
		const now = unixNow()
		return this.db
			.prepare(`SELECT s.* FROM sessions s
				LEFT JOIN sessions p ON p.id = s.parent_session_id
				WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
					AND (s.parent_session_id IS NULL OR (p.revoked_at IS NULL AND p.expires_at > ?))`)
			.bind(tokenHash, now, now)
			.first<SessionRow>()
	}

	/**
	 * The same validity rule as `getActiveSessionByHash`, addressed by id — how a handoff code reaches
	 * the login it was issued against, which it holds by id rather than by a hash it must not store.
	 */
	async getActiveSessionById(id: string): Promise<SessionRow | null> {
		const now = unixNow()
		return this.db
			.prepare(`SELECT s.* FROM sessions s
				LEFT JOIN sessions p ON p.id = s.parent_session_id
				WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
					AND (s.parent_session_id IS NULL OR (p.revoked_at IS NULL AND p.expires_at > ?))`)
			.bind(id, now, now)
			.first<SessionRow>()
	}

	/** Revoke a session by the cookie's hash (logout). Idempotent — already-revoked → false. */
	async revokeSessionByHash(tokenHash: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
			.bind(unixNow(), tokenHash)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/**
	 * A session row by id, VALID OR NOT — the admin read, unlike `getActiveSessionById`. An operator
	 * revoking a session must be able to address one this instance would already refuse, and be told
	 * "already revoked" rather than "no such session".
	 */
	async getSessionById(id: string): Promise<SessionRow | null> {
		return this.db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionRow>()
	}

	/**
	 * One page of a principal's sessions, newest first, valid or not. `before` is a keyset cursor over
	 * the UUIDv7 id, which is monotonic with creation — the same paging every other admin list uses.
	 */
	async listSessionsForPrincipal(principalId: string, options: { before?: string; limit: number }): Promise<SessionRow[]> {
		const where = options.before === undefined ? '' : ' AND id < ?'
		const bindings = options.before === undefined ? [principalId, options.limit] : [principalId, options.before, options.limit]
		const { results } = await this.db
			.prepare(`SELECT * FROM sessions WHERE principal_id = ?${where} ORDER BY id DESC LIMIT ?`)
			.bind(...bindings)
			.all<SessionRow>()
		return results
	}

	/**
	 * Revoke ONE session by id. Idempotent — already-revoked → false.
	 *
	 * **Revoking an IAM session revokes every app session derived from it**, with no sweep: a child
	 * carries `parent_session_id`, and `getActiveSessionByHash`/`ById` join to the parent on every
	 * lookup, so the child stops resolving the moment the parent's `revoked_at` is set (ADR-0021).
	 */
	async revokeSessionById(id: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
			.bind(unixNow(), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Revoke every live session a principal holds. Returns how many rows this call revoked. */
	async revokeSessionsForPrincipal(principalId: string): Promise<number> {
		const result = await this.db
			.prepare('UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL')
			.bind(unixNow(), principalId)
			.run()
		return result.meta.changes ?? 0
	}

	/** Prune expired or revoked sessions (cron). Returns the number removed. */
	async pruneSessions(now: number): Promise<number> {
		const result = await this.db
			.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL')
			.bind(now)
			.run()
		return result.meta.changes ?? 0
	}
}
