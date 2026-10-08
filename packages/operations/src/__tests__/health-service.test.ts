import { describe, expect, test } from 'bun:test'
import { SqliteHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
import { OperationsMaintenance } from '../maintenance.js'
import { StoredOperationsTelemetryAdapter } from '../telemetry.js'
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
			telemetry: new StoredOperationsTelemetryAdapter(harness.db),
		})
		expect(await listFailure.run()).toMatchObject({ recordedTelemetry: 0, errors: 2 })
	})
})

describe('dead-letter telemetry', () => {
	async function deadEvent(harness: Awaited<ReturnType<typeof setup>>['harness'], id: string, sourceId: string, deadAt: number) {
		await harness.repositories.deadEvents.record({
			id,
			sourceId,
			eventId: `event-${id}`,
			fingerprint: null,
			blobKey: `${id}.json`,
			reason: 'exhausted',
			attempts: 6,
			deadAt,
		})
	}

	test('counts dead events of the observed source only', async () => {
		const { harness } = await setup(() => 5_000)
		const adapter = new StoredOperationsTelemetryAdapter(harness.db, () => 5_000)
		expect(await adapter.observe({ sourceId: 'source-a' })).toEqual({ observedAt: 5_000, deadLetters: 0 })
		await deadEvent(harness, 'dead-a', 'source-a', 1_000)
		await deadEvent(harness, 'dead-other', 'source-other', 1_000)
		expect(await adapter.observe({ sourceId: 'source-a' })).toEqual({ observedAt: 5_000, deadLetters: 1 })
	})

	test('reports healthy without dead letters and alerts once when dead letters appear', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		await harness.repositories.alerts.setRule('source-a', 'unhealthy_telemetry', true)
		await harness.repositories.alerts.upsertChannel({
			id: 'channel-telemetry',
			sourceId: 'source-a',
			scope: 'unhealthy_telemetry',
			type: 'webhook',
			target: 'https://example.test/hook',
			enabled: true,
		})
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `telemetry-id-${++nextId}`,
			historyLimit: 2,
			fetch: () => Promise.resolve(new Response(null, { status: 200 })),
			telemetry: new StoredOperationsTelemetryAdapter(harness.db, () => now),
		})
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
		expect(await health.getTelemetryState('source-a')).toBe('healthy')

		await deadEvent(harness, 'dead-a', 'source-a', now)
		now += 1_000
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 1, enqueuedAlerts: 1, errors: 0 })
		expect(await health.getTelemetryState('source-a')).toBe('failed')

		for (let index = 0; index < 3; index++) {
			now += 1_000
			expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0, enqueuedAlerts: 0, errors: 0 })
		}
		expect(await health.getTelemetryState('source-a')).toBe('failed')
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM telemetry_health_observations').get()?.count).toBe(2)
		expect(
			harness.sqlite.query<{ kind: string; from_state: string; to_state: string }, []>(
				'SELECT kind, from_state, to_state FROM health_transitions WHERE check_id IS NULL',
			).all(),
		).toEqual([{ kind: 'unhealthy_telemetry', from_state: 'healthy', to_state: 'failed' }])
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(1)
	})
})
