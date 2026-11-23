import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { SealedValue } from '../data-key'
import { type AuditEventInput, AuditWriter, guardedInsert } from './audit'
import { principalLockStatements } from './principals'
import { unixNow } from './sql'

/** A row of `second_factors` (migration 0032): one TOTP authenticator per principal, its secret sealed. */
export interface SecondFactorRow {
	principal_id: string
	ciphertext: string
	value_iv: string
	wrapped_dek: string
	dek_iv: string
	created_at: number
	/** NULL while the enrolment waits for its first valid code. Only a confirmed factor is asked for at sign-in. */
	confirmed_at: number | null
	/** The time step of the last accepted code; a code of that step or an earlier one is never accepted again. */
	last_step: number | null
	/** The confirmation that wrote the recovery codes; NULL until one did. */
	confirmation_id: string | null
}

/** What an administrator sees of a principal's second factor. */
export interface SecondFactorStatus {
	readonly confirmedAt: number | null
	readonly recoveryCodesLeft: number
}

export function sealedValueOf(row: SecondFactorRow): SealedValue {
	return { ciphertext: row.ciphertext, valueIv: row.value_iv, wrappedDek: row.wrapped_dek, dekIv: row.dek_iv }
}

/**
 * A person's TOTP authenticator and recovery codes. Every write that touches more than one of a principal's rows locks
 * the principal row first on Postgres (`principalLockStatements`), the order every writer of a principal's rows keeps.
 */
