import { parseJsonStringArray } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlStatement } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter, type AuthLogInput, authLogStatement, type SqlChange } from './audit'
import type { LogoutLogInput } from './sessions'
import { unixNow } from './sql'

/** How long a person's session on a terminal lasts unless its profile says otherwise (ADR-0067). */
export const DEFAULT_TERMINAL_SESSION_TTL_SECONDS = 300

/** The longest session a terminal's profile may set; the `terminals.session_ttl` CHECK states the same bound. */
export const MAX_TERMINAL_SESSION_TTL_SECONDS = 3600

/** An enrolled browser (the `terminals` table), the side table of its `service` principal. */
export interface TerminalRow {
	principal_id: string
	label: string
	/** The administrator who enrolled it; null once that principal is gone. */
	enrolled_by: string | null
	/** SHA-256 of the `__Host-px_terminal` cookie value. */
	token_hash: string
	session_ttl: number
	created_at: number
	last_seen_at: number | null
	revoked_at: number | null
}

/** An application that may assert a person on a terminal, with its ceiling of action patterns. */
export interface TerminalAsserter {
	app: string
	ceiling: string[]
}

/** What a terminal is for: its name, who may assert on it and how long a session on it lasts. */
export interface TerminalProfile {
	label: string
	asserters: TerminalAsserter[]
	sessionTtl: number
}

/** One identification IAM opened for a terminal's browser (the `terminal_identifications` table). */
export interface TerminalIdentificationRow {
	id_hash: string
	terminal_id: string
	app: string
	return_url: string
	handoff_state: string
	handoff_challenge: string
	created_at: number
	expires_at: number
	consumed_at: number | null
}

interface TerminalAsserterRow {
	terminal_id: string
	app: string
	ceiling: string
}

/**
 * Terminals and their identifications (ADR-0067). A terminal is a `service` principal plus its row here; enrolment
 * composes `PrincipalRepository.createServiceStatement` with `enrolStatement` in one batch.
 */
