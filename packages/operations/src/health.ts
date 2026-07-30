export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000
export const MAX_HEALTH_TIMEOUT_MS = 30_000
export const DEFAULT_FAILURE_THRESHOLD = 3
export const DEFAULT_RECOVERY_THRESHOLD = 2
export const DEFAULT_HEALTH_HISTORY_LIMIT = 100

export type HealthState = 'healthy' | 'degraded' | 'failed' | 'stale' | 'unavailable'
export type HealthAlertKind = 'failed_check' | 'recovery' | 'unhealthy_telemetry'

export interface HttpHealthCheck {
	publicOrigin: string
	path: string
	expectedStatus: number
	timeoutMs?: number
	failureThreshold?: number
	recoveryThreshold?: number
}

export type HttpCheckDetailCode = 'ok' | 'unexpected_status' | 'redirect' | 'timeout' | 'cancelled' | 'network_error'

export interface HttpCheckAttempt {
	successful: boolean
	observedAt: number
	latencyMs: number
	status: number | null
	detailCode: HttpCheckDetailCode
}

export interface CurrentHttpHealth {
	state: Exclude<HealthState, 'stale' | 'unavailable'>
	observedAt: number
	latencyMs: number | null
	detailCode: HttpCheckDetailCode
	consecutiveFailures: number
	consecutiveSuccesses: number
	transitionId: string | null
}

export interface HealthTransition {
	id: string
	sourceId: string
	checkId: string | null
	kind: HealthAlertKind
	from: HealthState | null
	to: HealthState
	at: number
}

export interface HttpHealthDecision {
	current: CurrentHttpHealth
	transition: Omit<HealthTransition, 'sourceId' | 'checkId'> | null
}

export type HealthFetch = (request: Request) => Promise<Response>

export function resolveHealthCheckUrl(publicOrigin: string, path: string): URL {
	const origin = new URL(publicOrigin)
	if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.username !== '' || origin.password !== '') {
		throw new RangeError('publicOrigin must be an HTTP origin without credentials')
	}
	if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
		throw new RangeError('publicOrigin must not include a path, query, or fragment')
	}
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
		throw new RangeError('health check path must be a same-origin relative path')
	}
	const target = new URL(path, origin)
	if (target.origin !== origin.origin || target.username !== '' || target.password !== '') {
		throw new RangeError('health check path must remain on publicOrigin')
	}
	return target
}

export async function runHttpHealthCheck(
	check: HttpHealthCheck,
	options: { fetch?: HealthFetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<HttpCheckAttempt> {
	const target = resolveHealthCheckUrl(check.publicOrigin, check.path)
	const timeoutMs = positiveInteger(check.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS, 'timeout')
	if (timeoutMs > MAX_HEALTH_TIMEOUT_MS) throw new RangeError('timeout exceeds the health-check limit')
	const expectedStatus = positiveInteger(check.expectedStatus, 'expected status')
	if (expectedStatus < 100 || expectedStatus > 599) throw new RangeError('expected status must be an HTTP status')

	const fetcher = options.fetch ?? ((request: Request) => globalThis.fetch(request))
	const now = options.now ?? Date.now
	const startedAt = now()
	const controller = new AbortController()
	let timedOut = false
	let cancelled = false
	const cancel = () => {
		cancelled = true
		controller.abort()
	}
	options.signal?.addEventListener('abort', cancel, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)

	try {
		const response = await fetcher(
			new Request(target, {
				method: 'GET',
				headers: { accept: '*/*' },
				redirect: 'manual',
				signal: controller.signal,
			}),
		)
		const observedAt = now()
		const latencyMs = Math.max(0, observedAt - startedAt)
		await cancelResponse(response)
		if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
			return { successful: false, observedAt, latencyMs, status: response.status || null, detailCode: 'redirect' }
		}
		if (response.status !== expectedStatus) {
			return { successful: false, observedAt, latencyMs, status: response.status, detailCode: 'unexpected_status' }
		}
		return { successful: true, observedAt, latencyMs, status: response.status, detailCode: 'ok' }
	} catch {
		const observedAt = now()
		return {
			successful: false,
			observedAt,
			latencyMs: Math.max(0, observedAt - startedAt),
			status: null,
			detailCode: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'network_error',
		}
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener('abort', cancel)
	}
}

async function cancelResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel()
	} catch {
		// A response body may already be closed; health checks never consume it.
	}
}

