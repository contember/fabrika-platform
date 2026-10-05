import { describe, expect, test } from 'bun:test'
import {
	decideHttpHealth,
	decideTelemetryTransition,
	DEFAULT_FAILURE_THRESHOLD,
	DEFAULT_HEALTH_TIMEOUT_MS,
	DEFAULT_RECOVERY_THRESHOLD,
	evaluateTelemetryHealth,
	healthAlertDedupKey,
	type HealthState,
	type HttpCheckAttempt,
	resolveHealthCheckUrl,
	runHttpHealthCheck,
	type TelemetryHealthObservation,
	unavailableTelemetryValue,
	visibleHealthState,
} from '../health.js'

function attempt(successful: boolean, observedAt: number): HttpCheckAttempt {
	return {
		successful,
		observedAt,
		latencyMs: 10,
		status: successful ? 200 : 503,
		detailCode: successful ? 'ok' : 'unexpected_status',
	}
}

describe('HTTP health state', () => {
	test('uses three failures and two recovery successes by default without alert storms', () => {
		expect(DEFAULT_FAILURE_THRESHOLD).toBe(3)
		expect(DEFAULT_RECOVERY_THRESHOLD).toBe(2)
		let current = decideHttpHealth(null, attempt(true, 1), 'initial').current
		expect(current.state).toBe('healthy')

		const first = decideHttpHealth(current, attempt(false, 2), 'failure-1')
		expect(first.current.state).toBe('degraded')
		expect(first.transition).toBeNull()
		current = first.current

		const second = decideHttpHealth(current, attempt(false, 3), 'failure-2')
		expect(second.current.state).toBe('degraded')
		expect(second.transition).toBeNull()
		current = second.current

		const failed = decideHttpHealth(current, attempt(false, 4), 'failed-transition')
		expect(failed.current.state).toBe('failed')
		expect(failed.transition?.kind).toBe('failed_check')
		current = failed.current

		const continuing = decideHttpHealth(current, attempt(false, 5), 'must-not-fire')
		expect(continuing.current.state).toBe('failed')
		expect(continuing.transition).toBeNull()
		current = continuing.current

		const recovering = decideHttpHealth(current, attempt(true, 6), 'recovery-1')
		expect(recovering.current.state).toBe('failed')
		expect(recovering.transition).toBeNull()
		current = recovering.current

		const recovered = decideHttpHealth(current, attempt(true, 7), 'recovered-transition')
		expect(recovered.current.state).toBe('healthy')
		expect(recovered.transition?.kind).toBe('recovery')
	})

	test('projects missing and old observations to unavailable and stale', () => {
		expect(visibleHealthState(null, 10_000, 1_000)).toBe('unavailable')
		const current = decideHttpHealth(null, attempt(true, 1_000), 'initial').current
		expect(visibleHealthState(current, 2_000, 1_000)).toBe('healthy')
		expect(visibleHealthState(current, 2_001, 1_000)).toBe('stale')
	})
})

describe('safe HTTP check runner', () => {
	test('accepts only a relative path on the trusted public origin', () => {
		expect(resolveHealthCheckUrl('https://app.example.test', '/health?deep=1').toString()).toBe(
			'https://app.example.test/health?deep=1',
		)
		for (const unsafe of ['https://internal.test/health', '//internal.test/health', '/\\internal.test/health', 'health']) {
			expect(() => resolveHealthCheckUrl('https://app.example.test', unsafe)).toThrow()
		}
		expect(() => resolveHealthCheckUrl('https://user:secret@app.example.test', '/health')).toThrow()
		expect(() => resolveHealthCheckUrl('file:///tmp/app', '/health')).toThrow()
	})

	test('rejects redirects and cancels response bodies without reading them', async () => {
		let cancelled = false
		const seen: { redirect?: RequestRedirect } = {}
		const result = await runHttpHealthCheck(
			{ publicOrigin: 'https://app.example.test', path: '/health', expectedStatus: 200 },
			{
				fetch: (request) => {
					seen.redirect = request.redirect
					return Promise.resolve(
						new Response(
							new ReadableStream({
								cancel() {
									cancelled = true
								},
							}),
							{ status: 302, headers: { location: 'https://internal.test/' } },
						),
					)
				},
				now: () => 100,
			},
		)
		expect(seen.redirect).toBe('manual')
		expect(result.detailCode).toBe('redirect')
		expect(cancelled).toBe(true)
	})

	test('times out a hanging request', async () => {
		expect(DEFAULT_HEALTH_TIMEOUT_MS).toBe(5_000)
		const result = await runHttpHealthCheck(
			{ publicOrigin: 'https://app.example.test', path: '/health', expectedStatus: 200, timeoutMs: 1 },
			{
				fetch: (request) =>
					new Promise((_resolve, reject) => {
						request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
					}),
			},
		)
		expect(result.detailCode).toBe('timeout')
		await expect(
			runHttpHealthCheck({
				publicOrigin: 'https://app.example.test',
				path: '/health',
				expectedStatus: 200,
				timeoutMs: 30_001,
			}),
		).rejects.toThrow('timeout exceeds')
	})
})

