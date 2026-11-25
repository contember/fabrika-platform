import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter } from './audit'
import { principalLockStatements } from './principals'

/** A row of `passkeys` (migration 0038). `sign_count` is a BIGINT on Postgres, which the driver may answer as text. */
export interface PasskeyRow {
	id: string
	principal_id: string
	credential_id: string
	public_key: string
	sign_count: number | string
	/** A JSON array of strings. */
	transports: string
	label: string
	created_at: number
	last_used_at: number | null
}

export type PasskeyChallengeKind = 'registration' | 'assertion'

/** A consumed challenge: what it was, what it was bound to and until when it could be answered. */
export interface ConsumedPasskeyChallenge {
	challenge: string
	binding: string
	expires_at: number
}

export interface NewPasskey {
	id: string
	principalId: string
	credentialId: string
	publicKey: string
	signCount: number
	transports: readonly string[]
	label: string
	createdAt: number
}

/** Why a registration wrote nothing. */
export type PasskeyInsertRefusal = 'duplicate' | 'limit' | 'step_up_required'

/**
 * A person's passkeys and the challenges of their ceremonies. A challenge is consumed by the DELETE that reads it, so it
 * answers once whatever the comparison after it says.
 */
export class PasskeyRepository {
	constructor(
		protected readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	async list(principalId: string): Promise<PasskeyRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM passkeys WHERE principal_id = ? ORDER BY created_at, id')
			.bind(principalId)
			.all<PasskeyRow>()
		return results
	}

	async findByCredentialId(principalId: string, credentialId: string): Promise<PasskeyRow | null> {
		return this.db
			.prepare('SELECT * FROM passkeys WHERE principal_id = ? AND credential_id = ?')
			.bind(principalId, credentialId)
			.first<PasskeyRow>()
	}

	/**
	 * Store a challenge for the principal, at most `maxOpen` unexpired ones at a time; null when the principal holds that
	 * many already.
	 */
	async issueChallenge(
		input: { principalId: string; kind: PasskeyChallengeKind; challenge: string; binding: string; now: number; expiresAt: number },
		maxOpen: number,
	): Promise<string | null> {
		const id = uuidv7()
		const row = await this.db
			.prepare(`INSERT INTO passkey_challenges (id, principal_id, kind, challenge, binding, created_at, expires_at)
				SELECT ?, ?, ?, ?, ?, ?, ?
				WHERE (SELECT COUNT(*) FROM passkey_challenges WHERE principal_id = ? AND expires_at > ?) < ?
				RETURNING id`)
			.bind(id, input.principalId, input.kind, input.challenge, input.binding, input.now, input.expiresAt, input.principalId, input.now, maxOpen)
			.first<{ id: string }>()
		return row === null ? null : row.id
	}

	/** Remove and answer the principal's challenge of `kind`; null when there is none, spent or never issued. */
	async consumeChallenge(principalId: string, kind: PasskeyChallengeKind, id: string): Promise<ConsumedPasskeyChallenge | null> {
		return this.db
			.prepare('DELETE FROM passkey_challenges WHERE id = ? AND principal_id = ? AND kind = ? RETURNING challenge, binding, expires_at')
			.bind(id, principalId, kind)
			.first<ConsumedPasskeyChallenge>()
	}

	/**
	 * Store a verified passkey with its record. Without `stepUp` it is written only while the principal has no passkey;
	 * with it, only while the principal has fewer than `max`. The principal row is locked first on Postgres, so two
	 * first registrations cannot both see none.
	 */
	async insert(passkey: NewPasskey, options: { steppedUp: boolean; max: number }, audit: AuditEventInput): Promise<PasskeyRow | PasskeyInsertRefusal> {
		const id = passkey.id
		const lock = principalLockStatements(this.db, this.writer.dialect, { sql: '?', binds: [passkey.principalId] })
		const firstOnly = options.steppedUp ? '' : ' AND NOT EXISTS (SELECT 1 FROM passkeys WHERE principal_id = ?)'
		const change = this.writer.changed([{
			sql: `INSERT INTO passkeys (id, principal_id, credential_id, public_key, sign_count, transports, label, created_at, last_used_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL
				WHERE (SELECT COUNT(*) FROM passkeys WHERE principal_id = ?) < ?${firstOnly}
				ON CONFLICT (credential_id) DO NOTHING
				RETURNING *`,
			binds: [
				id,
				passkey.principalId,
				passkey.credentialId,
				passkey.publicKey,
				passkey.signCount,
				JSON.stringify(passkey.transports),
				passkey.label,
				passkey.createdAt,
				passkey.principalId,
				options.max,
				...(options.steppedUp ? [] : [passkey.principalId]),
			],
		}], audit)
		const rows = change.rows(await this.db.batch<PasskeyRow>([...lock, ...change.statements]), lock.length)
		const inserted = rows[0]
		if (inserted !== undefined) return inserted
		// Nothing was written; say why, from a read after the fact (the answer only words the refusal).
		const existing = await this.db
			.prepare('SELECT principal_id FROM passkeys WHERE credential_id = ?')
			.bind(passkey.credentialId)
			.first<{ principal_id: string }>()
		if (existing !== null) return 'duplicate'
		const held = await this.list(passkey.principalId)
		return !options.steppedUp && held.length > 0 ? 'step_up_required' : 'limit'
	}

	/**
	 * Move the counter of an accepted assertion from `previous` to `next` and stamp its use. False when another
	 * assertion moved it in between, which refuses this one.
	 */
	async recordUse(id: string, previous: number, next: number, at: number): Promise<boolean> {
		const row = await this.db
			.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ? RETURNING id')
			.bind(next, at, id, previous)
			.first<{ id: string }>()
		return row !== null
	}

	/** Remove one of the principal's passkeys with its record; false when it has no such passkey. */
	async remove(principalId: string, passkeyId: string, audit: AuditEventInput): Promise<boolean> {
		const rows = await this.writer.run([{
			sql: 'DELETE FROM passkeys WHERE id = ? AND principal_id = ? RETURNING id',
			binds: [passkeyId, principalId],
		}], audit)
		return rows.length > 0
	}

	/** Remove every passkey and open challenge of the principal, with one record when a passkey was removed. */
	async reset(principalId: string, audit: AuditEventInput): Promise<number> {
		const challenges = this.db.prepare('DELETE FROM passkey_challenges WHERE principal_id = ?').bind(principalId)
		const removal = this.writer.changed([{ sql: 'DELETE FROM passkeys WHERE principal_id = ? RETURNING id', binds: [principalId] }], audit)
		const results = await this.db.batch([challenges, ...removal.statements])
		return removal.rows(results, 1).length
	}

	/** Drop the challenges nobody answered in time. */
	async pruneChallenges(nowSeconds: number): Promise<number> {
		const rows = await this.db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ? RETURNING id').bind(nowSeconds).all<{ id: string }>()
		return rows.results.length
	}
}
