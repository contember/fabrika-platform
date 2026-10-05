import { describe, expect, test } from 'bun:test'
import { SqliteHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
import { type TelemetryHealthObservation, unavailableTelemetryValue } from '../health.js'
import { OperationsMaintenance } from '../maintenance.js'
import { bunPipelineTelemetry, cloudflarePipelineTelemetry, StoredOperationsTelemetryAdapter } from '../telemetry.js'
import { createHarness } from './helpers/sqlite.js'

async function setup(now: () => number) {
	const harness = createHarness(now)
	await harness.repositories.sources.upsert({
		id: 'source-a',
		appId: 'app-a',
		environment: 'prod',
		displayName: 'App A',
		enabled: true,
		publicOrigin: 'https://app.example.test',
	})
	const health = new SqliteHealthRepository(harness.db, now)
	await health.upsertCheck({
		id: 'check-a',
		sourceId: 'source-a',
		path: '/healthz',
		enabled: true,
		intervalMs: 100,
		timeoutMs: 50,
		expectedStatus: 200,
		failureThreshold: 1,
		recoveryThreshold: 1,
		staleAfterMs: 300,
	})
	return { harness, health }
}

describe('Operations health execution', () => {
	test('records one failed and one recovered transition without alert storms', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		for (const kind of ['failed_check', 'recovery']) {
			await harness.repositories.alerts.setRule('source-a', kind, true)
			await harness.repositories.alerts.upsertChannel({
				id: `channel-${kind}`,
				sourceId: 'source-a',
				scope: kind,
				type: 'webhook',
				target: 'https://secret.example.test/hook',
				enabled: true,
			})
		}
		const statuses = [503, 200, 200]
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `health-id-${++nextId}`,
			historyLimit: 2,
			fetch: () => Promise.resolve(new Response(null, { status: statuses.shift() ?? 200 })),
		})

		expect(await execution.run()).toMatchObject({ recordedChecks: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
		now = 2_000
		expect(await execution.run()).toMatchObject({ recordedChecks: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
		now = 3_000
		expect(await execution.run()).toMatchObject({ recordedChecks: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })

		expect((await health.getCurrent('check-a'))?.state).toBe('healthy')
		expect((await health.history('check-a', 100)).map((row) => row.state)).toEqual(['healthy', 'healthy'])
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM health_transitions').get()?.count).toBe(2)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(2)

		const maintenance = new OperationsMaintenance(
			harness.repositories.alerts,
			{ send: () => Promise.reject(new Error('credential-bearing target failed')) },
			{ retryDelayMs: () => 1 },
		)
		expect((await maintenance.run()).notifications).toBe(2)
		expect((await health.getCurrent('check-a'))?.state).toBe('healthy')
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM health_observations').get()?.count).toBe(2)
		expect(
			harness.sqlite.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM notification_attempts WHERE delivered = 0',
			).get()?.count,
		).toBe(2)
	})

	test('releases a claimed check on persistence failure and schedules a bounded retry', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		harness.sqlite.exec('DROP TABLE health_observations')
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => 'failure-id',
			errorRetryMs: 25,
			fetch: () => Promise.resolve(new Response(null, { status: 200 })),
		})
		expect(await execution.run()).toMatchObject({ claimedChecks: 1, recordedChecks: 0, errors: 1 })
		expect(
			harness.sqlite.query<{ due_at: number; claimed_until: number | null; claim_token: string | null }, [string]>(
				'SELECT due_at, claimed_until, claim_token FROM health_checks WHERE id = ?',
			).get('check-a'),
		).toEqual({ due_at: 1_025, claimed_until: null, claim_token: null })
		now = 1_024
		expect((await execution.run()).claimedChecks).toBe(0)
	})

	test('keeps a source without a public origin unavailable without recording a failure', async () => {
		const now = 1_000
		const { harness, health } = await setup(() => now)
		harness.sqlite.query('UPDATE sources SET public_origin = NULL WHERE id = ?').run('source-a')
		let fetched = false
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			fetch: () => {
				fetched = true
				return Promise.resolve(new Response(null, { status: 503 }))
			},
		})
		expect(await execution.run()).toMatchObject({
			claimedChecks: 1,
			recordedChecks: 0,
			unavailableChecks: 1,
			transitions: 0,
			errors: 0,
		})
		expect(fetched).toBe(false)
		expect(await health.getCurrent('check-a')).toBeNull()
		expect(
			harness.sqlite.query<{ claimed_until: number | null; claim_token: string | null }, [string]>(
				'SELECT claimed_until, claim_token FROM health_checks WHERE id = ?',
			).get('check-a'),
		).toEqual({ claimed_until: null, claim_token: null })
	})

	test('bounds concurrency and refuses a lease shorter than the worst-case batch duration', async () => {
		const now = 0
		const { health } = await setup(() => now)
		await health.upsertCheck({
			id: 'check-b',
			sourceId: 'source-a',
			path: '/ready',
			enabled: true,
			intervalMs: 100,
			timeoutMs: 30_000,
			expectedStatus: 200,
			failureThreshold: 1,
			recoveryThreshold: 1,
			staleAfterMs: 300,
		})
		expect(() =>
			new OperationsHealthExecution(health, {
				httpBatchSize: 2,
				httpConcurrency: 1,
				leaseMs: 89_999,
			})
		).toThrow('health lease must be at least 90000ms')

		const firstStarted = Promise.withResolvers<void>()
		const secondStarted = Promise.withResolvers<void>()
		const firstResponse = Promise.withResolvers<Response>()
		const secondResponse = Promise.withResolvers<Response>()
		let started = 0
		let active = 0
		let peak = 0
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `lease-id-${++nextId}`,
			httpBatchSize: 2,
			httpConcurrency: 1,
			leaseMs: 90_000,
			fetch: async () => {
				started++
				active++
				peak = Math.max(peak, active)
				const response = started === 1 ? firstResponse : secondResponse
				const entered = started === 1 ? firstStarted : secondStarted
				entered.resolve()
				try {
					return await response.promise
				} finally {
					active--
				}
			},
		})
		const running = execution.run()
		const deadline = Promise.withResolvers<never>()
		const timer = setTimeout(() => deadline.reject(new Error('health checks did not complete')), 1_000)
		try {
			await Promise.race([firstStarted.promise, deadline.promise])
			expect(started).toBe(1)
			expect(active).toBe(1)
			firstResponse.resolve(new Response(null, { status: 200 }))
			await Promise.race([secondStarted.promise, deadline.promise])
			expect(active).toBe(1)
			secondResponse.resolve(new Response(null, { status: 200 }))
			expect(await Promise.race([running, deadline.promise])).toMatchObject({ claimedChecks: 2, recordedChecks: 2, errors: 0 })
			expect(started).toBe(2)
			expect(peak).toBe(1)
			expect(active).toBe(0)
		} finally {
			clearTimeout(timer)
			firstResponse.resolve(new Response(null, { status: 200 }))
			secondResponse.resolve(new Response(null, { status: 200 }))
			await running
		}
	})

	test('scheduler cancellation releases the lease without recording an application failure', async () => {
		const { health } = await setup(() => 1_000)
		const controller = new AbortController()
		controller.abort()
		let fetched = false
		const execution = new OperationsHealthExecution(health, {
			fetch: () => {
				fetched = true
				return Promise.resolve(new Response(null, { status: 503 }))
			},
		})
		expect(await execution.run(controller.signal)).toMatchObject({
			claimedChecks: 1,
			recordedChecks: 0,
			cancelledChecks: 1,
			transitions: 0,
			errors: 0,
		})
		expect(fetched).toBe(false)
		expect(await health.getCurrent('check-a')).toBeNull()
	})

	test('contains claim and telemetry enumeration failures in the pass summary', async () => {
		const { harness } = await setup(() => 1_000)
		harness.sqlite.exec('DROP TABLE health_checks')
		const claimFailure = new OperationsHealthExecution(new SqliteHealthRepository(harness.db), {})
		expect(await claimFailure.run()).toMatchObject({ claimedChecks: 0, errors: 1 })

		class FailingSourceListRepository extends SqliteHealthRepository {
			override listEnabledSourceIds(): Promise<string[]> {
				return Promise.reject(new Error('unavailable'))
			}
		}
		const listFailure = new OperationsHealthExecution(new FailingSourceListRepository(harness.db), {
			telemetry: new StoredOperationsTelemetryAdapter(harness.db, cloudflarePipelineTelemetry()),
		})
		expect(await listFailure.run()).toMatchObject({ recordedTelemetry: 0, errors: 2 })
	})
})

