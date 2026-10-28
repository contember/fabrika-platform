import type { BlobStore, SqlDatabase } from '@fabrika/platform'

/**
 * `held` waits for a person, `queued` for the dispatcher, `sending` is one attempt a dispatcher claimed. `sent`,
 * `failed` (not sent), `unknown` (may have left) and `dropped` are final.
 */
export type MailMessageState = 'held' | 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped'

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
	/** Who released or dropped a held message, or requeued a final one. */
	decided_by: string | null
	/** Attempts claimed so far; the claimed attempt's number while `sending`. */
	attempts: number
	/** Unix seconds before which a deferred message is not sent again. */
	next_attempt_at: number | null
	provider_message_id: string | null
	error_code: string | null
	/**
	 * The canonical request body, when the row holds it; `null` once purged, or while `content_ref` holds it. With
	 * `content_ref`, the only columns that lead to recipient, subject or bodies.
	 */
	content: string | null
	/** The object that holds the canonical request body, when the row cannot (D1); `null` once purged, or without one. */
	content_ref: string | null
	created_at: number
	/** The last change; while `sending`, when the attempt was claimed. */
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

/** Whether the message still has its content, in its row or in its object. */
export function hasMailContent(row: Pick<MailMessageRow, 'content' | 'content_ref'>): boolean {
	return row.content !== null || row.content_ref !== null
}

const CONTENT_KEPT = '(content IS NOT NULL OR content_ref IS NOT NULL)'
/** An object written before its row is collected once it is this old and no row names it. */
export const MAIL_CONTENT_UPLOAD_GRACE_S = 60 * 60
const OBJECT_BATCH = 100

export interface MailMessageListFilter {
	state?: MailMessageState
	sender?: string
	/** The last id of the previous page: rows older than it. */
	before?: string
	limit: number
}

/**
 * The relay's messages. With `objects` (the Worker, whose D1 row holds at most 2,000,000 bytes) every message keeps
 * its content in an object its row names; without (Postgres) in the row. The object is written before its row and
 * removed before its row lets go of it, so a row never names a missing object, except one whose purge was interrupted,
 * which reads as purged. An object whose row never committed is collected by `collectUploads`.
 */
export class MailMessageRepository {
	constructor(
		private readonly d1: SqlDatabase,
		private readonly objects: BlobStore | null = null,
	) {}

	/**
	 * Records a message, or finds the one its sender already recorded under the same idempotency key. `created` tells
	 * the two apart; the caller compares the found row's fingerprint.
	 */
	async insertOrFind(input: MailMessageInput, now: number): Promise<{ row: MailMessageRow; created: boolean }> {
		if (this.objects !== null) return await this.insertWithObject(this.objects, input, now)
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
		const row = await this.find(input.sender, input.idempotency_key)
		if (row === null) throw new Error('mail message vanished after its insert')
		return { row, created: inserted.meta.changes > 0 }
	}

	private async insertWithObject(objects: BlobStore, input: MailMessageInput, now: number): Promise<{ row: MailMessageRow; created: boolean }> {
		const key = mailContentKey(input.id)
		// Recorded first, so an object whose row never commits is found by `collectUploads`, whatever stops this.
		await this.d1.prepare('INSERT INTO mail_content_uploads (message_id, object_key, created_at) VALUES (?, ?, ?)').bind(input.id, key, now).run()
		await objects.put(key, input.content)
		// A throw may follow a commit, so the object stays: `collectUploads` removes it only when no row names it.
		await this.d1.batch([
			this.d1
				.prepare(
					`INSERT INTO mail_messages
						(id, sender, idempotency_key, fingerprint, recipient_domain, state, rule_id, attempts, content, content_ref, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
					ON CONFLICT (sender, idempotency_key) DO NOTHING`,
				)
				.bind(input.id, input.sender, input.idempotency_key, input.fingerprint, input.recipient_domain, input.state, input.rule_id, key, now, now),
			// Only once the row names the object; under a conflict the upload stays, to be discarded.
			this.d1
				.prepare('DELETE FROM mail_content_uploads WHERE message_id = ? AND EXISTS (SELECT 1 FROM mail_messages WHERE id = ? AND content_ref = ?)')
				.bind(input.id, input.id, key),
		])
		const row = await this.find(input.sender, input.idempotency_key)
		if (row === null) throw new Error('mail message vanished after its insert')
		// The id is a fresh UUIDv7, so the row is this insert's exactly when it carries it.
		const created = row.id === input.id
		if (!created) await this.discardUpload(objects, input.id, key)
		return { row, created }
	}