export class SecondFactorRepository {
	constructor(
		protected readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	async get(principalId: string): Promise<SecondFactorRow | null> {
		return this.db.prepare('SELECT * FROM second_factors WHERE principal_id = ?').bind(principalId).first<SecondFactorRow>()
	}

	/** Whether a sign-in of the principal needs its second factor. */
	async isConfirmed(principalId: string): Promise<boolean> {
		const row = await this.db
			.prepare('SELECT 1 AS confirmed FROM second_factors WHERE principal_id = ? AND confirmed_at IS NOT NULL')
			.bind(principalId)
			.first<{ confirmed: number }>()
		return row !== null
	}

	async status(principalId: string): Promise<SecondFactorStatus> {
		const [factor, codes] = await Promise.all([
			this.get(principalId),
			this.db
				.prepare('SELECT COUNT(*) AS left_count FROM second_factor_recovery_codes WHERE principal_id = ? AND used_at IS NULL')
				.bind(principalId)
				.first<{ left_count: number | string }>(),
		])
		const confirmedAt = factor?.confirmed_at ?? null
		return { confirmedAt, recoveryCodesLeft: confirmedAt === null ? 0 : Number(codes?.left_count ?? 0) }
	}

	/**
	 * Store a new secret that waits for its first code, replacing one that still waits. A confirmed factor is never
	 * replaced here (false): only an administrator's reset removes it. Nothing is recorded: an unconfirmed secret asks
	 * nobody for anything; its confirmation is the enrolment, and that is recorded.
	 */
	async begin(principalId: string, sealed: SealedValue): Promise<boolean> {
		const row = await this.db
			.prepare(`INSERT INTO second_factors (principal_id, ciphertext, value_iv, wrapped_dek, dek_iv, created_at, confirmed_at, last_step)
				VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
				ON CONFLICT (principal_id) DO UPDATE SET
					ciphertext = excluded.ciphertext, value_iv = excluded.value_iv, wrapped_dek = excluded.wrapped_dek,
					dek_iv = excluded.dek_iv, created_at = excluded.created_at, last_step = NULL
					WHERE second_factors.confirmed_at IS NULL
				RETURNING principal_id`)
			.bind(principalId, sealed.ciphertext, sealed.valueIv, sealed.wrappedDek, sealed.dekIv, unixNow())
			.first<{ principal_id: string }>()
		return row !== null
	}

	/**
	 * Confirm the waiting secret whose ciphertext the caller checked the code against, with its record, and replace the
	 * principal's recovery codes with `recoveryCodeHashes`, in one transaction. The codes are written only when the
	 * confirmation changed the row, so a secret replaced in between confirms nothing (false) and issues no code. The guard
	 * reads this attempt's own `confirmation_id`, never the timestamp: a second confirmation in the same second must not
	 * replace the codes the first one showed.
	 */
	async confirm(
		input: { principalId: string; ciphertext: string; step: number; recoveryCodeHashes: readonly string[] },
		audit: AuditEventInput,
	): Promise<boolean> {
		const now = unixNow()
		const confirmationId = uuidv7()
		const { principalId } = input
		const lock = principalLockStatements(this.db, this.writer.dialect, { sql: '?', binds: [principalId] })
		const confirmation = this.writer.changed([{
			sql: `UPDATE second_factors SET confirmed_at = ?, last_step = ?, confirmation_id = ?
				WHERE principal_id = ? AND confirmed_at IS NULL AND ciphertext = ? RETURNING principal_id`,
			binds: [now, input.step, confirmationId, principalId, input.ciphertext],
		}], audit)
		const guard = {
			sql: 'SELECT 1 FROM second_factors WHERE principal_id = ? AND confirmation_id = ?',
			binds: [principalId, confirmationId],
		}
		const replaced = this.db
			.prepare(`DELETE FROM second_factor_recovery_codes WHERE principal_id = ? AND EXISTS (${guard.sql})`)
			.bind(principalId, ...guard.binds)
		const codes = input.recoveryCodeHashes.map((hash) => {
			const insert = guardedInsert('second_factor_recovery_codes (code_hash, principal_id, created_at, used_at)', '?, ?, ?, NULL', [
				hash,
				principalId,
				now,
			], guard)
			return this.db.prepare(insert.sql).bind(...insert.binds)
		})
		const results = await this.db.batch([...lock, ...confirmation.statements, replaced, ...codes])
		return confirmation.rows(results, lock.length).length > 0
	}

	/**
	 * Accept a code of `step` for a confirmed factor: true only when no code of this step or a later one was accepted
	 * before. The guard is the statement itself, so two submissions of one code accept it once.
	 */
	async acceptStep(principalId: string, step: number): Promise<boolean> {
		const row = await this.db
			.prepare(`UPDATE second_factors SET last_step = ?
				WHERE principal_id = ? AND confirmed_at IS NOT NULL AND (last_step IS NULL OR last_step < ?) RETURNING principal_id`)
			.bind(step, principalId, step)
			.first<{ principal_id: string }>()
		return row !== null
	}

	/** Spend one unused recovery code of a confirmed factor, with its record; false when the code is not one. */
	async spendRecoveryCode(principalId: string, codeHash: string, audit: AuditEventInput): Promise<boolean> {
		const rows = await this.writer.run([{
			sql: `UPDATE second_factor_recovery_codes SET used_at = ?
				WHERE code_hash = ? AND principal_id = ? AND used_at IS NULL
					AND EXISTS (SELECT 1 FROM second_factors WHERE principal_id = ? AND confirmed_at IS NOT NULL)
				RETURNING code_hash`,
			binds: [unixNow(), codeHash, principalId, principalId],
		}], audit)
		return rows.length > 0
	}

	/**
	 * Remove the principal's authenticator and recovery codes, with one record, so its next sign-in asks for no second
	 * factor and it may enrol again. False when it had neither, and nothing is recorded.
	 */
	async reset(principalId: string, audit: AuditEventInput): Promise<boolean> {
		const lock = principalLockStatements(this.db, this.writer.dialect, { sql: '?', binds: [principalId] })
		const removal = this.writer.changed([
			{ sql: 'DELETE FROM second_factor_recovery_codes WHERE principal_id = ? RETURNING code_hash', binds: [principalId] },
			{ sql: 'DELETE FROM second_factors WHERE principal_id = ? RETURNING principal_id', binds: [principalId] },
		], audit)
		const results = await this.db.batch([...lock, ...removal.statements])
		// The record is written when either delete removed a row; the answer says whether an authenticator was removed.
		return removal.rows(results, lock.length).length > 0
	}
}
