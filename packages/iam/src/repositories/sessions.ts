import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'

import { type AuditEventInput, AuditWriter, type AuthLogInput, authLogStatement, type SqlChange } from './audit'
import { unixNow } from './sql'

/** The logout row of a session: its principal comes from the session itself. */
export type LogoutLogInput = Pick<AuthLogInput, 'requestId' | 'app' | 'reason'>

/**
 * How a session's holder proved who they were. `local_dev` is the `LOCAL_DEV_LOGIN` bypass — it has a
 * value of its own so `sessionUsable` can ask whether the method is still enabled with no special case.
 * `terminal_assertion` is an application's word about who stands at an enrolled terminal (ADR-0067).
 */
export type AuthenticationMethod = 'oidc' | 'password' | 'local_dev' | 'terminal_assertion'

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
	/** NULL = an IAM session. Non-NULL = an app-bound child session (ADR-0022) that mints only for it. */
	app: string | null
	/** The IAM session this was derived from; revoking that one revokes this. NULL on an IAM session. */
	parent_session_id: string | null
	/** The terminal this login was asserted on (ADR-0067); set exactly when the method is `terminal_assertion`. */
	terminal_id: string | null
	/** The application that asserted the person on `terminal_id`; set exactly when `terminal_id` is. */
	asserted_by: string | null
}

export interface ListedSessionRow extends SessionRow {
	parent_expires_at: number | null
	parent_revoked_at: number | null
}

/** The terminal a `terminal_assertion` session was asserted on, and the application that asserted it. */
export interface SessionTerminal {
	terminalId: string
	assertedBy: string
}

/** A session row's terminal, or null for a session on none. The row CHECK sets both columns or neither. */
export function sessionTerminal(row: Pick<SessionRow, 'terminal_id' | 'asserted_by'>): SessionTerminal | null {
	return row.terminal_id === null || row.asserted_by === null ? null : { terminalId: row.terminal_id, assertedBy: row.asserted_by }
}

/** Methods with no upstream subject: the row CHECK pairs every other method with an `idp_sub`. */
const SUBJECTLESS_METHODS: readonly AuthenticationMethod[] = ['password', 'terminal_assertion']

/**
 * The validity clause over `t`, the terminal of the session or of its parent: a session on no terminal passes, and one
 * on a terminal passes while that terminal is enrolled.
 */
const TERMINAL_ENROLLED = 'AND (COALESCE(s.terminal_id, p.terminal_id) IS NULL OR (t.principal_id IS NOT NULL AND t.revoked_at IS NULL))'

