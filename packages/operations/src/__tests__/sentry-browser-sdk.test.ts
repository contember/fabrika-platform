import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { consumeDeliveries, type IngestDelivery } from '../consumer.js'
import { provisionSourceIngest } from '../credentials.js'
import { handleDirectIngestRequest } from '../direct-ingest.js'
import { createHarness } from './helpers/sqlite.js'

const PUBLIC_KEY = '0123456789abcdef0123456789abcdef'
const PROJECT_ID = '123'
const RELEASE = 'sdk-witness-1'
const ENDPOINT =
	`https://operations.test/api/${PROJECT_ID}/envelope/?sentry_version=7&sentry_key=${PUBLIC_KEY}&sentry_client=sentry.javascript.browser%2F10.69.0`

class MemoryQueue implements JobQueue<IngestMessage> {
	readonly messages: IngestMessage[] = []

	send(message: IngestMessage): Promise<void> {
		this.messages.push(message)
		return Promise.resolve()
	}
}

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

// Shape recorded from @sentry/browser 10.69.0 with default integrations disabled.
function sdkEnvelope(eventId: string): string {
	const header = {
		event_id: eventId,
		sent_at: '2026-07-31T12:00:00.000Z',
		sdk: { name: 'sentry.javascript.browser', version: '10.69.0' },
		trace: { environment: 'production', release: RELEASE, public_key: PUBLIC_KEY, trace_id: 'b'.repeat(32) },
	}
	const event = {
		exception: {
			values: [{
				type: 'Error',
				value: 'Fabrika Operations SDK witness',
				stacktrace: {
					frames: [{
						filename: 'http://notes.localhost/operations-sdk.js',
						function: 'throwManagedError',
						in_app: true,
						lineno: 28,
						colno: 8,
					}],
				},
				mechanism: { type: 'generic', handled: true },
			}],
		},
		level: 'error',
		event_id: eventId,
		platform: 'javascript',
		timestamp: 1_785_504_000,
		environment: 'production',
		release: RELEASE,
		contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } },
		sdk: {
			name: 'sentry.javascript.browser',
			version: '10.69.0',
			integrations: [],
			packages: [{ name: 'npm:@sentry/browser', version: '10.69.0' }],
			settings: { infer_ip: 'never' },
		},
	}
	return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
}

describe('@sentry/browser compatibility witness', () => {
	test('accepts two SDK event envelopes and groups equivalent exceptions once', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'notes',
			environment: 'production',
			displayName: 'Notes',
			enabled: true,
		})
		await provisionSourceIngest(
			harness.repositories,
			{ sourceId: 'source-a', operationsOrigin: 'https://operations.test' },
			{ now: () => now, publicKey: () => PUBLIC_KEY, ingestProjectId: () => PROJECT_ID },
		)
		const queue = new MemoryQueue()
		const request = (eventId: string): Request =>
			new Request(ENDPOINT, {
				method: 'POST',
				body: sdkEnvelope(eventId),
			})

		const first = await handleDirectIngestRequest(request('a'.repeat(32)), { repositories: harness.repositories, queue, now: () => now })
		now = 2_000
		const second = await handleDirectIngestRequest(request('d'.repeat(32)), { repositories: harness.repositories, queue, now: () => now })
		expect(first.status).toBe(202)
		expect(second.status).toBe(202)
		expect(first.headers.get('access-control-allow-origin')).toBe('*')
		expect(first.headers.get('access-control-allow-headers')).toBeNull()
		expect(queue.messages).toHaveLength(2)
		expect(queue.messages[0]?.fingerprint).toBe(queue.messages[1]?.fingerprint)
		expect(queue.messages.map((message) => message.release)).toEqual([RELEASE, RELEASE])

		const acked: string[] = []
		const deliveries: IngestDelivery[] = queue.messages.map((message) => ({
			body: message,
			attempts: 1,
			ack: () => acked.push(message.eventId),
			retry: () => undefined,
		}))
		await consumeDeliveries(
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: queue },
			deliveries,
		)

		expect(acked).toEqual(['a'.repeat(32), 'd'.repeat(32)])
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issues').get()?.count).toBe(1)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM occurrences').get()?.count).toBe(2)
		expect(harness.sqlite.query<{ release: string }, []>('SELECT release FROM occurrences ORDER BY received_at').all()).toEqual([
			{ release: RELEASE },
			{ release: RELEASE },
		])
	})
})