describe('portable telemetry adapters', () => {
	test('reports durable store facts and explicit unavailable provider facts', async () => {
		const { harness } = await setup(() => 5_000)
		for (const pipeline of [cloudflarePipelineTelemetry(), bunPipelineTelemetry()]) {
			const observation = await new StoredOperationsTelemetryAdapter(harness.db, pipeline, () => 5_000)
				.observe({ sourceId: 'source-a' })
			expect(observation.processed).toEqual({
				available: true,
				value: { count: 0, lastProcessedAt: null },
			})
			expect(observation.dlq).toEqual({ available: true, value: { count: 0 } })
			expect(observation.rejects.available).toBe(false)
			expect(observation.queue.available).toBe(false)
		}
	})

	test('reports processing time from applied occurrences rather than reception time', async () => {
		const { harness } = await setup(() => 5_000)
		await harness.repositories.ingest.record({
			sourceId: 'source-a',
			fingerprint: 'fingerprint-a',
			eventId: 'event-a',
			title: 'Error',
			culprit: null,
			level: 'error',
			release: null,
			receivedAt: 1_000,
			blobKey: 'event-a.json',
		})
		harness.sqlite.exec(`INSERT INTO occurrences
			(id, source_id, fingerprint, event_id, received_at, release, blob_key, applied_at)
			VALUES ('unapplied', 'source-a', 'fingerprint-a', 'unapplied', 6000, NULL, 'unapplied.json', NULL)`)
		const observation = await new StoredOperationsTelemetryAdapter(harness.db, bunPipelineTelemetry(), () => 7_000)
			.observe({ sourceId: 'source-a' })
		expect(observation.processed).toEqual({ available: true, value: { count: 1, lastProcessedAt: 5_000 } })
	})

	test('persists bounded empty and quiet source history without false unhealthy transitions or alerts', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		for (const kind of ['unhealthy_telemetry', 'recovery']) {
			await harness.repositories.alerts.setRule('source-a', kind, true)
			await harness.repositories.alerts.upsertChannel({
				id: `channel-${kind}`,
				sourceId: 'source-a',
				scope: kind,
				type: 'webhook',
				target: 'https://example.test/hook',
				enabled: true,
			})
		}
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `telemetry-id-${++nextId}`,
			historyLimit: 1,
			fetch: () => Promise.resolve(new Response(null, { status: 200 })),
			telemetry: new StoredOperationsTelemetryAdapter(harness.db, cloudflarePipelineTelemetry(), () => now),
		})
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
		expect(await health.getTelemetryState('source-a')).toBe('unavailable')
		await harness.repositories.ingest.record({
			sourceId: 'source-a',
			fingerprint: 'fingerprint-a',
			eventId: 'event-a',
			title: 'Error',
			culprit: null,
			level: 'error',
			release: null,
			receivedAt: now,
			blobKey: 'event-a.json',
		})
		now += 60 * 60_000
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
		expect(await health.getTelemetryState('source-a')).toBe('unavailable')
		expect(
			harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM telemetry_health_observations').get()?.count,
		).toBe(1)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM health_transitions').get()?.count).toBe(0)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(0)
	})

	test('records real DLQ, reject, and queue failures and recoveries with bounded history and alerts', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		for (const kind of ['unhealthy_telemetry', 'recovery']) {
			await harness.repositories.alerts.setRule('source-a', kind, true)
			await harness.repositories.alerts.upsertChannel({
				id: `channel-${kind}`,
				sourceId: 'source-a',
				scope: kind,
				type: 'webhook',
				target: 'https://example.test/hook',
				enabled: true,
			})
		}
		let rejects: TelemetryHealthObservation['rejects'] = { available: true, value: { accepted: 0, rejected: 0 } }
		let queue: TelemetryHealthObservation['queue'] = { available: true, value: { backlog: 0, oldestAgeMs: null } }
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `telemetry-id-${++nextId}`,
			historyLimit: 2,
			fetch: () => Promise.resolve(new Response(null, { status: 200 })),
			telemetry: new StoredOperationsTelemetryAdapter(harness.db, {
				observe: () => Promise.resolve({ rejects, queue }),
			}, () => now),
		})
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
		await harness.repositories.deadEvents.record({
			id: 'dead-a',
			sourceId: 'source-a',
			eventId: 'event-a',
			fingerprint: null,
			blobKey: 'dead-a.json',
			reason: 'exhausted',
			attempts: 6,
			deadAt: now,
		})
		for (const failure of ['dead_letters', 'reject_rate', 'queue_backlog', 'queue_age']) {
			if (failure === 'reject_rate') rejects = { available: true, value: { accepted: 20, rejected: 10 } }
			if (failure === 'queue_backlog') queue = { available: true, value: { backlog: 1_001, oldestAgeMs: null } }
			if (failure === 'queue_age') queue = { available: true, value: { backlog: 1, oldestAgeMs: 300_001 } }
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe(failure === 'dead_letters' ? 'failed' : 'degraded')
			const payload = harness.sqlite.query<{ payload: string }, []>('SELECT payload FROM current_telemetry_health').get()?.payload
			expect(payload).toBeDefined()
			if (payload === undefined) throw new Error('expected telemetry payload')
			expect(JSON.parse(payload)).toMatchObject({ reasons: [failure] })
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			harness.sqlite.exec('DELETE FROM dead_events')
			rejects = { available: true, value: { accepted: 0, rejected: 0 } }
			queue = { available: true, value: { backlog: 0, oldestAgeMs: null } }
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe('healthy')
		}
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM telemetry_health_observations').get()?.count).toBe(2)
		expect(
			harness.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM health_transitions WHERE kind = 'unhealthy_telemetry'").get()?.count,
		)
			.toBe(4)
		expect(harness.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM health_transitions WHERE kind = 'recovery'").get()?.count).toBe(4)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(8)
	})

	const resumedStates: ('healthy' | 'degraded')[] = ['healthy', 'degraded']
	for (const resumedState of resumedStates) {
		test(`retains alert provenance across pruned unavailable history before resuming ${resumedState}`, async () => {
			let now = 1_000
			const { harness, health } = await setup(() => now)
			for (const kind of ['unhealthy_telemetry', 'recovery']) {
				await harness.repositories.alerts.setRule('source-a', kind, true)
				await harness.repositories.alerts.upsertChannel({
					id: `channel-${kind}`,
					sourceId: 'source-a',
					scope: kind,
					type: 'webhook',
					target: 'https://example.test/hook',
					enabled: true,
				})
			}
			let queue: TelemetryHealthObservation['queue'] = unavailableTelemetryValue('adapter unavailable')
			let nextId = 0
			const execution = new OperationsHealthExecution(health, {
				now: () => now,
				id: () => `gap-id-${++nextId}`,
				historyLimit: 1,
				fetch: () => Promise.resolve(new Response(null, { status: 200 })),
				telemetry: new StoredOperationsTelemetryAdapter(harness.db, {
					observe: () => Promise.resolve({ rejects: { available: true, value: { accepted: 0, rejected: 0 } }, queue }),
				}, () => now),
			})
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe('unavailable')
			queue = { available: true, value: { backlog: 0, oldestAgeMs: null } }
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe('healthy')
			queue = { available: true, value: { backlog: 1_001, oldestAgeMs: null } }
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
			queue = unavailableTelemetryValue('adapter unavailable')
			for (let index = 0; index < 5; index++) {
				now += 1_000
				expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
				expect(await health.getTelemetryState('source-a')).toBe('unavailable')
			}
			expect(harness.sqlite.query<{ state: string }, []>('SELECT state FROM telemetry_health_observations').all()).toEqual([{ state: 'unavailable' }])
			expect(await health.getLastConclusiveTelemetryAlertState('source-a')).toBe('degraded')
			queue = { available: true, value: { backlog: resumedState === 'healthy' ? 0 : 1_001, oldestAgeMs: null } }
			now += 1_000
			const recoveryCount = resumedState === 'healthy' ? 1 : 0
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: recoveryCount, enqueuedAlerts: recoveryCount, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe(resumedState)
			const expectedTransitions = [{ kind: 'unhealthy_telemetry', from_state: 'healthy', to_state: 'degraded', occurred_at: 3_000 }]
			if (resumedState === 'healthy') {
				expectedTransitions.push({ kind: 'recovery', from_state: 'degraded', to_state: 'healthy', occurred_at: now })
			}
			expect(
				harness.sqlite.query<{ kind: string; from_state: string; to_state: string; occurred_at: number }, []>(
					'SELECT kind, from_state, to_state, occurred_at FROM health_transitions WHERE check_id IS NULL ORDER BY occurred_at, id',
				).all(),
			).toEqual(expectedTransitions)
			const resumedQueue = queue
			queue = unavailableTelemetryValue('adapter unavailable')
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			queue = resumedQueue
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(1 + recoveryCount)
		})
	}

	const legacyScenarios: { realFailure: boolean; legacyState: 'stale' | 'unavailable'; resumedState: 'healthy' | 'failed' }[] = [
		{ realFailure: true, legacyState: 'stale', resumedState: 'healthy' },
		{ realFailure: true, legacyState: 'stale', resumedState: 'failed' },
		{ realFailure: false, legacyState: 'stale', resumedState: 'healthy' },
		{ realFailure: false, legacyState: 'unavailable', resumedState: 'healthy' },
	]
	for (const scenario of legacyScenarios) {
		test(`resumes ${scenario.resumedState} from legacy ${scenario.legacyState} with real failure ${scenario.realFailure} without duplicate or fake alerts`, async () => {
			let now = 1_000
			const { harness, health } = await setup(() => now)
			for (const kind of ['unhealthy_telemetry', 'recovery']) {
				await harness.repositories.alerts.setRule('source-a', kind, true)
				await harness.repositories.alerts.upsertChannel({
					id: `channel-${kind}`,
					sourceId: 'source-a',
					scope: kind,
					type: 'webhook',
					target: 'https://example.test/hook',
					enabled: true,
				})
			}
			let dlqCount = scenario.realFailure ? 1 : 0
			let queue: TelemetryHealthObservation['queue'] = { available: true, value: { backlog: 0, oldestAgeMs: null } }
			const observe = (): TelemetryHealthObservation => ({
				observedAt: now,
				processed: { available: true, value: { count: 1, lastProcessedAt: 1_000 } },
				dlq: { available: true, value: { count: dlqCount } },
				rejects: { available: true, value: { accepted: 1, rejected: 0 } },
				queue,
			})
			let nextId = 0
			const execution = new OperationsHealthExecution(health, {
				now: () => now,
				id: () => `legacy-health-id-${++nextId}`,
				historyLimit: 1,
				fetch: () => Promise.resolve(new Response(null, { status: 200 })),
				telemetry: { observe: () => Promise.resolve(observe()) },
			})
			const failureCount = scenario.realFailure ? 1 : 0
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: failureCount, enqueuedAlerts: failureCount, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe(scenario.realFailure ? 'failed' : 'healthy')
			dlqCount = 0
			const legacyStates: ('stale' | 'unavailable')[] = scenario.legacyState === 'unavailable' ? ['stale', 'unavailable'] : ['stale']
			for (const state of legacyStates) {
				now += 60 * 60_000
				const observation: TelemetryHealthObservation = state === 'stale' ? observe() : {
					observedAt: now,
					processed: unavailableTelemetryValue('store unavailable'),
					dlq: unavailableTelemetryValue('store unavailable'),
					rejects: unavailableTelemetryValue('adapter unavailable'),
					queue: unavailableTelemetryValue('adapter unavailable'),
				}
				await health.recordTelemetryObservation({
					id: `legacy-observation-${state}`,
					sourceId: 'source-a',
					evaluated: { state, observedAt: now, reasons: [state === 'stale' ? 'stale_processing' : 'adapter_unavailable'], observation },
					transition: {
						id: `legacy-transition-${state}`,
						sourceId: 'source-a',
						checkId: null,
						kind: 'unhealthy_telemetry',
						from: await health.getTelemetryState('source-a'),
						to: state,
						at: now,
					},
					historyLimit: 1,
				})
			}
			expect(await health.getTelemetryState('source-a')).toBe(scenario.legacyState)
			expect(harness.sqlite.query<{ state: string }, []>('SELECT state FROM telemetry_health_observations').all()).toEqual([{
				state: scenario.legacyState,
			}])
			expect(await health.getLastConclusiveTelemetryAlertState('source-a')).toBe(scenario.realFailure ? 'failed' : null)
			dlqCount = scenario.resumedState === 'failed' ? 1 : 0
			now += 1_000
			const recoveryCount = scenario.realFailure && scenario.resumedState === 'healthy' ? 1 : 0
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: recoveryCount, enqueuedAlerts: recoveryCount, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe(scenario.resumedState)
			expect(
				harness.sqlite.query<{ from_state: string; to_state: string; occurred_at: number }, []>(
					"SELECT from_state, to_state, occurred_at FROM health_transitions WHERE kind = 'recovery'",
				).all(),
			).toEqual(recoveryCount === 1 ? [{ from_state: 'failed', to_state: 'healthy', occurred_at: now }] : [])
			dlqCount = 0
			queue = unavailableTelemetryValue('adapter unavailable')
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			expect(await health.getTelemetryState('source-a')).toBe('unavailable')
			dlqCount = scenario.resumedState === 'failed' ? 1 : 0
			queue = { available: true, value: { backlog: 0, oldestAgeMs: null } }
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
			expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(
				failureCount + recoveryCount,
			)
			expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM health_transitions').get()?.count)
				.toBe(failureCount + legacyStates.length + recoveryCount)
		})
	}
})
