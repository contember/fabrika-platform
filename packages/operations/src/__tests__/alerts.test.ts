import type { IngestMessage } from '@fabrika/operations-contract'
import { EmptyQueue, MemoryBlobs } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { evaluateSpike, NEW_ISSUE_ALERT_LIMIT, NEW_ISSUE_ALERT_WINDOW_MS, OperationsAlertProducer, SPIKE_DEDUP_WINDOW_SECONDS } from '../alerts.js'
import { consumeDeliveries, type IngestDelivery } from '../consumer.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { OperationsMaintenance } from '../maintenance.js'
import { persistIngest } from '../pipeline.js'
import { createHarness, type OperationsHarness } from './helpers/sqlite.js'

async function sourceWithChannel(harness: OperationsHarness, sourceId: string, scope: string): Promise<void> {
	await harness.repositories.sources.upsert({
		id: sourceId,
		appId: `app-${sourceId}`,
		environment: 'production',
		displayName: sourceId,
		enabled: true,
	})
	await harness.repositories.alerts.setRule(sourceId, scope, true)
	await harness.repositories.alerts.upsertChannel({
		id: `${sourceId}-${scope}`,
		sourceId,
		scope,
		type: 'webhook',
		target: `https://example.test/${sourceId}/${scope}`,
		enabled: true,
	})
}

function newIssue(sourceId: string, fingerprint: string, receivedAt: number): IngestDelivery {
	const body: IngestMessage = {
		projectId: sourceId,
		fingerprint,
		eventId: `${sourceId}-${fingerprint}-${receivedAt}`,
		title: `Error: ${fingerprint}`,
		culprit: null,
		level: 'error',
		receivedAt,
		payload: {},
	}
	return { body, attempts: 1, ack: () => {}, retry: () => {} }
}

function outboxCount(harness: OperationsHarness, sourceId: string): number | undefined {
	return harness.sqlite.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM notification_outbox WHERE source_id = ?')
		.get(sourceId)?.count
}