export function decideHttpHealth(
	prior: CurrentHttpHealth | null,
	attempt: HttpCheckAttempt,
	transitionId: string,
	input: { failureThreshold?: number; recoveryThreshold?: number } = {},
): HttpHealthDecision {
	const failureThreshold = positiveInteger(input.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD, 'failure threshold')
	const recoveryThreshold = positiveInteger(input.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD, 'recovery threshold')

	if (!attempt.successful) {
		const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1
		const state = consecutiveFailures >= failureThreshold ? 'failed' : 'degraded'
		const transition: HttpHealthDecision['transition'] = state === 'failed' && prior?.state !== 'failed'
			? { id: transitionId, kind: 'failed_check', from: prior?.state ?? null, to: state, at: attempt.observedAt }
			: null
		return {
			current: {
				state,
				observedAt: attempt.observedAt,
				latencyMs: attempt.latencyMs,
				detailCode: attempt.detailCode,
				consecutiveFailures,
				consecutiveSuccesses: 0,
				transitionId: transition?.id ?? prior?.transitionId ?? null,
			},
			transition,
		}
	}

	const recovering = prior !== null && prior.state !== 'healthy'
	const consecutiveSuccesses = recovering ? prior.consecutiveSuccesses + 1 : recoveryThreshold
	const state = recovering && consecutiveSuccesses < recoveryThreshold
		? prior.state === 'failed'
			? 'failed'
			: 'degraded'
		: 'healthy'
	const transition: HttpHealthDecision['transition'] = state === 'healthy' && prior?.state === 'failed'
		? { id: transitionId, kind: 'recovery', from: prior.state, to: state, at: attempt.observedAt }
		: null
	return {
		current: {
			state,
			observedAt: attempt.observedAt,
			latencyMs: attempt.latencyMs,
			detailCode: attempt.detailCode,
			consecutiveFailures: 0,
			consecutiveSuccesses,
			transitionId: transition?.id ?? prior?.transitionId ?? null,
		},
		transition,
	}
}

export function visibleHealthState(current: CurrentHttpHealth | null, now: number, staleAfterMs: number): HealthState {
	if (current === null) return 'unavailable'
	positiveInteger(staleAfterMs, 'stale interval')
	if (now - current.observedAt > staleAfterMs) return 'stale'
	return current.state
}

export type TelemetryValue<T> =
	| { available: true; value: T }
	| { available: false; reason: string }

export interface TelemetryHealthObservation {
	observedAt: number
	processed: TelemetryValue<{ count: number; lastProcessedAt: number | null }>
	dlq: TelemetryValue<{ count: number }>
	rejects: TelemetryValue<{ accepted: number; rejected: number }>
	queue: TelemetryValue<{ backlog: number; oldestAgeMs: number | null }>
}

export interface TelemetryThresholds {
	freshnessMs: number
	maxDlq: number
	maxRejectRate: number
	minRejectVolume: number
	maxQueueBacklog: number
	maxQueueAgeMs: number
}

export interface EvaluatedTelemetryHealth {
	state: HealthState
	observedAt: number
	reasons: string[]
	observation: TelemetryHealthObservation
}

export interface TelemetryHealthAdapter {
	observe(input: { sourceId: string; signal?: AbortSignal }): Promise<TelemetryHealthObservation>
}

export function unavailableTelemetryValue<T>(reason: string): TelemetryValue<T> {
	return { available: false, reason }
}

export function evaluateTelemetryHealth(
	observation: TelemetryHealthObservation,
	thresholds: TelemetryThresholds,
): EvaluatedTelemetryHealth {
	const reasons: string[] = []
	const available = [observation.processed, observation.dlq, observation.rejects, observation.queue].filter((metric) => metric.available).length
	if (available === 0) return { state: 'unavailable', observedAt: observation.observedAt, reasons: ['adapter_unavailable'], observation }

	if (observation.dlq.available && observation.dlq.value.count > thresholds.maxDlq) reasons.push('dead_letters')
	if (observation.processed.available) {
		const last = observation.processed.value.lastProcessedAt
		if (last === null || observation.observedAt - last > thresholds.freshnessMs) reasons.push('stale_processing')
	}
	if (observation.rejects.available) {
		const volume = observation.rejects.value.accepted + observation.rejects.value.rejected
		if (volume >= thresholds.minRejectVolume && observation.rejects.value.rejected / volume > thresholds.maxRejectRate) {
			reasons.push('reject_rate')
		}
	}
	if (observation.queue.available) {
		if (observation.queue.value.backlog > thresholds.maxQueueBacklog) reasons.push('queue_backlog')
		const oldest = observation.queue.value.oldestAgeMs
		if (oldest !== null && oldest > thresholds.maxQueueAgeMs) reasons.push('queue_age')
	}

	const state: HealthState = reasons.includes('dead_letters')
		? 'failed'
		: reasons.includes('stale_processing')
		? 'stale'
		: reasons.length > 0
		? 'degraded'
		: 'healthy'
	return { state, observedAt: observation.observedAt, reasons, observation }
}

export function decideTelemetryTransition(
	sourceId: string,
	prior: HealthState | null,
	current: EvaluatedTelemetryHealth,
	transitionId: string,
): HealthTransition | null {
	if (prior === current.state) return null
	if (current.state === 'healthy') {
		if (prior === null || prior === 'healthy') return null
		return { id: transitionId, sourceId, checkId: null, kind: 'recovery', from: prior, to: current.state, at: current.observedAt }
	}
	return {
		id: transitionId,
		sourceId,
		checkId: null,
		kind: 'unhealthy_telemetry',
		from: prior,
		to: current.state,
		at: current.observedAt,
	}
}

export function healthAlertDedupKey(transition: HealthTransition, channelId: string): string {
	return `health:${transition.id}:${transition.kind}:${channelId}`
}

export const EMAIL_DELIVERY_SUPPORT = {
	supported: false,
	reason: 'No runtime-neutral email transport is approved for both Cloudflare and Bun compositions.',
	evidence: 'docs/sprints/sprint-2026-07-30-operations-plane.md and import/poplach-source-inventory.ts',
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`)
	return value
}
