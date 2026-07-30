import type { ClaimedHealthCheck, EnqueueHealthAlertsResult, HealthRepository } from './health-repository.js'
import {
	decideHttpHealth,
	decideTelemetryTransition,
	evaluateTelemetryHealth,
	type HealthTransition,
	MAX_HEALTH_TIMEOUT_MS,
	runHttpHealthCheck,
	type TelemetryHealthAdapter,
	type TelemetryThresholds,
} from './health.js'
import { uuidv7 } from './uuid.js'

const DEFAULT_HTTP_BATCH_SIZE = 25
const DEFAULT_HTTP_CONCURRENCY = 5
const LEASE_OVERHEAD_MS = 30_000
const DEFAULT_ERROR_RETRY_MS = 30_000

const DEFAULT_TELEMETRY_THRESHOLDS: TelemetryThresholds = {
	freshnessMs: 15 * 60_000,
	maxDlq: 0,
	maxRejectRate: 0.2,
	minRejectVolume: 20,
	maxQueueBacklog: 1_000,
	maxQueueAgeMs: 5 * 60_000,
}

type HealthStore = Pick<
	HealthRepository,
	| 'claimDueChecks'
	| 'completeLease'
	| 'enqueueTransitionAlerts'
	| 'getCurrent'
	| 'getTelemetryState'
	| 'listEnabledSourceIds'
	| 'recordHttpObservation'
	| 'recordTelemetryObservation'
>

export interface OperationsHealthLogger {
	warn(message: string, fields: { sourceId?: string; checkId?: string }): void
}

export interface OperationsHealthExecutionOptions {
	fetch?: (request: Request) => Promise<Response>
	now?: () => number
	id?: (at: number) => string
	httpBatchSize?: number
	httpConcurrency?: number
	leaseMs?: number
	errorRetryMs?: number
	historyLimit?: number
	telemetry?: TelemetryHealthAdapter
	telemetryThresholds?: TelemetryThresholds
	logger?: OperationsHealthLogger
}

export interface OperationsHealthExecutionSummary {
	claimedChecks: number
	recordedChecks: number
	unavailableChecks: number
	cancelledChecks: number
	recordedTelemetry: number
	transitions: number
	enqueuedAlerts: number
	deferredEmail: number
	errors: number
}

const silentLogger: OperationsHealthLogger = { warn() {} }

/** One bounded health pass, shared by the Worker cron and the Bun scheduler command. */
export class OperationsHealthExecution {
	private readonly now: () => number
	private readonly id: (at: number) => string
	private readonly httpBatchSize: number
	private readonly httpConcurrency: number
	private readonly leaseMs: number
	private readonly errorRetryMs: number
	private readonly telemetryThresholds: TelemetryThresholds
	private readonly logger: OperationsHealthLogger

	constructor(
		private readonly store: HealthStore,
		private readonly options: OperationsHealthExecutionOptions = {},
	) {
		this.now = options.now ?? Date.now
		this.id = options.id ?? uuidv7
		this.httpBatchSize = positiveInteger(options.httpBatchSize ?? DEFAULT_HTTP_BATCH_SIZE, 'HTTP batch size')
		this.httpConcurrency = positiveInteger(options.httpConcurrency ?? DEFAULT_HTTP_CONCURRENCY, 'HTTP concurrency')
		if (this.httpConcurrency > this.httpBatchSize) throw new RangeError('HTTP concurrency cannot exceed the batch size')
		const minimumLeaseMs = Math.ceil(this.httpBatchSize / this.httpConcurrency) * MAX_HEALTH_TIMEOUT_MS + LEASE_OVERHEAD_MS
		this.leaseMs = positiveInteger(options.leaseMs ?? minimumLeaseMs, 'health lease')
		if (this.leaseMs < minimumLeaseMs) {
			throw new RangeError(`health lease must be at least ${minimumLeaseMs}ms for the configured batch and concurrency`)
		}
		this.errorRetryMs = positiveInteger(options.errorRetryMs ?? DEFAULT_ERROR_RETRY_MS, 'health retry')
		this.telemetryThresholds = options.telemetryThresholds ?? DEFAULT_TELEMETRY_THRESHOLDS
		this.logger = options.logger ?? silentLogger
	}

	async run(signal?: AbortSignal): Promise<OperationsHealthExecutionSummary> {
		const summary: OperationsHealthExecutionSummary = {
			claimedChecks: 0,
			recordedChecks: 0,
			unavailableChecks: 0,
			cancelledChecks: 0,
			recordedTelemetry: 0,
			transitions: 0,
			enqueuedAlerts: 0,
			deferredEmail: 0,
			errors: 0,
		}
		let checks: ClaimedHealthCheck[] = []
		try {
			checks = await this.store.claimDueChecks({ limit: this.httpBatchSize, leaseMs: this.leaseMs })
		} catch {
			summary.errors++
			this.logger.warn('health check claim failed', {})
		}
		summary.claimedChecks = checks.length
		for (let offset = 0; offset < checks.length; offset += this.httpConcurrency) {
			await Promise.all(checks.slice(offset, offset + this.httpConcurrency).map((check) => this.runCheck(check, summary, signal)))
		}
		if (this.options.telemetry !== undefined && !signal?.aborted) {
			await this.runTelemetry(this.options.telemetry, summary, signal)
		}
		return summary
	}

