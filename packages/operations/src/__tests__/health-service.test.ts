import { describe, expect, test } from 'bun:test'
import { SqliteHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
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
		let now = 1_000
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
		let now = 0
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

		const starts: number[] = []
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `lease-id-${++nextId}`,
			httpBatchSize: 2,
			httpConcurrency: 1,
			leaseMs: 90_000,
			fetch: () => {
				starts.push(now)
				now += 30_000
				return Promise.resolve(new Response(null, { status: 200 }))
			},
		})
		expect(await execution.run()).toMatchObject({ claimedChecks: 2, recordedChecks: 2, errors: 0 })
		expect(starts).toEqual([0, 30_000])
		expect(starts.every((startedAt) => startedAt < 90_000)).toBe(true)
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

	test('persists bounded unavailable/stale telemetry history without repeated transitions', async () => {
		let now = 1_000
		const { harness, health } = await setup(() => now)
		let nextId = 0
		const execution = new OperationsHealthExecution(health, {
			now: () => now,
			id: () => `telemetry-id-${++nextId}`,
			historyLimit: 1,
			fetch: () => Promise.resolve(new Response(null, { status: 200 })),
			telemetry: new StoredOperationsTelemetryAdapter(harness.db, cloudflarePipelineTelemetry(), () => now),
		})
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 1 })
		now = 2_000
		expect(await execution.run()).toMatchObject({ recordedTelemetry: 1, transitions: 0 })
		expect(
			harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM telemetry_health_observations').get()?.count,
		).toBe(1)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM health_transitions').get()?.count).toBe(1)
	})
})