export class SessionRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/**
	 * Create a session. Only the hash of the opaque cookie value is stored; returns the new id. A login passes its
	 * `auth_log` row, written in the same batch: a session nobody logged is never opened. A child session is a sign-in to
	 * its app, which the batch records as the principal's last one there (`app_sign_ins`).
	 */
	async createSession(input: {
		tokenHash: string
		principalId: string
		idpSub?: string | null
		email?: string | null
		authenticationMethod?: AuthenticationMethod
		expiresAt: number
		/** Bind this session to ONE app (ADR-0022). Omitted = an IAM session, usable for any app. */
		app?: string | null
		/** The IAM session this is derived from. Revoking that one revokes this. */
		parentSessionId?: string | null
		/** A `terminal_assertion` session's terminal and asserting application; both or neither. */
		terminal?: SessionTerminal | null
	}, log?: AuthLogInput): Promise<string> {
		const id = uuidv7()
		const authenticationMethod = input.authenticationMethod ?? 'oidc'
		if (!SUBJECTLESS_METHODS.includes(authenticationMethod) && input.idpSub == null) {
			throw new Error(`A ${authenticationMethod} session requires an IdP subject`)
		}
		const terminal = input.terminal ?? null
		if ((authenticationMethod === 'terminal_assertion') !== (terminal !== null)) {
			throw new Error('A terminal is named by exactly the terminal_assertion sessions')
		}
		const insert = this.db
			.prepare(
				`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, email, authentication_method, expires_at, created_at, app, parent_session_id,
					terminal_id, asserted_by)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				terminal?.terminalId ?? null,
				terminal?.assertedBy ?? null,
			)
		const now = unixNow()
		const signIn = input.app == null ? [] : [
			this.db
				.prepare(`INSERT INTO app_sign_ins (app, principal_id, signed_in_at) VALUES (?, ?, ?)
					ON CONFLICT (app, principal_id) DO UPDATE SET signed_in_at = excluded.signed_in_at`)
				.bind(input.app, input.principalId, now),
		]
		await this.db.batch([insert, ...signIn, ...(log === undefined ? [] : [authLogStatement(this.db, log)])])
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
	 *
	 * A session on a terminal is valid only while that terminal is enrolled, and so is a child whose parent is on one: a
	 * revoked terminal ends them at once, with no sweep (ADR-0067).
	 */
	async getActiveSessionByHash(tokenHash: string): Promise<SessionRow | null> {
		const now = unixNow()
		return this.db
			.prepare(`SELECT s.* FROM sessions s
				LEFT JOIN sessions p ON p.id = s.parent_session_id
				LEFT JOIN terminals t ON t.principal_id = COALESCE(s.terminal_id, p.terminal_id)
				WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
					AND (s.parent_session_id IS NULL OR (p.revoked_at IS NULL AND p.expires_at > ?))
					${TERMINAL_ENROLLED}`)
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
				LEFT JOIN terminals t ON t.principal_id = COALESCE(s.terminal_id, p.terminal_id)
				WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
					AND (s.parent_session_id IS NULL OR (p.revoked_at IS NULL AND p.expires_at > ?))
					${TERMINAL_ENROLLED}`)
			.bind(id, now, now)
			.first<SessionRow>()
	}

	/**
	 * Whether the IAM login `parentSessionId` holds a live session bound to `app` — whether this login already chose that
	 * application. The parent's own validity is the caller's: it reads the login it asks about first.
	 */
	async hasActiveChild(parentSessionId: string, app: string): Promise<boolean> {
		const row = await this.db
			.prepare('SELECT id FROM sessions WHERE parent_session_id = ? AND app = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1')
			.bind(parentSessionId, app, unixNow())
			.first<{ id: string }>()
		return row !== null
	}

	/**
	 * Revoke a session by the cookie's hash (logout). Idempotent — already-revoked → false. A logout passes its
	 * `auth_log` row, written in the same transaction and only for the session this call ended, with that session's
	 * principal: one statement on Postgres, `changes()` right after the revocation on SQLite (see `AuditWriter`).
	 */
	async revokeSessionByHash(tokenHash: string, log?: LogoutLogInput): Promise<boolean> {
		const now = unixNow()
		const revoke: SqlChange = {
			sql: 'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING id, principal_id, terminal_id, asserted_by',
			binds: [now, tokenHash],
		}
		if (log === undefined) {
			return (await this.writer.run([revoke], undefined)).length > 0
		}
		const values = [log.requestId, log.app, log.reason ?? null, now]
		const columns = '(request_id, app, kind, principal_id, credential_id, decision, reason, privileged, created_at, terminal_id, asserted_by)'
		if (this.writer.dialect === 'postgres') {
			const { results } = await this.db
				.prepare(`WITH changed AS (${revoke.sql}), logged AS (
					INSERT INTO auth_log ${columns} SELECT ?, ?, 'logout', principal_id, NULL, 'allow', ?, 0, ?, terminal_id, asserted_by FROM changed
				) SELECT id FROM changed`)
				.bind(...revoke.binds, ...values)
				.all()
			return results.length > 0
		}
		const [revoked] = await this.db.batch([
			this.db.prepare(revoke.sql).bind(...revoke.binds),
			this.db
				.prepare(`INSERT INTO auth_log ${columns}
					SELECT ?, ?, 'logout', principal_id, NULL, 'allow', ?, 0, ?, terminal_id, asserted_by FROM sessions
					WHERE token_hash = ? AND changes() > 0`)
				.bind(...values, tokenHash),
		])
		return (revoked?.results.length ?? 0) > 0
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
	async listSessionsForPrincipal(
		principalId: string,
		options: { before?: string; limit: number; signInsOnly?: boolean },
	): Promise<ListedSessionRow[]> {
		const where = options.before === undefined ? '' : ' AND s.id < ?'
		const bindings = options.before === undefined ? [principalId, options.limit] : [principalId, options.before, options.limit]
		const { results } = await this.db
			.prepare(`SELECT s.*, p.expires_at AS parent_expires_at, p.revoked_at AS parent_revoked_at FROM sessions s
				LEFT JOIN sessions p ON p.id = s.parent_session_id
				WHERE s.principal_id = ?${where}${options.signInsOnly ? ' AND s.parent_session_id IS NULL' : ''} ORDER BY s.id DESC LIMIT ?`)
			.bind(...bindings)
			.all<ListedSessionRow>()
		return results
	}

	async listChildren(parentIds: string[]): Promise<ListedSessionRow[]> {
		if (parentIds.length === 0) return []
		const { results } = await this.db.prepare(`SELECT s.*, p.expires_at AS parent_expires_at, p.revoked_at AS parent_revoked_at
			FROM sessions s JOIN sessions p ON p.id = s.parent_session_id
			WHERE s.parent_session_id IN (${parentIds.map(() => '?').join(', ')}) ORDER BY s.id DESC`).bind(...parentIds).all<ListedSessionRow>()
		return results
	}

	async lastAppSignIns(principalId: string): Promise<{ app: string; signed_in_at: number }[]> {
		const { results } = await this.db.prepare('SELECT app, signed_in_at FROM app_sign_ins WHERE principal_id = ?')
			.bind(principalId).all<{ app: string; signed_in_at: number }>()
		return results
	}

	/**
	 * Revoke ONE session by id. Idempotent — already-revoked → false.
	 *
	 * **Revoking an IAM session revokes every app session derived from it**, with no sweep: a child
	 * carries `parent_session_id`, and `getActiveSessionByHash`/`ById` join to the parent on every
	 * lookup, so the child stops resolving the moment the parent's `revoked_at` is set (ADR-0022).
	 */
	async revokeSessionById(id: string, audit?: AuditEventInput): Promise<boolean> {
		const revoke: SqlChange = { sql: 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id', binds: [unixNow(), id] }
		return (await this.writer.run([revoke], audit)).length > 0
	}

	/** The revocation of one session by id, for a use case that composes it into its own batch with the session's log row. */
	revokeStatement(id: string): SqlStatement {
		return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(unixNow(), id)
	}

	/** How many unrevoked sessions a principal holds — the count an operator's "revoke all" records. */
	async countUnrevokedSessions(principalId: string): Promise<number> {
		const { results } = await this.db
			.prepare('SELECT id FROM sessions WHERE principal_id = ? AND revoked_at IS NULL')
			.bind(principalId)
			.all<{ id: string }>()
		return results.length
	}

	/**
	 * Revoke every live session a principal holds. Returns how many rows this call revoked; `audit` is written only when
	 * that is at least one.
	 */
	async revokeSessionsForPrincipal(principalId: string, audit?: AuditEventInput): Promise<number> {
		const revoke: SqlChange = {
			sql: 'UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL RETURNING id',
			binds: [unixNow(), principalId],
		}
		return (await this.writer.run([revoke], audit)).length
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
