import type {
	OperationsHealthCheckDto,
	OperationsHealthCheckUpsertRequestDto,
	OperationsHealthResponseDto,
	OperationsSourceHealthDto,
} from '@fabrika/operations-contract/operator-api'
import type { HealthCheckRow } from '../health-repository.js'
import { visibleHealthState } from '../health.js'
import type { SourceRow } from '../repositories.js'
import { uuidv7 } from '../uuid.js'
import { authorizedSources, visibleSource } from './access.js'
import type { OperationsOperatorOptions } from './context.js'
import { notFoundError } from './errors.js'
import { sourceDto } from './sources.js'
import { now, numeric } from './values.js'

export async function healthOverview(options: OperationsOperatorOptions): Promise<OperationsHealthResponseDto> {
	const sources = await authorizedSources(options, 'operations.read')
	return {
		sources: await Promise.all(sources.map((source) => healthForSource(source, options))),
	}
}

export async function sourceHealth(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsSourceHealthDto> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return healthForSource(source, options)
}

export async function createHealthCheck(
	sourceId: string,
	input: OperationsHealthCheckUpsertRequestDto,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const checkId = uuidv7(now(options))
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.create', resourceType: 'operations_health_check', resourceId: checkId })
	return { id: checkId }
}

export async function updateHealthCheck(
	sourceId: string,
	checkId: string,
	input: OperationsHealthCheckUpsertRequestDto,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFoundError()
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.update', resourceType: 'operations_health_check', resourceId: checkId })
	return { id: checkId }
}

export async function deleteHealthCheck(sourceId: string, checkId: string, options: OperationsOperatorOptions): Promise<null> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFoundError()
	if (!await options.health.deleteCheck(sourceId, checkId)) return notFoundError()
	await options.auth.audit({ action: 'operations.health_check.delete', resourceType: 'operations_health_check', resourceId: checkId })
	return null
}

async function healthForSource(source: SourceRow, options: OperationsOperatorOptions): Promise<OperationsSourceHealthDto> {
	const checks = await options.health.listChecks(source.id)
	const telemetryState = await options.health.getTelemetryState(source.id)
	return {
		source: sourceDto(source),
		httpChecks: await Promise.all(checks.map((check) => healthCheckDto(check, options))),
		telemetryState: telemetryState ?? 'unavailable',
	}
}

async function healthCheckDto(check: HealthCheckRow, options: OperationsOperatorOptions): Promise<OperationsHealthCheckDto> {
	const [current, history] = await Promise.all([
		options.health.getCurrent(check.id),
		options.health.history(check.id, 20),
	])
	const currentDto = current === null
		? null
		: {
			state: current.state,
			observedAt: current.observedAt,
			latencyMs: current.latencyMs,
			detailCode: current.detailCode,
			consecutiveFailures: current.consecutiveFailures,
			consecutiveSuccesses: current.consecutiveSuccesses,
		}
	const visibleState = current === null ? null : visibleHealthState(current, now(options), numeric(check.stale_after_ms))
	if (visibleState === 'unavailable') throw new Error('stored HTTP health unexpectedly resolved as unavailable')
	return {
		id: check.id,
		sourceId: check.source_id,
		path: check.path,
		enabled: check.enabled === 1,
		intervalMs: numeric(check.interval_ms),
		timeoutMs: numeric(check.timeout_ms),
		expectedStatus: check.expected_status,
		failureThreshold: check.failure_threshold,
		recoveryThreshold: check.recovery_threshold,
		staleAfterMs: numeric(check.stale_after_ms),
		current: currentDto === null
			? null
			: { ...currentDto, state: visibleState ?? currentDto.state },
		history: history.map((item) => ({
			id: item.id,
			state: item.state,
			observedAt: item.observedAt,
			latencyMs: item.latencyMs,
			detailCode: item.detailCode,
			successful: item.successful,
			statusCode: item.statusCode,
		})),
	}
}
