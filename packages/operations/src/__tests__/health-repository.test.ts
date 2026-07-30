import { describe, expect, test } from 'bun:test'
import { SqliteHealthRepository } from '../health-repository.js'
import { decideHttpHealth, type HealthTransition, type HttpCheckAttempt } from '../health.js'
import { createHarness } from './helpers/sqlite.js'

async function setup(now: () => number) {
	const harness = createHarness(now)
	await harness.repositories.sources.upsert({
		id: 'source-a',
		appId: 'app-a',
		environment: 'production',
		displayName: 'App A',
		enabled: true,
		publicOrigin: 'https://app.example.test',
	})
	return { harness, health: new SqliteHealthRepository(harness.db, now) }
}

describe('health repository', () => {
	test('leases due checks and requires the lease token to reschedule', async () => {
		let now = 1_000
		const { health } = await setup(() => now)
		await health.upsertCheck({
			id: 'check-a',
			sourceId: 'source-a',
			path: '/health',
			enabled: true,
			intervalMs: 60_000,
			staleAfterMs: 180_000,
		})

		const claimed = await health.claimDueChecks({ limit: 10, leaseMs: 5_000 })
		expect(claimed).toHaveLength(1)
		expect(claimed[0]?.publicOrigin).toBe('https://app.example.test')
		expect(await health.claimDueChecks({ limit: 10, leaseMs: 5_000 })).toEqual([])
		const check = claimed[0]
		if (check === undefined) throw new Error('expected claimed check')
		expect(await health.completeLease({ checkId: check.id, claimToken: 'wrong', nextDueAt: 61_000 })).toBe(false)
		expect(await health.completeLease({ checkId: check.id, claimToken: check.claimToken, nextDueAt: 61_000 })).toBe(true)
		now = 60_999
		expect(await health.claimDueChecks({ limit: 10, leaseMs: 5_000 })).toEqual([])
		now = 61_000
		expect(await health.claimDueChecks({ limit: 10, leaseMs: 5_000 })).toHaveLength(1)
	})

	test('stores current state and bounded history with stable transition IDs', async () => {
		let now = 1_000
		const { health } = await setup(() => now)
		await health.upsertCheck({
			id: 'check-a',
			sourceId: 'source-a',
			path: '/health',
			enabled: true,
			intervalMs: 60_000,
			staleAfterMs: 180_000,
		})

		let current = decideHttpHealth(null, {
			successful: true,
			observedAt: now,
			latencyMs: 5,
			status: 200,
			detailCode: 'ok',
		}, 'initial').current
		for (let index = 0; index < 4; index++) {
			now++
			const attempt: HttpCheckAttempt = {
				successful: false,
				observedAt: now,
				latencyMs: 10,
				status: 503,
				detailCode: 'unexpected_status',
			}
			const decision = decideHttpHealth(current, attempt, `transition-${index}`)
			await health.recordHttpObservation({
				sourceId: 'source-a',
				checkId: 'check-a',
				observationId: `observation-${index}`,
				attempt,
				decision,
				historyLimit: 2,
			})
			current = decision.current
		}

		expect((await health.getCurrent('check-a'))?.state).toBe('failed')
		expect((await health.getCurrent('check-a'))?.transitionId).toBe('transition-2')
		expect((await health.history('check-a', 100)).map((item) => item.id)).toEqual(['observation-3', 'observation-2'])
	})

	test('deduplicates each transition per channel and defers email', async () => {
		const { harness, health } = await setup(() => 1_000)
		await harness.repositories.alerts.setRule('source-a', 'failed_check', true)
		const channels = [
			{ id: 'webhook-a', type: 'webhook' },
			{ id: 'webhook-b', type: 'webhook' },
			{ id: 'email-a', type: 'email' },
		]
		for (const { id, type } of channels) {
			await harness.repositories.alerts.upsertChannel({
				id,
				sourceId: 'source-a',
				scope: 'failed_check',
				type,
				target: type === 'email' ? 'ops@example.test' : `https://${id}.example.test/hook`,
				enabled: true,
			})
		}
		const transition: HealthTransition = {
			id: 'transition-a',
			sourceId: 'source-a',
			checkId: 'check-a',
			kind: 'failed_check',
			from: 'degraded',
			to: 'failed',
			at: 1_000,
		}

		expect(await health.enqueueTransitionAlerts(transition)).toEqual({ enqueued: 2, deferredEmail: 1 })
		expect(await health.enqueueTransitionAlerts(transition)).toEqual({ enqueued: 0, deferredEmail: 1 })
		const keys = harness.sqlite.query<{ dedup_key: string }, []>(
			'SELECT dedup_key FROM notification_outbox ORDER BY dedup_key',
		).all().map((row) => row.dedup_key)
		expect(keys).toEqual([
			'health:transition-a:failed_check:webhook-a',
			'health:transition-a:failed_check:webhook-b',
		])
	})
})