export class TerminalRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** The INSERT of a terminal beside its service principal `principalId`, which the same batch creates first. */
	enrolStatement(input: { principalId: string; label: string; enrolledBy: string; tokenHash: string; sessionTtl: number }): SqlStatement {
		return this.db
			.prepare(`INSERT INTO terminals (principal_id, label, enrolled_by, token_hash, session_ttl, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`)
			.bind(input.principalId, input.label, input.enrolledBy, input.tokenHash, input.sessionTtl, unixNow())
	}

	/** The enrolled terminal whose cookie hashes to `tokenHash`; null when there is none or it was revoked. */
	async getActiveByTokenHash(tokenHash: string): Promise<TerminalRow | null> {
		return this.db.prepare('SELECT * FROM terminals WHERE token_hash = ? AND revoked_at IS NULL').bind(tokenHash).first<TerminalRow>()
	}

	/** A terminal by its principal id, revoked or not — the admin read. */
	async getById(terminalId: string): Promise<TerminalRow | null> {
		return this.db.prepare('SELECT * FROM terminals WHERE principal_id = ?').bind(terminalId).first<TerminalRow>()
	}

	/** One page of terminals, newest first, revoked or not. `before` is a keyset cursor over the UUIDv7 principal id. */
	async list(options: { before?: string; limit: number }): Promise<TerminalRow[]> {
		const where = options.before === undefined ? '' : ' WHERE principal_id < ?'
		const binds = options.before === undefined ? [options.limit] : [options.before, options.limit]
		const { results } = await this.db
			.prepare(`SELECT * FROM terminals${where} ORDER BY principal_id DESC LIMIT ?`)
			.bind(...binds)
			.all<TerminalRow>()
		return results
	}

	/** The applications that may assert on the terminal, each with its ceiling. A malformed ceiling reads as empty. */
	async listAsserters(terminalId: string): Promise<TerminalAsserter[]> {
		return (await this.listAssertersFor([terminalId])).get(terminalId) ?? []
	}

	/** The asserters of every terminal in `terminalIds`, in one query — the fan-out of one admin page. */
	async listAssertersFor(terminalIds: readonly string[]): Promise<Map<string, TerminalAsserter[]>> {
		const byTerminal = new Map<string, TerminalAsserter[]>()
		if (terminalIds.length === 0) {
			return byTerminal
		}
		const { results } = await this.db
			.prepare(`SELECT terminal_id, app, ceiling FROM terminal_asserters WHERE terminal_id IN (${terminalIds.map(() => '?').join(', ')})
				ORDER BY terminal_id, app`)
			.bind(...terminalIds)
			.all<TerminalAsserterRow>()
		for (const row of results) {
			const asserters = byTerminal.get(row.terminal_id) ?? []
			asserters.push(toAsserter(row))
			byTerminal.set(row.terminal_id, asserters)
		}
		return byTerminal
	}

	/** `app`'s entry on the terminal, or null when `app` may not assert there. */
	async getAsserter(terminalId: string, app: string): Promise<TerminalAsserter | null> {
		const row = await this.db
			.prepare('SELECT terminal_id, app, ceiling FROM terminal_asserters WHERE terminal_id = ? AND app = ?')
			.bind(terminalId, app)
			.first<TerminalAsserterRow>()
		return row === null ? null : toAsserter(row)
	}

	/**
	 * Replace an enrolled terminal's profile in one batch: its label (on its principal too, which audit rows name), its
	 * session TTL and its whole set of asserters. Answers false, and changes nothing, when the terminal is unknown or
	 * revoked; `audit` is written only when it changed.
	 */
	async setProfile(terminalId: string, profile: TerminalProfile, audit?: AuditEventInput): Promise<boolean> {
		const enrolled = 'SELECT 1 FROM terminals WHERE principal_id = ? AND revoked_at IS NULL'
		const update: SqlChange = {
			sql: 'UPDATE terminals SET label = ?, session_ttl = ? WHERE principal_id = ? AND revoked_at IS NULL RETURNING principal_id',
			binds: [profile.label, profile.sessionTtl, terminalId],
		}
		const change = this.writer.changed([update], audit)
		const asserters: SqlStatement[] = [
			this.db.prepare(`UPDATE principals SET label = ? WHERE id = ? AND EXISTS (${enrolled})`).bind(profile.label, terminalId, terminalId),
			this.db.prepare(`DELETE FROM terminal_asserters WHERE terminal_id = ? AND EXISTS (${enrolled})`).bind(terminalId, terminalId),
			...profile.asserters.map((asserter) =>
				this.db
					.prepare(`INSERT INTO terminal_asserters (terminal_id, app, ceiling) SELECT ?, ?, ? WHERE EXISTS (${enrolled})`)
					.bind(terminalId, asserter.app, JSON.stringify(asserter.ceiling), terminalId)
			),
		]
		const results = await this.db.batch([...change.statements, ...asserters])
		return change.rows(results).length > 0
	}

	/**
	 * Revoke a terminal and every session issued on it, in one transaction. Idempotent: answers false, and writes no
	 * `audit`, when the terminal was already revoked or is unknown. The validity join ends its sessions either way; the
	 * sessions are revoked too so an operator sees them ended.
	 */
	async revoke(terminalId: string, audit?: AuditEventInput): Promise<boolean> {
		const now = unixNow()
		const changes: SqlChange[] = [
			revokeSessionsChange(terminalId, now),
			{ sql: 'UPDATE terminals SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL RETURNING principal_id', binds: [now, terminalId] },
		]
		return (await this.writer.run(changes, audit)).length > 0
	}

	/**
	 * Revoke every live session issued on the terminal, as its sign-out does (ADR-0067 §5). Answers how many. A sign-out
	 * passes `log`: each login this call ends gets its `logout` row in the same transaction, with the login's principal,
	 * terminal and asserter, like `SessionRepository.revokeSessionByHash`. Its children end with it through the join.
	 */
	async revokeSessions(terminalId: string, log?: LogoutLogInput): Promise<number> {
		const now = unixNow()
		const revoke = revokeSessionsChange(terminalId, now)
		if (log === undefined) {
			return (await this.writer.run([revoke], undefined)).length
		}
		const values = [log.requestId, log.app, log.reason ?? null, now]
		const columns = '(request_id, app, kind, principal_id, credential_id, decision, reason, privileged, created_at, terminal_id, asserted_by)'
		const logged = "SELECT ?, ?, 'logout', principal_id, NULL, 'allow', ?, 0, ?, terminal_id, asserted_by"
		if (this.writer.dialect === 'postgres') {
			const { results } = await this.db
				.prepare(`WITH changed AS (${revoke.sql}), logged AS (
					INSERT INTO auth_log ${columns} ${logged} FROM changed WHERE parent_session_id IS NULL
				) SELECT id FROM changed`)
				.bind(...revoke.binds, ...values)
				.all()
			return results.length
		}
		// SQLite serializes writers, so the logins read here are exactly the ones the UPDATE after it ends.
		const [, revoked] = await this.db.batch([
			this.db
				.prepare(`INSERT INTO auth_log ${columns} ${logged} FROM sessions
					WHERE terminal_id = ? AND revoked_at IS NULL AND parent_session_id IS NULL`)
				.bind(...values, terminalId),
			this.db.prepare(revoke.sql).bind(...revoke.binds),
		])
		return revoked?.results.length ?? 0
	}

	// ── Identifications ───────────────────────────────────────────────────────

	/**
	 * Open an identification and record that its terminal was seen now, in one batch with `log`, the identification's
	 * `auth_log` row. Only the hash of its id is stored; the plaintext lives in one redirect.
	 */
	async createIdentification(input: {
		idHash: string
		terminalId: string
		app: string
		returnUrl: string
		handoffState: string
		handoffChallenge: string
		expiresAt: number
	}, log?: AuthLogInput): Promise<void> {
		const now = unixNow()
		await this.db.batch([
			this.db
				.prepare(`INSERT INTO terminal_identifications
					(id_hash, terminal_id, app, return_url, handoff_state, handoff_challenge, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(input.idHash, input.terminalId, input.app, input.returnUrl, input.handoffState, input.handoffChallenge, now, input.expiresAt),
			this.db.prepare('UPDATE terminals SET last_seen_at = ? WHERE principal_id = ?').bind(now, input.terminalId),
			...(log === undefined ? [] : [authLogStatement(this.db, log)]),
		])
	}

	/** An identification by its id's hash, in any state — the caller judges expiry and consumption. */
	async getIdentification(idHash: string): Promise<TerminalIdentificationRow | null> {
		return this.db.prepare('SELECT * FROM terminal_identifications WHERE id_hash = ?').bind(idHash).first<TerminalIdentificationRow>()
	}

	/**
	 * Consume an identification, atomically and at most once. The conditional UPDATE is the guard: a second consumption
	 * changes no row and answers null, as an unknown, expired or cancelled one does. The row is the one this call consumed.
	 */
	async consumeIdentification(idHash: string, now: number): Promise<TerminalIdentificationRow | null> {
		return this.db
			.prepare(`UPDATE terminal_identifications SET consumed_at = ?
				WHERE id_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`)
			.bind(now, idHash, now)
			.first<TerminalIdentificationRow>()
	}

	/** End an open identification of `app` that the person abandoned. Answers false when there was none to end. */
	async cancelIdentification(idHash: string, app: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE terminal_identifications SET consumed_at = ? WHERE id_hash = ? AND app = ? AND consumed_at IS NULL')
			.bind(unixNow(), idHash, app)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Prune expired and ended identifications (cron). Returns the number removed. */
	async pruneIdentifications(now: number): Promise<number> {
		const result = await this.db
			.prepare('DELETE FROM terminal_identifications WHERE expires_at < ? OR consumed_at IS NOT NULL')
			.bind(now)
			.run()
		return result.meta.changes ?? 0
	}
}

function revokeSessionsChange(terminalId: string, now: number): SqlChange {
	return {
		sql: `UPDATE sessions SET revoked_at = ? WHERE terminal_id = ? AND revoked_at IS NULL
			RETURNING id, principal_id, terminal_id, asserted_by, parent_session_id`,
		binds: [now, terminalId],
	}
}

function toAsserter(row: TerminalAsserterRow): TerminalAsserter {
	return { app: row.app, ceiling: parseJsonStringArray(row.ceiling) }
}
