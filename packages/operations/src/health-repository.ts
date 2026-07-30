import type { SqlDatabase } from '@fabrika/platform'
import {
	DEFAULT_FAILURE_THRESHOLD,
	DEFAULT_HEALTH_HISTORY_LIMIT,
	DEFAULT_HEALTH_TIMEOUT_MS,
	DEFAULT_RECOVERY_THRESHOLD,
	type EvaluatedTelemetryHealth,
	healthAlertDedupKey,
	type HealthState,
	type HealthTransition,
	type HttpCheckAttempt,
	type HttpCheckDetailCode,
	type HttpHealthDecision,
	MAX_HEALTH_TIMEOUT_MS,
	resolveHealthCheckUrl,
} from './health.js'
import { uuidv7 } from './uuid.js'

export interface HealthCheckRow {
	id: string
	source_id: string
	path: string
	enabled: number
	interval_ms: number | string
	timeout_ms: number | string
	expected_status: number
	failure_threshold: number
	recovery_threshold: number
	stale_after_ms: number | string
	due_at: number | string
	claimed_until: number | string | null
	claim_token: string | null
	created_at: number | string
	updated_at: number | string
}

export interface ClaimedHealthCheck {
	id: string
	sourceId: string
	publicOrigin: string | null
	path: string
	intervalMs: number
	timeoutMs: number
	expectedStatus: number
	failureThreshold: number
	recoveryThreshold: number
	staleAfterMs: number
	claimToken: string
}

export interface CurrentHealthRow {
	checkId: string
	state: Exclude<HealthState, 'stale' | 'unavailable'>
	observedAt: number
	latencyMs: number | null
	detailCode: HttpCheckDetailCode
	consecutiveFailures: number
	consecutiveSuccesses: number
	transitionId: string | null
}

export interface HealthObservationRow {
	id: string
	checkId: string
	state: HealthState
	observedAt: number
	latencyMs: number | null
	detailCode: string | null
	successful: boolean
	statusCode: number | null
	transitionId: string | null
}

export interface EnqueueHealthAlertsResult {
	enqueued: number
	deferredEmail: number
}

interface ClaimedHealthCheckRow extends HealthCheckRow {
	claim_token: string
}

interface CurrentHealthDatabaseRow {
	check_id: string
	state: string
	observed_at: number | string
	latency_ms: number | string | null
	detail_code: string
	consecutive_failures: number
	consecutive_successes: number
	transition_id: string | null
}

interface HealthObservationDatabaseRow {
	id: string
	check_id: string
	state: string
	observed_at: number | string
	latency_ms: number | string | null
	detail_code: string | null
	successful: number
	status_code: number | null
	transition_id: string | null
}

interface ChannelRow {
	id: string
	type: string
}

