import { type SqlDatabase } from '@fabrika/platform'
import { type AuditEventInput, AuditWriter } from './audit'
import { unixNow } from './sql'

/** The one row of `installation_brand` (migration 0021). A row without a light image is no brand. */
export interface InstallationBrandRow {
	id: number
	light_type: string | null
	light_base64: string | null
	dark_type: string | null
	dark_base64: string | null
	/** When the brand was last set or cleared, in epoch seconds. */
	updated_at: number
}

/** The images a write stores: the light one always, the dark one when the brand has it. */
export interface InstallationBrandImages {
	readonly light: { readonly type: string; readonly base64: string }
	readonly dark: { readonly type: string; readonly base64: string } | null
}

const COLUMNS = 'id, light_type, light_base64, dark_type, dark_base64, updated_at'

/**
 * The installation's client logo (ADR-0065). The row is the installation's, so its key is the constant 1. The caller
 * has checked the images; this stores them as given, and the reader checks them again.
 */
export class InstallationBrandRepository {
	constructor(
		protected readonly db: SqlDatabase,
		private readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	/** The stored row, or null when no brand was ever set. */
	async get(): Promise<InstallationBrandRow | null> {
		return this.db.prepare(`SELECT ${COLUMNS} FROM installation_brand WHERE id = 1`).first<InstallationBrandRow>()
	}

	/** Store the brand in place of any earlier one, with its record in the same statement group. Always a change. */
	async set(images: InstallationBrandImages, audit: AuditEventInput): Promise<InstallationBrandRow> {
		const [row] = await this.writer.run<InstallationBrandRow>([{
			sql: `INSERT INTO installation_brand (${COLUMNS}) VALUES (1, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET light_type = excluded.light_type, light_base64 = excluded.light_base64,
					dark_type = excluded.dark_type, dark_base64 = excluded.dark_base64, updated_at = excluded.updated_at
				RETURNING ${COLUMNS}`,
			binds: [images.light.type, images.light.base64, images.dark?.type ?? null, images.dark?.base64 ?? null, unixNow()],
		}], audit)
		if (row === undefined) {
			throw new Error('expected a row from a RETURNING statement, got none')
		}
		return row
	}

	/**
	 * Remove the images and keep the row, so `updated_at` says when the brand was cleared. Only a row that still has an
	 * image changes, so clearing an absent brand writes neither the row nor its record; null then.
	 */
	async clear(audit: AuditEventInput): Promise<InstallationBrandRow | null> {
		const [row] = await this.writer.run<InstallationBrandRow>([{
			sql: `UPDATE installation_brand SET light_type = NULL, light_base64 = NULL, dark_type = NULL, dark_base64 = NULL, updated_at = ?
				WHERE id = 1 AND light_type IS NOT NULL RETURNING ${COLUMNS}`,
			binds: [unixNow()],
		}], audit)
		return row ?? null
	}
}
