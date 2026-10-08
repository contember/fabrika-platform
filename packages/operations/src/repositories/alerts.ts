import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { parseObject } from './values.js'

export interface NotificationChannelRow {
	id: string
	source_id: string
	scope: string
	type: string
	target: string
	enabled: number
}

export interface AlertConfigRow {
	source_id: string
	threshold: number
	enabled: number
}

export interface AlertRuleRow {
	source_id: string
	type: string
	enabled: number
}

export interface ClaimedNotification {
	id: string
	dedupKey: string
	type: string
	target: string
	payload: Record<string, unknown>
	attempts: number
	maxAttempts: number
	claimToken: string
}

export abstract class AlertsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	protected abstract claimSql(): string

	async setConfig(sourceId: string, input: { threshold: number; enabled: boolean }): Promise<void> {
		if (!Number.isInteger(input.threshold) || input.threshold <= 0) throw new RangeError('Alert threshold must be a positive integer.')
		await this.db
			.prepare(`INSERT INTO alert_config (source_id, threshold, enabled) VALUES (?, ?, ?)
				ON CONFLICT (source_id) DO UPDATE SET threshold = excluded.threshold, enabled = excluded.enabled`)
			.bind(sourceId, input.threshold, input.enabled ? 1 : 0)
			.run()
	}

	getConfig(sourceId: string): Promise<AlertConfigRow | null> {
		return this.db.prepare('SELECT * FROM alert_config WHERE source_id = ?').bind(sourceId).first<AlertConfigRow>()
	}

	async listEnabledConfigs(): Promise<AlertConfigRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM alert_config WHERE enabled = 1 ORDER BY source_id').all<AlertConfigRow>()
		return results
	}

	async deleteConfig(sourceId: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM alert_config WHERE source_id = ?').bind(sourceId).run()
		return result.meta.changes === 1
	}

	async setRule(sourceId: string, type: string, enabled: boolean): Promise<void> {
		await this.db
			.prepare(`INSERT INTO alert_rules (source_id, type, enabled) VALUES (?, ?, ?)
				ON CONFLICT (source_id, type) DO UPDATE SET enabled = excluded.enabled`)
			.bind(sourceId, type, enabled ? 1 : 0)
			.run()
	}

	async listRules(sourceId: string): Promise<AlertRuleRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM alert_rules WHERE source_id = ? ORDER BY type')
			.bind(sourceId)
			.all<AlertRuleRow>()
		return results
	}

	async deleteRule(sourceId: string, type: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM alert_rules WHERE source_id = ? AND type = ?').bind(sourceId, type).run()
		return result.meta.changes === 1
	}

	async upsertChannel(input: {
		id: string
		sourceId: string
		scope: string
		type: string
		target: string
		enabled: boolean
	}): Promise<void> {
		await this.db
			.prepare(`INSERT INTO notification_channels (id, source_id, scope, type, target, enabled)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					scope = excluded.scope, type = excluded.type, target = excluded.target, enabled = excluded.enabled
				WHERE notification_channels.source_id = excluded.source_id`)
			.bind(input.id, input.sourceId, input.scope, input.type, input.target, input.enabled ? 1 : 0)
			.run()
	}

	async listChannels(sourceId: string): Promise<NotificationChannelRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM notification_channels WHERE source_id = ? ORDER BY id')
			.bind(sourceId)
			.all<NotificationChannelRow>()
		return results
	}

	async deleteChannel(sourceId: string, id: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM notification_channels WHERE source_id = ? AND id = ?')
			.bind(sourceId, id)
			.run()
		return result.meta.changes === 1
	}

	async tryClaim(key: string, ttlMs: number): Promise<boolean> {
		const now = this.now()
		const row = await this.db
			.prepare(`INSERT INTO alert_claims (claim_key, claimed_at, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT (claim_key) DO UPDATE SET
					claimed_at = excluded.claimed_at,
					expires_at = excluded.expires_at
				WHERE alert_claims.expires_at <= ?
				RETURNING claim_key`)
			.bind(key, now, now + ttlMs, now)
			.first<{ claim_key: string }>()
		return row !== null
	}

	async enqueueNotification(input: {
		dedupKey: string
		sourceId: string
		channelId: string
		kind: string
		payload: Record<string, unknown>
	}): Promise<boolean> {
		const result = await this.db
			.prepare(`INSERT INTO notification_outbox
				(id, dedup_key, source_id, channel_id, kind, payload, created_at, attempts, max_attempts, visible_at,
					claimed_until, claim_token, delivered_at, abandoned_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, 0, 6, ?, NULL, NULL, NULL, NULL
				FROM notification_channels
				WHERE id = ? AND source_id = ? AND enabled = 1
				ON CONFLICT (dedup_key) DO NOTHING`)
			.bind(
				uuidv7(this.now()),
				input.dedupKey,
				input.sourceId,
				input.channelId,
				input.kind,
				JSON.stringify(input.payload),
				this.now(),
				this.now(),
				input.channelId,
				input.sourceId,
			)
			.run()
		return result.meta.changes === 1
	}

	async claimNotifications(input: { limit: number; leaseMs: number }): Promise<ClaimedNotification[]> {
		const now = this.now()
		const claimToken = uuidv7(now)
		const claimed = await this.db.batch<{
			id: string
			dedup_key: string
			channel_id: string
			payload: string
			attempts: number
			max_attempts: number
			claim_token: string
		}>([
			this.db
				.prepare(`UPDATE notification_outbox SET abandoned_at = ?, claimed_until = NULL, claim_token = NULL
						WHERE delivered_at IS NULL AND abandoned_at IS NULL
							AND attempts >= max_attempts AND claimed_until IS NOT NULL AND claimed_until <= ?`)
				.bind(now, now),
			this.db.prepare(this.claimSql())
				.bind(now + input.leaseMs, claimToken, now, now, input.limit),
		])
		const results = claimed[1]?.results ?? []
		const notifications: ClaimedNotification[] = []
		for (const row of results) {
			const channel = await this.db.prepare('SELECT type, target FROM notification_channels WHERE id = ?')
				.bind(row.channel_id)
				.first<{ type: string; target: string }>()
			if (!channel) throw new Error('notification channel disappeared')
			notifications.push({
				id: row.id,
				dedupKey: row.dedup_key,
				type: channel.type,
				target: channel.target,
				payload: parseObject(row.payload),
				attempts: row.attempts,
				maxAttempts: row.max_attempts,
				claimToken: row.claim_token,
			})
		}
		return notifications
	}

	async completeNotification(input: {
		id: string
		claimToken: string
		delivered: boolean
		retryDelayMs?: number
		errorCode?: string
	}): Promise<boolean> {
		const now = this.now()
		const attemptId = uuidv7(now)
		const terminal = input.delivered
			? 'delivered_at = ?, claimed_until = NULL, claim_token = NULL'
			: `abandoned_at = CASE WHEN attempts >= max_attempts THEN ? ELSE abandoned_at END,
				visible_at = CASE WHEN attempts < max_attempts THEN ? ELSE visible_at END,
				claimed_until = NULL, claim_token = NULL`
		const terminalValues = input.delivered
			? [now]
			: [now, now + Math.max(0, input.retryDelayMs ?? 0)]
		const results = await this.db.batch([
			this.db
				.prepare(`INSERT INTO notification_attempts
					(id, notification_id, attempted_at, delivered, error_code)
					SELECT ?, id, ?, ?, ? FROM notification_outbox WHERE id = ? AND claim_token = ?`)
				.bind(attemptId, now, input.delivered ? 1 : 0, input.errorCode ?? null, input.id, input.claimToken),
			this.db
				.prepare(`UPDATE notification_outbox SET ${terminal} WHERE id = ? AND claim_token = ? RETURNING id`)
				.bind(...terminalValues, input.id, input.claimToken),
		])
		return results[1]?.results.length === 1
	}

	async pruneClaims(at: number = this.now()): Promise<number> {
		const result = await this.db.prepare('DELETE FROM alert_claims WHERE expires_at <= ?').bind(at).run()
		return result.meta.changes
	}
}