describe('alert semantics', () => {
	test('fires exactly at the threshold', () => {
		expect(evaluateSpike({ count: 9, threshold: 10, claimed: false })).toEqual({ fire: false, deduped: false })
		expect(evaluateSpike({ count: 10, threshold: 10, claimed: false })).toEqual({ fire: true, deduped: false })
	})

	test('reports an already claimed spike as deduplicated', () => {
		expect(evaluateSpike({ count: 11, threshold: 10, claimed: true })).toEqual({ fire: false, deduped: true })
	})

	test('enqueues one spike notification per claim window from the last minute of occurrences', async () => {
		let now = 120_000
		const harness = createHarness(() => now)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		await harness.repositories.alerts.setConfig('source-a', { threshold: 3, enabled: true })
		await harness.repositories.alerts.upsertChannel({
			id: 'spike-channel',
			sourceId: 'source-a',
			scope: 'spike',
			type: 'webhook',
			target: 'https://example.test/spikes',
			enabled: true,
		})
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }
		for (let index = 0; index < 3; index++) {
			await persistIngest(env, {
				projectId: 'source-a',
				fingerprint: 'spiking',
				eventId: `event-${index}`,
				title: 'Spike',
				culprit: null,
				level: 'error',
				receivedAt: 119_000 + index,
				payload: {},
			})
		}
		const producer = new OperationsAlertProducer(harness.repositories.alerts, harness.repositories.ingest, () => now)
		const delivered: string[] = []
		const maintenance = new OperationsMaintenance(
			harness.repositories.alerts,
			{
				send: (input) => {
					delivered.push(input.idempotencyKey)
					return Promise.resolve()
				},
			},
			{ alertProducer: producer },
		)

		expect((await maintenance.run()).spikes).toEqual({ evaluated: 1, enqueued: 1, deduplicated: 0 })
		expect((await maintenance.run()).spikes).toEqual({ evaluated: 1, enqueued: 0, deduplicated: 1 })
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(1)

		now += SPIKE_DEDUP_WINDOW_SECONDS * 1_000
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-a',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now - 2,
			payload: {},
		})
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-b',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now - 1,
			payload: {},
		})
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-c',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now,
			payload: {},
		})
		expect((await maintenance.run()).spikes).toEqual({ evaluated: 1, enqueued: 1, deduplicated: 0 })
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(2)
		expect(delivered).toHaveLength(2)
	})

	test('caps new-issue alerts per source and channel, so a flood from one source does not delay another', async () => {
		let now = 1_000_000
		const harness = createHarness(() => now)
		await sourceWithChannel(harness, 'source-a', 'new_issue')
		await sourceWithChannel(harness, 'source-b', 'new_issue')
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }

		const logged: string[] = []
		await consumeDeliveries(
			env,
			Array.from({ length: 30 }, (_, index) => newIssue('source-a', `flood-${index}`, now - 30 + index)),
			{ log: (message) => logged.push(message) },
		)
		await consumeDeliveries(env, [newIssue('source-b', 'unrelated', now)])
		expect(outboxCount(harness, 'source-a')).toBe(NEW_ISSUE_ALERT_LIMIT)
		expect(outboxCount(harness, 'source-b')).toBe(1)
		expect(logged).toHaveLength(30 - NEW_ISSUE_ALERT_LIMIT)
		expect(logged[0]).toBe('operations new-issue alerts over the per-channel limit dropped count=1')

		const payloads = harness.sqlite
			.query<{ payload: string }, [string]>('SELECT payload FROM notification_outbox WHERE source_id = ? ORDER BY id')
			.all('source-a')
			.map((row): Record<string, unknown> => JSON.parse(row.payload))
		expect(payloads.map((payload) => payload['limitReached'] === true)).toEqual(
			Array.from({ length: NEW_ISSUE_ALERT_LIMIT }, (_, index) => index === NEW_ISSUE_ALERT_LIMIT - 1),
		)
		expect(payloads.at(-1)?.['text']).toEndWith(
			'Alert limit reached: further new issues in source-a are shown only in the console for up to 10 minutes.',
		)
		expect(payloads[0]).not.toHaveProperty('limitReached')

		const delivered: string[] = []
		const maintenance = new OperationsMaintenance(harness.repositories.alerts, {
			send: (input) => {
				delivered.push(input.target)
				return Promise.resolve()
			},
		}, { batchSize: NEW_ISSUE_ALERT_LIMIT + 1 })
		await maintenance.run()
		expect(delivered).toContain('https://example.test/source-b/new_issue')

		const producer = new OperationsAlertProducer(harness.repositories.alerts, harness.repositories.ingest, () => now)
		const blocked = newIssue('source-a', 'still-capped', now).body
		expect(await producer.produceIngest([blocked], [await persistIngest(env, blocked)])).toEqual({ enqueued: 0, deduplicated: 0, capped: 1 })

		now += NEW_ISSUE_ALERT_WINDOW_MS
		const reopened = newIssue('source-a', 'next-window', now).body
		expect(await producer.produceIngest([reopened], [await persistIngest(env, reopened)])).toEqual({ enqueued: 1, deduplicated: 0, capped: 0 })
	})

	test('a redelivered new issue takes no further slot, even once the limit is reached', async () => {
		const harness = createHarness(() => 1_000_000)
		await sourceWithChannel(harness, 'source-a', 'new_issue')
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }
		const slots = () =>
			harness.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM alert_claims WHERE claim_key LIKE 'new_issue:%'").get()?.count

		const first = newIssue('source-a', 'first', 999_000)
		for (let attempt = 0; attempt < 3; attempt++) await consumeDeliveries(env, [first])
		expect(slots()).toBe(1)
		expect(outboxCount(harness, 'source-a')).toBe(1)

		await consumeDeliveries(
			env,
			Array.from({ length: NEW_ISSUE_ALERT_LIMIT - 1 }, (_, index) => newIssue('source-a', `more-${index}`, 999_100 + index)),
		)
		expect(slots()).toBe(NEW_ISSUE_ALERT_LIMIT)
		const producer = new OperationsAlertProducer(harness.repositories.alerts, harness.repositories.ingest)
		expect(await producer.produceIngest([first.body], [await persistIngest(env, first.body)])).toEqual({ enqueued: 0, deduplicated: 1, capped: 0 })
	})

	test('claims health alerts before older issue alerts', async () => {
		let now = 1_000_000
		const harness = createHarness(() => now)
		await sourceWithChannel(harness, 'source-a', 'new_issue')
		await sourceWithChannel(harness, 'source-b', 'failed_check')
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }
		await consumeDeliveries(env, Array.from({ length: 3 }, (_, index) => newIssue('source-a', `older-${index}`, now)))

		now += 60_000
		await new SqliteHealthRepository(harness.db, () => now).enqueueTransitionAlerts({
			id: 'transition-1',
			sourceId: 'source-b',
			checkId: null,
			kind: 'failed_check',
			from: 'healthy',
			to: 'failed',
			at: now,
		})

		const claimed = await harness.repositories.alerts.claimNotifications({ limit: 1, leaseMs: 60_000 })
		expect(claimed.map((notification) => notification.target)).toEqual(['https://example.test/source-b/failed_check'])
	})
})