	private async runCheck(
		check: ClaimedHealthCheck,
		summary: OperationsHealthExecutionSummary,
		signal?: AbortSignal,
	): Promise<void> {
		let nextDueAt = this.now() + check.intervalMs
		try {
			if (check.publicOrigin === null) {
				summary.unavailableChecks++
				return
			}
			if (signal?.aborted) {
				summary.cancelledChecks++
				nextDueAt = this.now() + Math.min(check.intervalMs, this.errorRetryMs)
				return
			}
			const attempt = await runHttpHealthCheck({
				publicOrigin: check.publicOrigin,
				path: check.path,
				expectedStatus: check.expectedStatus,
				timeoutMs: check.timeoutMs,
			}, {
				...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
				...(signal === undefined ? {} : { signal }),
				now: this.now,
			})
			if (attempt.detailCode === 'cancelled' && signal?.aborted) {
				summary.cancelledChecks++
				nextDueAt = this.now() + Math.min(check.intervalMs, this.errorRetryMs)
				return
			}
			const prior = await this.store.getCurrent(check.id)
			const decision = decideHttpHealth(prior, attempt, this.id(attempt.observedAt), {
				failureThreshold: check.failureThreshold,
				recoveryThreshold: check.recoveryThreshold,
			})
			await this.store.recordHttpObservation({
				sourceId: check.sourceId,
				checkId: check.id,
				observationId: this.id(attempt.observedAt),
				attempt,
				decision,
				...(this.options.historyLimit === undefined ? {} : { historyLimit: this.options.historyLimit }),
			})
			summary.recordedChecks++
			if (decision.transition !== null) {
				summary.transitions++
				await this.enqueueAlerts({ ...decision.transition, sourceId: check.sourceId, checkId: check.id }, summary)
			}
			nextDueAt = attempt.observedAt + check.intervalMs
		} catch {
			summary.errors++
			nextDueAt = this.now() + Math.min(check.intervalMs, this.errorRetryMs)
			this.logger.warn('health check execution failed', { sourceId: check.sourceId, checkId: check.id })
		} finally {
			try {
				if (!(await this.store.completeLease({ checkId: check.id, claimToken: check.claimToken, nextDueAt }))) {
					summary.errors++
					this.logger.warn('health check lease was lost', { sourceId: check.sourceId, checkId: check.id })
				}
			} catch {
				summary.errors++
				this.logger.warn('health check lease release failed', { sourceId: check.sourceId, checkId: check.id })
			}
		}
	}

	private async runTelemetry(
		adapter: TelemetryHealthAdapter,
		summary: OperationsHealthExecutionSummary,
		signal?: AbortSignal,
	): Promise<void> {
		let sourceIds: string[]
		try {
			sourceIds = await this.store.listEnabledSourceIds()
		} catch {
			summary.errors++
			this.logger.warn('telemetry source enumeration failed', {})
			return
		}
		for (const sourceId of sourceIds) {
			if (signal?.aborted) break
			try {
				const observation = await adapter.observe({ sourceId, ...(signal === undefined ? {} : { signal }) })
				const evaluated = evaluateTelemetryHealth(observation, this.telemetryThresholds)
				const prior = await this.store.getTelemetryState(sourceId)
				const transition = decideTelemetryTransition(sourceId, prior, evaluated, this.id(observation.observedAt))
				await this.store.recordTelemetryObservation({
					id: this.id(observation.observedAt),
					sourceId,
					evaluated,
					transition,
					...(this.options.historyLimit === undefined ? {} : { historyLimit: this.options.historyLimit }),
				})
				summary.recordedTelemetry++
				if (transition !== null) {
					summary.transitions++
					await this.enqueueAlerts(transition, summary)
				}
			} catch {
				summary.errors++
				this.logger.warn('telemetry health execution failed', { sourceId })
			}
		}
	}

	private async enqueueAlerts(
		transition: HealthTransition,
		summary: OperationsHealthExecutionSummary,
	): Promise<void> {
		try {
			const result: EnqueueHealthAlertsResult = await this.store.enqueueTransitionAlerts(transition)
			summary.enqueuedAlerts += result.enqueued
			summary.deferredEmail += result.deferredEmail
		} catch {
			summary.errors++
			this.logger.warn('health transition alert enqueue failed', {
				sourceId: transition.sourceId,
				...(transition.checkId === null ? {} : { checkId: transition.checkId }),
			})
		}
	}
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`)
	return value
}