export class SqliteAlertsRepository extends AlertsRepository {
	protected claimSql(): string {
		return `UPDATE notification_outbox SET claimed_until = ?, claim_token = ?, attempts = attempts + 1
			WHERE id IN (
				SELECT id FROM notification_outbox
				WHERE delivered_at IS NULL AND abandoned_at IS NULL AND visible_at <= ?
					AND (claimed_until IS NULL OR claimed_until <= ?)
					AND attempts < max_attempts
					AND EXISTS (
						SELECT 1 FROM notification_channels
						WHERE notification_channels.id = notification_outbox.channel_id AND enabled = 1
					)
				ORDER BY visible_at, id LIMIT ?
			)
			RETURNING id, dedup_key, channel_id, payload, attempts, max_attempts, claim_token`
	}
}

export class PostgresAlertsRepository extends AlertsRepository {
	protected claimSql(): string {
		return `UPDATE notification_outbox SET claimed_until = ?, claim_token = ?, attempts = attempts + 1
			WHERE id IN (
				SELECT id FROM notification_outbox
				WHERE delivered_at IS NULL AND abandoned_at IS NULL AND visible_at <= ?
					AND (claimed_until IS NULL OR claimed_until <= ?)
					AND attempts < max_attempts
					AND EXISTS (
						SELECT 1 FROM notification_channels
						WHERE notification_channels.id = notification_outbox.channel_id AND enabled = 1
					)
				ORDER BY visible_at, id LIMIT ?
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, dedup_key, channel_id, payload, attempts, max_attempts, claim_token`
	}
}
