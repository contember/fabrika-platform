import { DEFAULT_OPERATIONS_SERVICE_KEY } from '@fabrika/operations-contract'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { INSTALLATION_SOURCE } from '../installation-source.js'
import type { SourceRow } from './sources.js'
import { number } from './values.js'

export interface SecurityAlertConfigRow {
	source_id: string
	account_threshold: number
	installation_threshold: number
}

/** The installation source, its sign-in thresholds, and how far IAM's sign-in signals have been read. */
export class SecurityAlertsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	/**
	 * The installation source, created on first use so an existing installation gains it on upgrade. The catalog
	 * reconcile touches only `origin = 'control'` rows; null only when another row holds the coordinate.
	 */
	async ensureInstallationSource(): Promise<SourceRow | null> {
		const existing = await this.installationSource()
		if (existing !== null) return existing
		const now = this.now()
		await this.db
			.prepare(`INSERT INTO sources
				(id, app_id, environment, service_key, display_name, enabled, disabled_at, origin, public_origin, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, 1, NULL, 'installation', NULL, ?, ?)
				ON CONFLICT (app_id, environment, service_key) DO NOTHING`)
			.bind(
				uuidv7(now),
				INSTALLATION_SOURCE.appId,
				INSTALLATION_SOURCE.environment,
				DEFAULT_OPERATIONS_SERVICE_KEY,
				INSTALLATION_SOURCE.displayName,
				now,
				now,
			)
			.run()
		return this.installationSource()
	}

	private installationSource(): Promise<SourceRow | null> {
		return this.db
			.prepare(`SELECT * FROM sources WHERE origin = 'installation' AND app_id = ? AND environment = ? AND service_key = ?`)
			.bind(INSTALLATION_SOURCE.appId, INSTALLATION_SOURCE.environment, DEFAULT_OPERATIONS_SERVICE_KEY)
			.first<SourceRow>()
	}

	getConfig(sourceId: string): Promise<SecurityAlertConfigRow | null> {
		return this.db.prepare('SELECT * FROM security_alert_config WHERE source_id = ?').bind(sourceId).first<SecurityAlertConfigRow>()
	}

	async setConfig(sourceId: string, input: { accountThreshold: number; installationThreshold: number }): Promise<void> {
		await this.db
			.prepare(`INSERT INTO security_alert_config (source_id, account_threshold, installation_threshold) VALUES (?, ?, ?)
				ON CONFLICT (source_id) DO UPDATE SET
					account_threshold = excluded.account_threshold, installation_threshold = excluded.installation_threshold`)
			.bind(sourceId, input.accountThreshold, input.installationThreshold)
			.run()
	}

	/** Whether the source has an enabled `security` rule and at least one enabled `security` channel. */
	async isConfigured(sourceId: string): Promise<boolean> {
		const row = await this.db
			.prepare(`SELECT 1 AS configured FROM notification_channels channel
				JOIN alert_rules rule ON rule.source_id = channel.source_id AND rule.type = channel.scope AND rule.enabled = 1
				WHERE channel.source_id = ? AND channel.scope = 'security' AND channel.enabled = 1`)
			.bind(sourceId)
			.first<{ configured: number }>()
		return row !== null
	}

	async evaluatedUntil(): Promise<number | null> {
		const row = await this.db
			.prepare('SELECT evaluated_until FROM security_signal_cursor WHERE singleton = 1')
			.first<{ evaluated_until: number | string | null }>()
		if (row === null) throw new Error('security signal cursor is missing')
		return row.evaluated_until === null ? null : number(row.evaluated_until, 'security_signal_cursor.evaluated_until')
	}

	/** Move the mark forward only: an overlapping pass that finished earlier never moves it back. */
	async advance(until: number): Promise<void> {
		await this.db
			.prepare(`UPDATE security_signal_cursor SET evaluated_until = ?
				WHERE singleton = 1 AND (evaluated_until IS NULL OR evaluated_until < ?)`)
			.bind(until, until)
			.run()
	}

	async reset(): Promise<void> {
		await this.db.prepare('UPDATE security_signal_cursor SET evaluated_until = NULL WHERE singleton = 1 AND evaluated_until IS NOT NULL').run()
	}
}
