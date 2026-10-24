import type { OperationsHealthCheckDto, OperationsHealthState, OperationsSourceHealthDto } from '@fabrika/operations-contract/operator-api'
import type { Lamp } from '../components/Status'

export function healthLamp(state: OperationsHealthState | 'disabled' | 'unknown' | 'unmonitored'): Lamp {
	if (state === 'healthy') return 'ok'
	if (state === 'failed') return 'stop'
	if (state === 'degraded') return 'run'
	return 'idle'
}

/** A stored success is no current evidence after the check's freshness deadline. */
export function healthCheckState(check: OperationsHealthCheckDto, now = Date.now()): OperationsHealthState | 'disabled' {
	if (!check.enabled) return 'disabled'
	if (check.current === null) return 'unavailable'
	if (now - check.current.observedAt > check.staleAfterMs) return 'stale'
	return check.current.state
}

export interface RuntimeHealth {
	state: OperationsHealthState | 'unknown' | 'unmonitored'
	lamp: Lamp
	label: string
	note: string
	monitored: boolean
}

/** HTTP availability and telemetry are different signals. Healthy telemetry never makes an HTTP check healthy. */
export function runtimeHealth(sources: readonly OperationsSourceHealthDto[] | null, now = Date.now()): RuntimeHealth {
	if (sources === null) return { state: 'unknown', lamp: healthLamp('unknown'), label: 'Unknown', note: 'Health is not readable', monitored: false }
	const checks = sources.flatMap((source) => source.source.enabled ? source.httpChecks.filter((check) => check.enabled) : [])
	if (checks.length === 0) {
		return { state: 'unmonitored', lamp: healthLamp('unmonitored'), label: 'Not monitored', note: 'No enabled HTTP check', monitored: false }
	}
	const states = checks.map((check) => healthCheckState(check, now))
	if (states.includes('failed')) return { state: 'failed', lamp: healthLamp('failed'), label: 'Failing', note: 'HTTP check failed', monitored: true }
	if (states.includes('degraded')) {
		return { state: 'degraded', lamp: healthLamp('degraded'), label: 'Degraded', note: 'HTTP check is degraded', monitored: true }
	}
	if (states.includes('stale') || states.includes('unavailable')) {
		const state = states.includes('stale') ? 'stale' : 'unavailable'
		return {
			state,
			lamp: healthLamp(state),
			label: 'Unknown',
			note: state === 'stale' ? 'HTTP checks are stale' : 'Waiting for an HTTP check',
			monitored: true,
		}
	}
	const oldest = Math.min(...checks.map((check) => check.current?.observedAt ?? now))
	return {
		state: 'healthy',
		lamp: healthLamp('healthy'),
		label: 'Healthy',
		note: `Checked ${Math.max(0, Math.floor((now - oldest) / 1000))}s ago`,
		monitored: true,
	}
}

export function unhealthyTelemetry(source: OperationsSourceHealthDto): boolean {
	return source.source.enabled && source.telemetryState !== 'healthy'
}

export function needsMonitoringAttention(source: OperationsSourceHealthDto, now = Date.now()): boolean {
	if (!source.source.enabled) return false
	const health = runtimeHealth([source], now)
	return unhealthyTelemetry(source) || (health.monitored && health.state !== 'healthy')
}