export abstract class HealthRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly now: () => number = Date.now,
	) {}

	protected abstract claimSql(): string

	async listChecks(sourceId: string): Promise<HealthCheckRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM health_checks WHERE source_id = ? ORDER BY path, id')
			.bind(sourceId)
			.all<HealthCheckRow>()
		return results.map(healthCheckRow)
	}

	async getCheck(checkId: string): Promise<HealthCheckRow | null> {
		const row = await this.db.prepare('SELECT * FROM health_checks WHERE id = ?').bind(checkId).first<HealthCheckRow>()
		return row === null ? null : healthCheckRow(row)
	}

	async upsertCheck(input: {
		id: string
		sourceId: string
		path: string
		enabled: boolean
		intervalMs: number
		timeoutMs?: number
		expectedStatus?: number
		failureThreshold?: number
		recoveryThreshold?: number
		staleAfterMs: number
	}): Promise<void> {
		resolveHealthCheckUrl('https://health.invalid', input.path)
		const intervalMs = positiveInteger(input.intervalMs, 'interval')
		const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS, 'timeout')
		if (timeoutMs > MAX_HEALTH_TIMEOUT_MS) throw new RangeError('timeout exceeds the health-check limit')
		const expectedStatus = positiveInteger(input.expectedStatus ?? 200, 'expected status')
		if (expectedStatus < 100 || expectedStatus > 599) throw new RangeError('expected status must be an HTTP status')
		const failureThreshold = positiveInteger(input.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD, 'failure threshold')
		const recoveryThreshold = positiveInteger(input.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD, 'recovery threshold')
		const staleAfterMs = positiveInteger(input.staleAfterMs, 'stale interval')
		const now = this.now()
		await this.db
			.prepare(`INSERT INTO health_checks
				(id, source_id, url, path, enabled, interval_ms, timeout_ms, expected_status,
					failure_threshold, recovery_threshold, stale_after_ms, due_at, claimed_until, claim_token, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					path = excluded.path,
					url = excluded.url,
					enabled = excluded.enabled,
					interval_ms = excluded.interval_ms,
					timeout_ms = excluded.timeout_ms,
					expected_status = excluded.expected_status,
					failure_threshold = excluded.failure_threshold,
					recovery_threshold = excluded.recovery_threshold,
					stale_after_ms = excluded.stale_after_ms,
					due_at = CASE WHEN health_checks.enabled = 0 AND excluded.enabled = 1 THEN excluded.due_at ELSE health_checks.due_at END,
					updated_at = excluded.updated_at
				WHERE health_checks.source_id = excluded.source_id`)
			.bind(
				input.id,
				input.sourceId,
				input.path,
				input.path,
				input.enabled ? 1 : 0,
				intervalMs,
				timeoutMs,
				expectedStatus,
				failureThreshold,
				recoveryThreshold,
				staleAfterMs,
				now,
				now,
				now,
			)
			.run()
	}

	async deleteCheck(sourceId: string, checkId: string): Promise<boolean> {
		const results = await this.db.batch<{ id: string }>([
			this.db.prepare('DELETE FROM health_observations WHERE check_id = ?').bind(checkId),
			this.db.prepare('DELETE FROM current_health WHERE check_id = ?').bind(checkId),
			this.db.prepare('DELETE FROM health_transitions WHERE check_id = ? AND source_id = ?').bind(checkId, sourceId),
			this.db.prepare('DELETE FROM health_checks WHERE id = ? AND source_id = ? RETURNING id').bind(checkId, sourceId),
		])
		return results[3]?.results.length === 1
	}

	async claimDueChecks(input: { limit: number; leaseMs: number }): Promise<ClaimedHealthCheck[]> {
		const limit = positiveInteger(input.limit, 'claim limit')
		const leaseMs = positiveInteger(input.leaseMs, 'lease')
		const now = this.now()
		const token = uuidv7(now)
		const { results } = await this.db.prepare(this.claimSql())
			.bind(now + leaseMs, token, now, now, limit)
			.all<ClaimedHealthCheckRow>()
		const claimed: ClaimedHealthCheck[] = []
		for (const row of results) {
			const source = await this.db.prepare('SELECT public_origin FROM sources WHERE id = ? AND enabled = 1')
				.bind(row.source_id)
				.first<{ public_origin: string | null }>()
			claimed.push({
				id: row.id,
				sourceId: row.source_id,
				publicOrigin: source?.public_origin ?? null,
				path: row.path,
				intervalMs: number(row.interval_ms, 'health_checks.interval_ms'),
				timeoutMs: number(row.timeout_ms, 'health_checks.timeout_ms'),
				expectedStatus: row.expected_status,
				failureThreshold: row.failure_threshold,
				recoveryThreshold: row.recovery_threshold,
				staleAfterMs: number(row.stale_after_ms, 'health_checks.stale_after_ms'),
				claimToken: row.claim_token,
			})
		}
		return claimed
	}

	async completeLease(input: { checkId: string; claimToken: string; nextDueAt: number }): Promise<boolean> {
		const result = await this.db
			.prepare(`UPDATE health_checks SET due_at = ?, claimed_until = NULL, claim_token = NULL, updated_at = ?
				WHERE id = ? AND claim_token = ?`)
			.bind(input.nextDueAt, this.now(), input.checkId, input.claimToken)
			.run()
		return result.meta.changes === 1
	}

	async getCurrent(checkId: string): Promise<CurrentHealthRow | null> {
		const row = await this.db.prepare('SELECT * FROM current_health WHERE check_id = ?')
			.bind(checkId)
			.first<CurrentHealthDatabaseRow>()
		return row === null ? null : currentHealthRow(row)
	}

	async recordHttpObservation(input: {
		sourceId: string
		checkId: string
		observationId: string
		attempt: HttpCheckAttempt
		decision: HttpHealthDecision
		historyLimit?: number
	}): Promise<void> {
		const historyLimit = positiveInteger(input.historyLimit ?? DEFAULT_HEALTH_HISTORY_LIMIT, 'history limit')
		const transition = input.decision.transition
		const statements = [
			this.db
				.prepare(`INSERT INTO health_observations
					(id, check_id, state, observed_at, latency_ms, detail_code, successful, status_code, transition_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					input.observationId,
					input.checkId,
					input.decision.current.state,
					input.attempt.observedAt,
					input.attempt.latencyMs,
					input.attempt.detailCode,
					input.attempt.successful ? 1 : 0,
					input.attempt.status,
					transition?.id ?? null,
				),
			this.db
				.prepare(`INSERT INTO current_health
					(check_id, state, observed_at, latency_ms, detail_code, consecutive_failures, consecutive_successes, transition_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (check_id) DO UPDATE SET
						state = excluded.state,
						observed_at = excluded.observed_at,
						latency_ms = excluded.latency_ms,
						detail_code = excluded.detail_code,
						consecutive_failures = excluded.consecutive_failures,
						consecutive_successes = excluded.consecutive_successes,
						transition_id = excluded.transition_id
					WHERE current_health.observed_at <= excluded.observed_at`)
				.bind(
					input.checkId,
					input.decision.current.state,
					input.decision.current.observedAt,
					input.decision.current.latencyMs,
					input.decision.current.detailCode,
					input.decision.current.consecutiveFailures,
					input.decision.current.consecutiveSuccesses,
					input.decision.current.transitionId,
				),
		]
		if (transition !== null) {
			statements.push(
				this.db
					.prepare(`INSERT INTO health_transitions
						(id, source_id, check_id, kind, from_state, to_state, occurred_at)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (id) DO NOTHING`)
					.bind(
						transition.id,
						input.sourceId,
						input.checkId,
						transition.kind,
						transition.from,
						transition.to,
						transition.at,
					),
			)
		}
		statements.push(
			this.db
				.prepare(`DELETE FROM health_observations
					WHERE check_id = ? AND id NOT IN (
						SELECT id FROM health_observations WHERE check_id = ?
						ORDER BY observed_at DESC, id DESC LIMIT ?
					)`)
				.bind(input.checkId, input.checkId, historyLimit),
		)
		await this.db.batch(statements)
	}

	async history(checkId: string, limit: number): Promise<HealthObservationRow[]> {
		const boundedLimit = Math.min(DEFAULT_HEALTH_HISTORY_LIMIT, positiveInteger(limit, 'history limit'))
		const { results } = await this.db
			.prepare(`SELECT * FROM health_observations WHERE check_id = ?
				ORDER BY observed_at DESC, id DESC LIMIT ?`)
			.bind(checkId, boundedLimit)
			.all<HealthObservationDatabaseRow>()
		return results.map(healthObservationRow)
	}

	async getTelemetryState(sourceId: string): Promise<HealthState | null> {
		const row = await this.db.prepare('SELECT state FROM current_telemetry_health WHERE source_id = ?')
			.bind(sourceId)
			.first<{ state: string }>()
		return row === null ? null : healthState(row.state)
	}

	async listEnabledSourceIds(): Promise<string[]> {
		const { results } = await this.db
			.prepare('SELECT id FROM sources WHERE enabled = 1 ORDER BY id')
			.all<{ id: string }>()
		return results.map((row) => row.id)
	}

	async recordTelemetryObservation(input: {
		id: string
		sourceId: string
		evaluated: EvaluatedTelemetryHealth
		transition: HealthTransition | null
		historyLimit?: number
	}): Promise<void> {
		const historyLimit = positiveInteger(input.historyLimit ?? DEFAULT_HEALTH_HISTORY_LIMIT, 'history limit')
		const payload = JSON.stringify(input.evaluated)
		const statements = [
			this.db
				.prepare(`INSERT INTO telemetry_health_observations
					(id, source_id, state, observed_at, payload, transition_id)
					VALUES (?, ?, ?, ?, ?, ?)`)
				.bind(
					input.id,
					input.sourceId,
					input.evaluated.state,
					input.evaluated.observedAt,
					payload,
					input.transition?.id ?? null,
				),
			this.db
				.prepare(`INSERT INTO current_telemetry_health
					(source_id, state, observed_at, payload, transition_id)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (source_id) DO UPDATE SET
						state = excluded.state,
						observed_at = excluded.observed_at,
						payload = excluded.payload,
						transition_id = excluded.transition_id
					WHERE current_telemetry_health.observed_at <= excluded.observed_at`)
				.bind(
					input.sourceId,
					input.evaluated.state,
					input.evaluated.observedAt,
					payload,
					input.transition?.id ?? null,
				),
		]
		if (input.transition !== null) {
			statements.push(
				this.db
					.prepare(`INSERT INTO health_transitions
						(id, source_id, check_id, kind, from_state, to_state, occurred_at)
						VALUES (?, ?, NULL, ?, ?, ?, ?)
						ON CONFLICT (id) DO NOTHING`)
					.bind(
						input.transition.id,
						input.sourceId,
						input.transition.kind,
						input.transition.from,
						input.transition.to,
						input.transition.at,
					),
			)
		}
		statements.push(
			this.db
				.prepare(`DELETE FROM telemetry_health_observations
					WHERE source_id = ? AND id NOT IN (
						SELECT id FROM telemetry_health_observations WHERE source_id = ?
						ORDER BY observed_at DESC, id DESC LIMIT ?
					)`)
				.bind(input.sourceId, input.sourceId, historyLimit),
		)
		await this.db.batch(statements)
	}

	async enqueueTransitionAlerts(transition: HealthTransition): Promise<EnqueueHealthAlertsResult> {
		const { results: channels } = await this.db
			.prepare(`SELECT channel.id, channel.type
				FROM notification_channels channel
				JOIN alert_rules rule
					ON rule.source_id = channel.source_id AND rule.type = channel.scope AND rule.enabled = 1
				WHERE channel.source_id = ? AND channel.scope = ? AND channel.enabled = 1
				ORDER BY channel.id`)
			.bind(transition.sourceId, transition.kind)
			.all<ChannelRow>()
		let enqueued = 0
		let deferredEmail = 0
		for (const channel of channels) {
			if (channel.type === 'email') {
				deferredEmail++
				continue
			}
			if (channel.type !== 'webhook') continue
			const dedupKey = healthAlertDedupKey(transition, channel.id)
			const result = await this.db
				.prepare(`INSERT INTO notification_outbox
					(id, dedup_key, source_id, channel_id, kind, payload, created_at, attempts, max_attempts, visible_at,
						claimed_until, claim_token, delivered_at, abandoned_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 0, 6, ?, NULL, NULL, NULL, NULL)
					ON CONFLICT (dedup_key) DO NOTHING`)
				.bind(
					uuidv7(this.now()),
					dedupKey,
					transition.sourceId,
					channel.id,
					transition.kind,
					JSON.stringify({
						transitionId: transition.id,
						sourceId: transition.sourceId,
						checkId: transition.checkId,
						kind: transition.kind,
						from: transition.from,
						to: transition.to,
						at: transition.at,
					}),
					this.now(),
					this.now(),
				)
				.run()
			enqueued += result.meta.changes
		}
		return { enqueued, deferredEmail }
	}
}

export class SqliteHealthRepository extends HealthRepository {
	protected claimSql(): string {
		return `UPDATE health_checks SET claimed_until = ?, claim_token = ?
			WHERE id IN (
				SELECT id FROM health_checks
				WHERE enabled = 1 AND due_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
				ORDER BY due_at, id LIMIT ?
			)
			RETURNING *`
	}
}

export class PostgresHealthRepository extends HealthRepository {
	protected claimSql(): string {
		return `UPDATE health_checks SET claimed_until = ?, claim_token = ?
			WHERE id IN (
				SELECT id FROM health_checks
				WHERE enabled = 1 AND due_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
				ORDER BY due_at, id LIMIT ?
				FOR UPDATE SKIP LOCKED
			)
			RETURNING *`
	}
}

function healthCheckRow(row: HealthCheckRow): HealthCheckRow {
	return {
		...row,
		interval_ms: number(row.interval_ms, 'health_checks.interval_ms'),
		timeout_ms: number(row.timeout_ms, 'health_checks.timeout_ms'),
		stale_after_ms: number(row.stale_after_ms, 'health_checks.stale_after_ms'),
		due_at: number(row.due_at, 'health_checks.due_at'),
		claimed_until: row.claimed_until === null ? null : number(row.claimed_until, 'health_checks.claimed_until'),
		created_at: number(row.created_at, 'health_checks.created_at'),
		updated_at: number(row.updated_at, 'health_checks.updated_at'),
	}
}

function currentHealthRow(row: CurrentHealthDatabaseRow): CurrentHealthRow {
	const state = healthState(row.state)
	if (state === 'stale' || state === 'unavailable') throw new Error('stored HTTP health state is not a transition state')
	return {
		checkId: row.check_id,
		state,
		observedAt: number(row.observed_at, 'current_health.observed_at'),
		latencyMs: row.latency_ms === null ? null : number(row.latency_ms, 'current_health.latency_ms'),
		detailCode: detailCode(row.detail_code),
		consecutiveFailures: row.consecutive_failures,
		consecutiveSuccesses: row.consecutive_successes,
		transitionId: row.transition_id,
	}
}

function healthObservationRow(row: HealthObservationDatabaseRow): HealthObservationRow {
	return {
		id: row.id,
		checkId: row.check_id,
		state: healthState(row.state),
		observedAt: number(row.observed_at, 'health_observations.observed_at'),
		latencyMs: row.latency_ms === null ? null : number(row.latency_ms, 'health_observations.latency_ms'),
		detailCode: row.detail_code,
		successful: row.successful === 1,
		statusCode: row.status_code,
		transitionId: row.transition_id,
	}
}

function healthState(value: string): HealthState {
	if (value === 'healthy' || value === 'degraded' || value === 'failed' || value === 'stale' || value === 'unavailable') return value
	throw new Error('invalid stored health state')
}

function detailCode(value: string): HttpCheckDetailCode {
	if (
		value === 'ok'
		|| value === 'unexpected_status'
		|| value === 'redirect'
		|| value === 'timeout'
		|| value === 'cancelled'
		|| value === 'network_error'
	) return value
	throw new Error('invalid stored health detail code')
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`)
	return value
}

function number(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error(`invalid numeric ${field}`)
	return parsed
}
