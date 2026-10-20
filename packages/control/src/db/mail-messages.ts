import type { SqlDatabase } from '@fabrika/platform'

/**
 * `held` waits for a person, `queued` for the dispatcher. `sent`, `failed` (not sent), `unknown` (may have left) and
 * `dropped` are final.
 */
export type MailMessageState = 'held' | 'queued' | 'sent' | 'failed' | 'unknown' | 'dropped'

export const FINAL_MAIL_MESSAGE_STATES = ['sent', 'failed', 'unknown', 'dropped'] as const satisfies readonly MailMessageState[]

const finalStates = FINAL_MAIL_MESSAGE_STATES.map((state) => `'${state}'`).join(', ')

export interface MailMessageRow {
	id: string
	/** `<app>@<env>`, or `installation:<service>` for an installation sender. */
	sender: string
	idempotency_key: string
	/** SHA-256 hex of the canonical request body. */
	fingerprint: string
	recipient_domain: string
	state: MailMessageState
	/** The rule that decided the message at acceptance; `null` when none did. */
	rule_id: string | null
	/** Who released or dropped a held message. */
	decided_by: string | null
	attempts: number
	/** Unix seconds before which a requeued message is not sent again. */
	next_attempt_at: number | null
	provider_message_id: string | null
	error_code: string | null
	/** The canonical request body; `null` once purged. The only column that carries recipient, subject or bodies. */
	content: string | null
	created_at: number
	updated_at: number
}

export interface MailMessageInput {
	id: string
	sender: string
	idempotency_key: string
	fingerprint: string
	recipient_domain: string
	state: MailMessageState
	rule_id: string | null
	content: string
}

export interface MailMessageListFilter {
	state?: MailMessageState
	sender?: string
	/** The last id of the previous page: rows older than it. */
	before?: string
	limit: number
}

export class MailMessageRepository {
	constructor(private readonly d1: SqlDatabase) {}

	/**
	 * Records a message, or finds the one its sender already recorded under the same idempotency key. `created` tells
	 * the two apart; the caller compares the found row's fingerprint.
	 */
	async insertOrFind(input: MailMessageInput, now: number): Promise<{ row: MailMessageRow; created: boolean }> {
		const inserted = await this.d1
			.prepare(
				`INSERT INTO mail_messages
					(id, sender, idempotency_key, fingerprint, recipient_domain, state, rule_id, attempts, content, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
				ON CONFLICT (sender, idempotency_key) DO NOTHING`,
			)
			.bind(
				input.id,
				input.sender,
				input.idempotency_key,
				input.fingerprint,
				input.recipient_domain,
				input.state,
				input.rule_id,
				input.content,
				now,
				now,
			)
			.run()
		const row = await this.d1
			.prepare('SELECT * FROM mail_messages WHERE sender = ? AND idempotency_key = ?')
			.bind(input.sender, input.idempotency_key)
			.first<MailMessageRow>()
		if (row === null) throw new Error('mail message vanished after its insert')
		return { row, created: inserted.meta.changes > 0 }
	}

	async get(id: string): Promise<MailMessageRow | null> {
		return await this.d1.prepare('SELECT * FROM mail_messages WHERE id = ?').bind(id).first<MailMessageRow>()
	}

	/** Newest first. `id` is UUIDv7, so `before` is a sound keyset cursor, as in `RunRepository.listRuns`. */
	async list(filter: MailMessageListFilter): Promise<MailMessageRow[]> {
		const where: string[] = []
		const binds: (string | number)[] = []
		if (filter.state !== undefined) {
			where.push('state = ?')
			binds.push(filter.state)
		}
		if (filter.sender !== undefined) {
			where.push('sender = ?')
			binds.push(filter.sender)
		}
		if (filter.before !== undefined) {
			where.push('id < ?')
			binds.push(filter.before)
		}
		binds.push(filter.limit)
		const sql = `SELECT * FROM mail_messages${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
		const { results } = await this.d1.prepare(sql).bind(...binds).all<MailMessageRow>()
		return results
	}

	/** A person releases a held message to the dispatcher. `false`: it is not held (any more). */
	async release(id: string, decidedBy: string, now: number): Promise<boolean> {
		return await this.decide(id, 'queued', decidedBy, now)
	}

	/** A person drops a held message. `false`: it is not held (any more). */
	async drop(id: string, decidedBy: string, now: number): Promise<boolean> {
		return await this.decide(id, 'dropped', decidedBy, now)
	}

	private async decide(id: string, state: 'queued' | 'dropped', decidedBy: string, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET state = ?, decided_by = ?, updated_at = ? WHERE id = ? AND state = 'held'`)
			.bind(state, decidedBy, now, id)
			.run()
		return result.meta.changes > 0
	}

	/** The provider took a queued message after `attempts` attempts. `false`: it is not queued (any more). */
	async markSent(id: string, providerMessageId: string, attempts: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = 'sent', provider_message_id = ?, attempts = ?, next_attempt_at = NULL, error_code = NULL, updated_at = ?
				WHERE id = ? AND state = 'queued'`,
			)
			.bind(providerMessageId, attempts, now, id)
			.run()
		return result.meta.changes > 0
	}

	/** A queued message ends unsent (`failed`) or perhaps sent (`unknown`). `false`: it is not queued (any more). */
	async markUndelivered(id: string, state: 'failed' | 'unknown', errorCode: string, attempts: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = ?, error_code = ?, attempts = ?, next_attempt_at = NULL, updated_at = ?
				WHERE id = ? AND state = 'queued'`,
			)
			.bind(state, errorCode, attempts, now, id)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Counts one more attempt of a queued message and defers the next to `nextAttemptAt`. Guarded on the attempts the
	 * caller read, so a redelivered job cannot count one attempt twice. `false`: the guard did not match.
	 */
	async requeue(id: string, expectedAttempts: number, nextAttemptAt: number, errorCode: string, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET attempts = attempts + 1, next_attempt_at = ?, error_code = ?, updated_at = ?
				WHERE id = ? AND state = 'queued' AND attempts = ?`,
			)
			.bind(nextAttemptAt, errorCode, now, id, expectedAttempts)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Queued messages the dispatcher may have lost: unchanged since `staleBefore`, and due at `now` (no deferred next
	 * attempt still ahead), the oldest first.
	 */
	async listDueQueued(staleBefore: number, now: number, limit: number): Promise<MailMessageRow[]> {
		const { results } = await this.d1
			.prepare(
				`SELECT * FROM mail_messages
				WHERE state = 'queued' AND updated_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
				ORDER BY id LIMIT ?`,
			)
			.bind(staleBefore, now, limit)
			.all<MailMessageRow>()
		return results
	}

	/** Forgets one final message's content. `false`: it is not final, or has no content left. */
	async purgeContent(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET content = NULL WHERE id = ? AND content IS NOT NULL AND state IN (${finalStates})`)
			.bind(id)
			.run()
		return result.meta.changes > 0
	}

	/** Forgets the content of every final message unchanged since `finalBefore`; returns how many. */
	async purgeFinalContent(finalBefore: number): Promise<number> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET content = NULL WHERE content IS NOT NULL AND updated_at <= ? AND state IN (${finalStates})`)
			.bind(finalBefore)
			.run()
		return result.meta.changes
	}
}