	/** Best effort: what is left stays recorded in `mail_content_uploads`, and maintenance collects it. */
	private async discardUpload(objects: BlobStore, messageId: string, key: string): Promise<void> {
		try {
			await objects.delete(key)
			await this.d1.prepare('DELETE FROM mail_content_uploads WHERE message_id = ?').bind(messageId).run()
		} catch {
			console.warn(`mail relay: the content upload of ${messageId} is left to maintenance`)
		}
	}

	/** The canonical request body of a message; `null` once purged. */
	async content(row: Pick<MailMessageRow, 'content' | 'content_ref'>): Promise<string | null> {
		if (row.content !== null) return row.content
		if (row.content_ref === null) return null
		if (this.objects === null) throw new Error('a mail message names a content object, and this Control has no store for one')
		const object = await this.objects.get(row.content_ref)
		return object === null ? null : await object.text()
	}

	/** The message its sender recorded under the key, if any. */
	async find(sender: string, idempotencyKey: string): Promise<MailMessageRow | null> {
		return await this.d1
			.prepare('SELECT * FROM mail_messages WHERE sender = ? AND idempotency_key = ?')
			.bind(sender, idempotencyKey)
			.first<MailMessageRow>()
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

	/**
	 * A person sends a final message again: one of `states` → `queued`, its attempts spent anew. Only while its content is
	 * kept, because the dispatcher sends from it. `false`: it is in no such state, or its content is gone.
	 */
	async requeue(id: string, states: readonly ('failed' | 'unknown')[], decidedBy: string, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = 'queued', attempts = 0, next_attempt_at = NULL, decided_by = ?, updated_at = ?
				WHERE id = ? AND ${CONTENT_KEPT} AND state IN (${states.map(() => '?').join(', ')})`,
			)
			.bind(decidedBy, now, id, ...states)
			.run()
		return result.meta.changes > 0
	}

	private async decide(id: string, state: 'queued' | 'dropped', decidedBy: string, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET state = ?, decided_by = ?, updated_at = ? WHERE id = ? AND state = 'held'`)
			.bind(state, decidedBy, now, id)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Claims the next attempt of a queued, due message: `queued` → `sending`, one more attempt. Guarded on the attempts
	 * the caller read, so of two consumers exactly one claims it. `false`: another consumer did, or it is not due.
	 */
	async claim(id: string, expectedAttempts: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = 'sending', attempts = attempts + 1, updated_at = ?
				WHERE id = ? AND state = 'queued' AND attempts = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
			)
			.bind(now, id, expectedAttempts, now)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Claims one more attempt of a message whose claim is older than `claimedBefore`: the consumer that held it stopped
	 * before it recorded an outcome. `false`: another consumer settled or claimed it again.
	 */
	async reclaim(id: string, expectedAttempts: number, claimedBefore: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET attempts = attempts + 1, updated_at = ?
				WHERE id = ? AND state = 'sending' AND attempts = ? AND updated_at <= ?`,
			)
			.bind(now, id, expectedAttempts, claimedBefore)
			.run()
		return result.meta.changes > 0
	}

	/** The provider took the claimed attempt `attempt`. `false`: the claim is no longer held. */
	async markSent(id: string, providerMessageId: string, attempt: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = 'sent', provider_message_id = ?, next_attempt_at = NULL, error_code = NULL, updated_at = ?
				WHERE id = ? AND state = 'sending' AND attempts = ?`,
			)
			.bind(providerMessageId, now, id, attempt)
			.run()
		return result.meta.changes > 0
	}

