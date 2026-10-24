import { type SqlDatabase } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter } from './audit'
import { unixNow } from './sql'

/** The one row of `password_policy` (migration 0022). No row is the default minimum. */
export interface PasswordPolicyRow {
	id: number
	min_length: number
	/** When an administrator last changed the minimum, in epoch seconds. */
	updated_at: number
}

const COLUMNS = 'id, min_length, updated_at'

/**
 * The installation's minimum password length (ADR-0020). The row is the installation's, so its key is the constant 1. The
 * caller has held the value to the runtime's floor; this stores it as given, and the reader checks it again.
 */
export class PasswordPolicyRepository {
	constructor(
		protected readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** The stored row, or null when nobody ever set a minimum. */
	async get(): Promise<PasswordPolicyRow | null> {
		return this.db.prepare(`SELECT ${COLUMNS} FROM password_policy WHERE id = 1`).first<PasswordPolicyRow>()
	}

	/**
	 * Store the minimum, with its record in the same statement group. Only a value that differs from the stored one is a
	 * change, so setting the minimum it already has writes neither the row nor its record; null then.
	 */
	async setMinLength(minLength: number, audit: AuditEventInput): Promise<PasswordPolicyRow | null> {
		const [row] = await this.writer.run<PasswordPolicyRow>([{
			sql: `INSERT INTO password_policy (${COLUMNS}) VALUES (1, ?, ?)
				ON CONFLICT (id) DO UPDATE SET min_length = excluded.min_length, updated_at = excluded.updated_at
					WHERE password_policy.min_length <> excluded.min_length
				RETURNING ${COLUMNS}`,
			binds: [minLength, unixNow()],
		}], audit)
		return row ?? null
	}
}
