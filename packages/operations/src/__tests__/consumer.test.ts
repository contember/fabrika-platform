import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { consumeDeliveries, type IngestDelivery } from '../consumer.js'
import { OperationsMaintenance, WebhookNotificationSender } from '../maintenance.js'
import { createHarness } from './helpers/sqlite.js'

class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, string>()

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		if (typeof value !== 'string') throw new Error('strings only')
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(): Promise<null> {
		return Promise.resolve(null)
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

class EmptyQueue implements JobQueue<IngestMessage> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

function message(index: number): IngestMessage {
	return {
		projectId: 'source-a',
		fingerprint: 'storm',
		eventId: `event-${index}`,
		title: 'Error: storm',
		culprit: 'handler',
		level: 'error',
		receivedAt: 1_000 + index,
		payload: { index },
	}
}

describe('shared ingest consumer', () => {
	test('coalesces a 25-event storm into one issue write and preserves every delivery outcome', async () => {
		const harness = createHarness(() => 2_000)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		harness.sqlite.run('CREATE TABLE issue_writes (kind TEXT NOT NULL)')
		harness.sqlite.run(`CREATE TRIGGER count_issue_insert AFTER INSERT ON issues
			BEGIN INSERT INTO issue_writes (kind) VALUES ('insert'); END`)
		harness.sqlite.run(`CREATE TRIGGER count_issue_update AFTER UPDATE ON issues
			BEGIN INSERT INTO issue_writes (kind) VALUES ('update'); END`)
		const acked: number[] = []
		const retried: number[] = []
		const deliveries: IngestDelivery[] = Array.from({ length: 25 }, (_, index) => ({
			body: message(index),
			attempts: 1,
			ack: () => acked.push(index),
			retry: () => retried.push(index),
		}))
		await consumeDeliveries(
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() },
			deliveries,
		)

		expect(acked).toEqual(Array.from({ length: 25 }, (_, index) => index))
		expect(retried).toEqual([])
		expect((await harness.repositories.ingest.counts({ sourceId: 'source-a', fingerprint: 'storm' }))[0]?.count).toBe(25)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM occurrences').get()?.count).toBe(25)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issue_writes').get()?.count).toBe(1)
	})

	test('enqueues each issue transition once and delivers it through the webhook outbox', async () => {
		const harness = createHarness(() => 5_000)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		await harness.repositories.alerts.setRule('source-a', 'new_issue', true)
		await harness.repositories.alerts.setRule('source-a', 'regression', true)
		for (const kind of ['new_issue', 'regression']) {
			await harness.repositories.alerts.upsertChannel({
				id: `${kind}-channel`,
				sourceId: 'source-a',
				scope: kind,
				type: 'webhook',
				target: `https://example.test/${kind}`,
				enabled: true,
			})
		}
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }
		const outcomes = { acked: 0, retried: 0 }
		const delivery = (body: IngestMessage): IngestDelivery => ({
			body,
			attempts: 1,
			ack: () => outcomes.acked++,
			retry: () => outcomes.retried++,
		})
		const first = message(0)
		await consumeDeliveries(env, [delivery(first)])
		await consumeDeliveries(env, [delivery(first)])
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(1)

		await harness.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'storm',
			mutation: { kind: 'status', status: 'resolved' },
			actorId: null,
			actorLabel: null,
		})
		const regression = { ...message(1), receivedAt: 2_000 }
		await consumeDeliveries(env, [delivery(regression)])
		await consumeDeliveries(env, [delivery(regression)])
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(2)
		expect(outcomes).toEqual({ acked: 4, retried: 0 })

		const requests: Request[] = []
		const sender = new WebhookNotificationSender((request) => {
			requests.push(request)
			return Promise.resolve(new Response(null, { status: 204 }))
		})
		expect((await new OperationsMaintenance(harness.repositories.alerts, sender).run()).notifications).toBe(2)
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/new_issue', '/regression'])
		expect(requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual([
			'new_issue:source-a:storm:1000:new_issue-channel',
			'regression:source-a:storm:2000:regression-channel',
		])
	})
})