	/** The claimed attempt `attempt` ends the message unsent (`failed`) or perhaps sent (`unknown`). `false`: the claim is no longer held. */
	async markUndelivered(id: string, state: 'failed' | 'unknown', errorCode: string, attempt: number, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = ?, error_code = ?, next_attempt_at = NULL, updated_at = ?
				WHERE id = ? AND state = 'sending' AND attempts = ?`,
			)
			.bind(state, errorCode, now, id, attempt)
			.run()
		return result.meta.changes > 0
	}

	/** The claimed attempt `attempt` failed and may go again: `sending` → `queued`, due at `nextAttemptAt`. `false`: the claim is no longer held. */
	async defer(id: string, attempt: number, nextAttemptAt: number, errorCode: string, now: number): Promise<boolean> {
		const result = await this.d1
			.prepare(
				`UPDATE mail_messages SET state = 'queued', next_attempt_at = ?, error_code = ?, updated_at = ?
				WHERE id = ? AND state = 'sending' AND attempts = ?`,
			)
			.bind(nextAttemptAt, errorCode, now, id, attempt)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Messages the dispatcher may have lost, the oldest first: queued, unchanged since `queuedBefore` and due at `now`
	 * (no deferred next attempt still ahead), or claimed before `claimedBefore` and never settled.
	 */
	async listStalled(queuedBefore: number, claimedBefore: number, now: number, limit: number): Promise<MailMessageRow[]> {
		const { results } = await this.d1
			.prepare(
				`SELECT * FROM mail_messages
				WHERE (state = 'queued' AND updated_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
					OR (state = 'sending' AND updated_at <= ?)
				ORDER BY id LIMIT ?`,
			)
			.bind(queuedBefore, now, claimedBefore, limit)
			.all<MailMessageRow>()
		return results
	}

	/** Forgets one final message's content. `false`: it is not final, or has no content left. */
	async purgeContent(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET content = NULL WHERE id = ? AND content IS NOT NULL AND state IN (${finalStates})`)
			.bind(id)
			.run()
		const objects = await this.purgeObjects('id = ?', [id])
		return result.meta.changes > 0 || objects > 0
	}

	/**
	 * Forgets the content of final messages unchanged since `finalBefore`; returns how many. Every row content at once;
	 * object content at most `OBJECT_BATCH` per call, and the next pass continues.
	 */
	async purgeFinalContent(finalBefore: number): Promise<number> {
		const result = await this.d1
			.prepare(`UPDATE mail_messages SET content = NULL WHERE content IS NOT NULL AND updated_at <= ? AND state IN (${finalStates})`)
			.bind(finalBefore)
			.run()
		return result.meta.changes + (await this.purgeObjects('updated_at <= ?', [finalBefore]))
	}

	/** The object goes first: a row whose update then fails names a missing object, which reads as purged. */
	private async purgeObjects(where: string, binds: readonly (string | number)[]): Promise<number> {
		if (this.objects === null) return 0
		const { results } = await this.d1
			.prepare(`SELECT id, content_ref FROM mail_messages WHERE content_ref IS NOT NULL AND ${where} AND state IN (${finalStates}) ORDER BY id LIMIT ?`)
			.bind(...binds, OBJECT_BATCH)
			.all<{ id: string; content_ref: string }>()
		let purged = 0
		for (const row of results) {
			await this.objects.delete(row.content_ref)
			const updated = await this.d1
				.prepare(`UPDATE mail_messages SET content_ref = NULL WHERE id = ? AND content_ref = ? AND state IN (${finalStates})`)
				.bind(row.id, row.content_ref)
				.run()
			purged += updated.meta.changes
		}
		return purged
	}

	/**
	 * Collects content objects written before a row that never named them, recorded before `recordedBefore`: their
	 * recording stopped, or a message under the same key won. Returns how many objects it removed.
	 */
	async collectUploads(recordedBefore: number): Promise<number> {
		if (this.objects === null) return 0
		const { results } = await this.d1
			.prepare('SELECT message_id, object_key FROM mail_content_uploads WHERE created_at <= ? ORDER BY created_at LIMIT ?')
			.bind(recordedBefore, OBJECT_BATCH)
			.all<{ message_id: string; object_key: string }>()
		let collected = 0
		for (const upload of results) {
			const named = await this.d1
				.prepare('SELECT id FROM mail_messages WHERE id = ? AND content_ref = ?')
				.bind(upload.message_id, upload.object_key)
				.first<{ id: string }>()
			if (named === null) {
				await this.objects.delete(upload.object_key)
				collected++
			}
			await this.d1.prepare('DELETE FROM mail_content_uploads WHERE message_id = ?').bind(upload.message_id).run()
		}
		return collected
	}
}

/** One object per message, named by its id. */
function mailContentKey(messageId: string): string {
	return `messages/${messageId}.json`
}
