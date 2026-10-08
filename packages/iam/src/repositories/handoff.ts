import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { unixNow } from './sql'

/** A single-use cross-host handoff code (`auth_codes`). Only its hash is stored. */
export interface AuthCodeRow {
	id: string
	code_hash: string
	app: string
	parent_session_id: string
	return_url: string
	expires_at: number
	consumed_at: number | null
	created_at: number
}

export class HandoffRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/** Origins IAM will send a browser back to for this app. Empty = the app can receive no handoff. */
	async listReturnOrigins(app: string): Promise<string[]> {
		const { results } = await this.db
			.prepare('SELECT origin FROM app_return_origins WHERE app = ? ORDER BY origin')
			.bind(app)
			.all<{ origin: string }>()
		return results.map((row) => row.origin)
	}

	/**
	 * Replace an app's registered return origins. Declarative on purpose: the caller states the whole
	 * set, so removing an origin is the same operation as adding one and a stale entry cannot survive
	 * a reconcile. Values are stored exactly as given — `normalizeOrigin` is the one place that decides
	 * what canonical means, and it runs before this.
	 *
	 * ONE batch, like `reconcileAppSchema`: a failure between the DELETE and the INSERTs would leave
	 * the app with no registered origin, which is a hard refusal on every cross-host sign-in.
	 */
	async setReturnOrigins(app: string, origins: readonly string[]): Promise<void> {
		const now = unixNow()
		const statements: SqlStatement[] = [this.db.prepare('DELETE FROM app_return_origins WHERE app = ?').bind(app)]
		for (const origin of origins) {
			statements.push(
				this.db.prepare('INSERT INTO app_return_origins (app, origin, created_at) VALUES (?, ?, ?)').bind(app, origin, now),
			)
		}
		await this.db.batch(statements)
	}

	/** Issue a single-use code. Only the hash is stored; the plaintext lives in one redirect. */
	async issueCode(input: {
		codeHash: string
		app: string
		parentSessionId: string
		returnUrl: string
		expiresAt: number
	}): Promise<string> {
		const id = uuidv7()
		await this.db
			.prepare(`INSERT INTO auth_codes (id, code_hash, app, parent_session_id, return_url, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, input.codeHash, input.app, input.parentSessionId, input.returnUrl, input.expiresAt, unixNow())
			.run()
		return id
	}

	/**
	 * Consume a code, atomically and at most once.
	 *
	 * The UPDATE is the guard, not the SELECT: a second redemption of the same code changes no rows
	 * and gets null, with no window in which two callers both believe they won. The row is read only
	 * after it has been marked, so what comes back is what this caller consumed.
	 *
	 * Returns null for unknown, expired and already-consumed alike — the caller maps those to distinct
	 * reasons by looking the code up separately, because none of them is worth a second write here.
	 */
	async consumeCode(codeHash: string, now: number): Promise<AuthCodeRow | null> {
		const marked = await this.db
			.prepare('UPDATE auth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?')
			.bind(now, codeHash, now)
			.run()
		if ((marked.meta.changes ?? 0) === 0) {
			return null
		}
		return this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').bind(codeHash).first<AuthCodeRow>()
	}

	/** Whether a code exists at all — only to tell `expired_code` from `invalid_code` after a miss. */
	async findCode(codeHash: string): Promise<AuthCodeRow | null> {
		return this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').bind(codeHash).first<AuthCodeRow>()
	}

	/** Prune spent and expired codes (cron). Returns the number removed. */
	async pruneCodes(olderThanSeconds: number): Promise<number> {
		const result = await this.db
			.prepare('DELETE FROM auth_codes WHERE expires_at < ? OR consumed_at IS NOT NULL')
			.bind(olderThanSeconds)
			.run()
		return result.meta.changes ?? 0
	}
}