describe('telemetry health', () => {
	const thresholds = {
		freshnessMs: 60_000,
		maxDlq: 0,
		maxRejectRate: 0.2,
		minRejectVolume: 20,
		maxQueueBacklog: 100,
		maxQueueAgeMs: 30_000,
	}

	test('keeps unavailable adapter facts explicit', () => {
		const unavailable = unavailableTelemetryValue<number>('provider credentials not configured')
		const evaluated = evaluateTelemetryHealth({
			observedAt: 100,
			processed: unavailableTelemetryValue('store unavailable'),
			dlq: unavailableTelemetryValue('store unavailable'),
			rejects: unavailableTelemetryValue('adapter unavailable'),
			queue: unavailableTelemetryValue('adapter unavailable'),
		}, thresholds)
		expect(unavailable).toEqual({ available: false, reason: 'provider credentials not configured' })
		expect(evaluated.state).toBe('unavailable')
		expect(evaluated.reasons).toEqual(['adapter_unavailable'])
	})

	test('derives DLQ, reject, and queue failures without inferring failure from error silence', () => {
		const evaluated = evaluateTelemetryHealth({
			observedAt: 100_000,
			processed: { available: true, value: { count: 30, lastProcessedAt: 10_000 } },
			dlq: { available: true, value: { count: 1 } },
			rejects: { available: true, value: { accepted: 20, rejected: 10 } },
			queue: { available: true, value: { backlog: 101, oldestAgeMs: 31_000 } },
		}, thresholds)
		expect(evaluated.state).toBe('failed')
		expect(evaluated.reasons).toEqual(['dead_letters', 'reject_rate', 'queue_backlog', 'queue_age'])
	})

	test('keeps empty and quiet sources healthy when all measurements are available', () => {
		for (const processed of [{ count: 0, lastProcessedAt: null }, { count: 30, lastProcessedAt: 10_000 }]) {
			const evaluated = evaluateTelemetryHealth({
				observedAt: 100_000,
				processed: { available: true, value: processed },
				dlq: { available: true, value: { count: 0 } },
				rejects: { available: true, value: { accepted: 0, rejected: 0 } },
				queue: { available: true, value: { backlog: 0, oldestAgeMs: null } },
			}, thresholds)
			expect(evaluated.state).toBe('healthy')
			expect(evaluated.reasons).toEqual([])
			expect(decideTelemetryTransition('source-a', null, evaluated, 'initial')).toBeNull()
		}
	})

	test('never claims missing measurements healthy or alerts unavailability as failure or recovery', () => {
		const observation: TelemetryHealthObservation = {
			observedAt: 100_000,
			processed: { available: true, value: { count: 30, lastProcessedAt: 10_000 } },
			dlq: { available: true, value: { count: 0 } },
			rejects: { available: true, value: { accepted: 0, rejected: 0 } },
			queue: { available: true, value: { backlog: 0, oldestAgeMs: null } },
		}
		const priors: (HealthState | null)[] = [null, 'healthy', 'degraded', 'failed', 'stale', 'unavailable']
		for (const metric of ['processed', 'dlq', 'rejects', 'queue']) {
			const evaluated = evaluateTelemetryHealth({ ...observation, [metric]: unavailableTelemetryValue('missing measurement') }, thresholds)
			expect(evaluated.state).toBe('unavailable')
			expect(evaluated.reasons).toEqual(['adapter_unavailable'])
			for (const prior of priors) {
				expect(decideTelemetryTransition('source-a', prior, evaluated, 'unavailable')).toBeNull()
			}
		}
		const healthy = evaluateTelemetryHealth(observation, thresholds)
		expect(decideTelemetryTransition('source-a', 'unavailable', healthy, 'available')).toBeNull()
		expect(decideTelemetryTransition('source-a', 'stale', healthy, 'quiet')).toBeNull()
	})

	test('emits one unhealthy transition and includes the channel in dedup identity', () => {
		const evaluated = evaluateTelemetryHealth({
			observedAt: 100,
			processed: { available: true, value: { count: 1, lastProcessedAt: 100 } },
			dlq: { available: true, value: { count: 1 } },
			rejects: unavailableTelemetryValue('unavailable'),
			queue: unavailableTelemetryValue('unavailable'),
		}, thresholds)
		const transition = decideTelemetryTransition('source-a', 'healthy', evaluated, 'transition-a')
		if (transition === null) throw new Error('expected transition')
		expect(transition.kind).toBe('unhealthy_telemetry')
		expect(decideTelemetryTransition('source-a', evaluated.state, evaluated, 'transition-b')).toBeNull()
		expect(healthAlertDedupKey(transition, 'channel-a')).not.toBe(healthAlertDedupKey(transition, 'channel-b'))
	})

	test('keeps known failures visible even when other measurements are unavailable', () => {
		const missing: TelemetryHealthObservation = {
			observedAt: 100_000,
			processed: unavailableTelemetryValue('store unavailable'),
			dlq: unavailableTelemetryValue('store unavailable'),
			rejects: unavailableTelemetryValue('adapter unavailable'),
			queue: unavailableTelemetryValue('adapter unavailable'),
		}
		const observations: TelemetryHealthObservation[] = [
			{ ...missing, dlq: { available: true, value: { count: 1 } } },
			{ ...missing, rejects: { available: true, value: { accepted: 20, rejected: 10 } } },
			{ ...missing, queue: { available: true, value: { backlog: 101, oldestAgeMs: null } } },
			{ ...missing, queue: { available: true, value: { backlog: 1, oldestAgeMs: 31_000 } } },
		]
		for (const observation of observations) {
			const evaluated = evaluateTelemetryHealth(observation, thresholds)
			expect(['failed', 'degraded']).toContain(evaluated.state)
			expect(evaluated.reasons).not.toContain('adapter_unavailable')
			expect(decideTelemetryTransition('source-a', 'unavailable', evaluated, 'failure')?.kind).toBe('unhealthy_telemetry')
		}
	})
})
