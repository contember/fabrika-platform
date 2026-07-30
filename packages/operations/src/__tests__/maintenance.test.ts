import { describe, expect, test } from 'bun:test'
import { OperationsMaintenance, WebhookNotificationSender } from '../maintenance.js'
import { runCloudflareScheduledMaintenance } from '../platform-cf.js'
import { createHarness } from './helpers/sqlite.js'

async function configure(now: () => number): Promise<ReturnType<typeof createHarness>> {
	const harness = createHarness(now)
	await harness.repositories.sources.upsert({
		id: 'source-a',
		appId: 'app-a',
		environment: 'production',
		displayName: 'App A',
		enabled: true,
	})
	await harness.repositories.alerts.setConfig('source-a', { threshold: 10, enabled: true })
	await harness.repositories.alerts.setRule('source-a', 'new_issue', true)
	await harness.repositories.alerts.upsertChannel({
		id: 'channel-a',
		sourceId: 'source-a',
		scope: 'new_issue',
		type: 'webhook',
		target: 'https://user:top-secret@example.test/hook',
		enabled: true,
	})
	return harness
}

describe('Operations notification maintenance', () => {
	test('claims, retries, and abandons an outbox item after six attempts', async () => {
		let now = 1_000
		const harness = await configure(() => now)
		await harness.repositories.alerts.enqueueNotification({
			dedupKey: 'new:source-a:fp-a',
			sourceId: 'source-a',
			channelId: 'channel-a',
			kind: 'new_issue',
			payload: { fingerprint: 'fp-a' },
		})
		for (let attempt = 1; attempt <= 6; attempt++) {
			const claimed = await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 100 })
			expect(claimed[0]?.attempts).toBe(attempt)
			expect(await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 100 })).toEqual([])
			const item = claimed[0]
			if (!item) throw new Error('expected claimed notification')
			expect(
				await harness.repositories.alerts.completeNotification({
					id: item.id,
					claimToken: item.claimToken,
					delivered: false,
					retryDelayMs: 0,
					errorCode: 'delivery_failed',
				}),
			).toBe(true)
			now++
		}
		expect(await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 100 })).toEqual([])
		expect(
			harness.sqlite.query<{ attempts: number; abandoned_at: number | null }, []>(
				'SELECT attempts, abandoned_at FROM notification_outbox',
			).get(),
		).toEqual({ attempts: 6, abandoned_at: 1_005 })
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_attempts').get()?.count).toBe(6)

		await harness.repositories.alerts.enqueueNotification({
			dedupKey: 'crash:source-a:fp-a',
			sourceId: 'source-a',
			channelId: 'channel-a',
			kind: 'new_issue',
			payload: {},
		})
		for (let attempt = 1; attempt <= 6; attempt++) {
			expect((await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 100 }))[0]?.attempts).toBe(attempt)
			now += 101
		}
		expect(await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 100 })).toEqual([])
		expect(
			harness.sqlite.query<{ abandoned_at: number | null }, [string]>(
				'SELECT abandoned_at FROM notification_outbox WHERE dedup_key = ?',
			).get('crash:source-a:fp-a')?.abandoned_at,
		).toBe(now)
	})

	test('dispatch uses the dedup key externally and logs no target or error detail', async () => {
		const harness = await configure(() => 1_000)
		await harness.repositories.alerts.enqueueNotification({
			dedupKey: 'regression:source-a:fp-a',
			sourceId: 'source-a',
			channelId: 'channel-a',
			kind: 'regression',
			payload: { fingerprint: 'fp-a' },
		})
		const logs: unknown[] = []
		const maintenance = new OperationsMaintenance(
			harness.repositories.alerts,
			{
				send: () => Promise.reject(new Error('top-secret endpoint failed')),
			},
			{
				retryDelayMs: () => 0,
				logger: { warn: (message, fields) => logs.push({ message, fields }) },
			},
		)
		const promises: Promise<unknown>[] = []
		runCloudflareScheduledMaintenance(maintenance, { waitUntil: (promise) => promises.push(promise) })
		await Promise.all(promises)
		expect(logs).toEqual([
			{
				message: 'notification delivery failed',
				fields: { notificationId: expect.any(String), attempt: 1 },
			},
		])
		expect(JSON.stringify(logs)).not.toContain('top-secret')
	})

	test('webhook delivery sends the stable Idempotency-Key contract', async () => {
		const captured: Request[] = []
		const sender = new WebhookNotificationSender((request) => {
			captured.push(request)
			return Promise.resolve(new Response(null, { status: 204 }))
		})
		await sender.send({
			type: 'webhook',
			target: 'https://example.test/hook',
			payload: { issue: 'fp-a' },
			idempotencyKey: 'new:source-a:fp-a',
		})
		const request = captured[0]
		if (!request) throw new Error('request was not sent')
		expect(request.headers.get('Idempotency-Key')).toBe('new:source-a:fp-a')
		const requestBody: unknown = await request.json()
		expect(requestBody).toEqual({ issue: 'fp-a' })
	})
})
