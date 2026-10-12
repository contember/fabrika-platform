import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { type AuditEventInput, auditEventStatement } from './audit'

/** One live membership transport key (the `membership_transport_keys` table); only its hash is stored. */
export interface MembershipTransportKeyRow {
	id: string
	app: string
	key_hash: string
	expires_at: number
	created_at: number
}

/**
 * The keys an application environment authenticates IAM's membership transport with (`src/membership-http.ts`). A key
 * names the one IAM application id it acts for and nothing else: it is no principal and holds no grant.
 */
export class MembershipTransportKeyRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/**
	 * Record a new key of `app` and delete every other key of it except `keep`, in one batch: the key the caller recorded
	 * as active stays valid until the caller replaces it, and a key issued earlier and never recorded is gone.
	 */
	async issue(
		input: { app: string; keyHash: string; expiresAt: number; keep: string | null; now: number },
		audit?: (keyId: string) => AuditEventInput,
	): Promise<string> {
		const id = uuidv7()
		await this.db.batch([
			this.db
				.prepare('DELETE FROM membership_transport_keys WHERE app = ? AND id <> ?')
				.bind(input.app, input.keep ?? ''),
			this.db
				.prepare('INSERT INTO membership_transport_keys (id, app, key_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
				.bind(id, input.app, input.keyHash, input.expiresAt, input.now),
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit(id))]),
		])
		return id
	}

	/** The application id a live key acts for, or null for an unknown or expired key. */
	async appOfKey(keyHash: string, now: number): Promise<string | null> {
		const row = await this.db
			.prepare('SELECT app FROM membership_transport_keys WHERE key_hash = ? AND expires_at > ?')
			.bind(keyHash, now)
			.first<{ app: string }>()
		return row?.app ?? null
	}
}
