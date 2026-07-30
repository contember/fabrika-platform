import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { archiveDeadEvent, credentialVerifier, persistIngest, storeSourceMap } from '../pipeline.js'
import { createSqliteOperationsRepositories } from '../repositories.js'
import { createHarness } from './helpers/sqlite.js'

class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, string>()

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		if (typeof value !== 'string') throw new Error('test blob store accepts strings only')
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null> {
		const value = this.values.get(key)
		if (value === undefined) return Promise.resolve(null)
		return Promise.resolve({
			body: new Blob([value]).stream(),
			text: () => Promise.resolve(value),
		})
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

class MemoryQueue<T> implements JobQueue<T> {
	readonly messages: T[] = []

	send(message: T): Promise<void> {
		this.messages.push(message)
		return Promise.resolve()
	}
}

function message(input: { sourceId: string; eventId: string; fingerprint?: string; receivedAt?: number }): IngestMessage {
	return {
		projectId: input.sourceId,
		eventId: input.eventId,
		fingerprint: input.fingerprint ?? 'fp-shared',
		title: 'TypeError: broken',
		culprit: 'handler',
		level: 'error',
		release: 'release-1',
		receivedAt: input.receivedAt ?? 1_000,
		payload: { event_id: input.eventId, message: 'private payload' },
	}
}

async function source(harness: ReturnType<typeof createHarness>, id: string): Promise<void> {
	await harness.repositories.sources.upsert({
		id,
		appId: id,
		environment: 'production',
		displayName: id,
		enabled: true,
	})
}

describe('Operations portable repositories', () => {
	test('replaces one complete repository capability at the composition root', () => {
		const harness = createHarness()
		const sources = harness.repositories.sources
		const repositories = createSqliteOperationsRepositories(harness.db, { replacements: { sources } })
		expect(repositories.sources).toBe(sources)
		expect(repositories.ingest).toBeDefined()
		expect(repositories.alerts).toBeDefined()
	})

	test('stores only credential verifiers and enforces source lifecycle', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await source(harness, 'source-a')
		const raw = 'public-dsn-key'
		const verifier = await credentialVerifier(raw)
		const id = await harness.repositories.sources.addCredential({
			sourceId: 'source-a',
			verifier,
			expiresAt: 2_000,
		})

		expect(await harness.repositories.sources.resolveCredential(verifier)).toBe('source-a')
		expect(JSON.stringify(harness.sqlite.query('SELECT * FROM ingest_credentials').all())).not.toContain(raw)
		now = 2_000
		expect(await harness.repositories.sources.resolveCredential(verifier)).toBeNull()
		expect(await harness.repositories.sources.revokeCredential(id)).toBe(true)
		expect(await harness.repositories.sources.revokeCredential(id)).toBe(false)
	})

	test('makes duplicate queue delivery an exact no-op and isolates equal fingerprints by source', async () => {
		const harness = createHarness(() => 3_000)
		const blobs = new MemoryBlobs()
		const queue = new MemoryQueue<IngestMessage>()
		const env = { repositories: harness.repositories, payloads: blobs, ingestQueue: queue }
		await source(harness, 'source-a')
		await source(harness, 'source-b')

		const first = message({ sourceId: 'source-a', eventId: 'event-a', receivedAt: 1_000 })
		expect((await persistIngest(env, first)).duplicate).toBe(false)
		expect((await persistIngest(env, first)).duplicate).toBe(true)
		expect(
			(await persistIngest(
				env,
				message({
					sourceId: 'source-a',
					eventId: 'event-a',
					fingerprint: 'attacker-changed-fingerprint',
					receivedAt: 9_000,
				}),
			)).issue.fingerprint,
		).toBe('fp-shared')
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'event-b', receivedAt: 2_000 }))
		await persistIngest(env, message({ sourceId: 'source-b', eventId: 'event-c', receivedAt: 4_000 }))

		expect((await harness.repositories.ingest.counts({ sourceId: 'source-a' }))[0]?.count).toBe(2)
		expect((await harness.repositories.ingest.counts({ sourceId: 'source-b' }))[0]?.count).toBe(1)
		expect((await harness.repositories.ingest.getIssue('source-a', 'fp-shared'))?.last_seen).toBe(2_000)
		expect((await harness.repositories.ingest.getIssue('source-b', 'fp-shared'))?.last_seen).toBe(4_000)
		expect(harness.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM occurrences').get()?.n).toBe(3)
	})

	test('buckets exact occurrences without object-store listing', async () => {
		const harness = createHarness(() => 10_000)
		const blobs = new MemoryBlobs()
		const env = { repositories: harness.repositories, payloads: blobs, ingestQueue: new MemoryQueue<IngestMessage>() }
		await source(harness, 'source-a')
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'one', receivedAt: 1_000 }))
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'two', receivedAt: 2_000 }))
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'three', receivedAt: 9_000 }))

		expect(
			await harness.repositories.ingest.series({
				sourceId: 'source-a',
				since: 0,
				until: 10_000,
				buckets: 2,
			}),
		).toEqual([
			{ fingerprint: 'fp-shared', bucket: 0, count: 2 },
			{ fingerprint: 'fp-shared', bucket: 1, count: 1 },
		])
	})

	test('claims alert windows atomically and deduplicates the notification outbox', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await source(harness, 'source-a')
		harness.sqlite.run(
			`INSERT INTO notification_channels (id, source_id, scope, type, target, enabled)
			 VALUES ('channel-a', 'source-a', 'spike', 'webhook', 'https://example.test/hook', 1)`,
		)

		expect(await harness.repositories.alerts.tryClaim('spike:source-a:fp', 500)).toBe(true)
		expect(await harness.repositories.alerts.tryClaim('spike:source-a:fp', 500)).toBe(false)
		now = 1_500
		expect(await harness.repositories.alerts.tryClaim('spike:source-a:fp', 500)).toBe(true)
		expect(
			await harness.repositories.alerts.enqueueNotification({
				dedupKey: 'spike:source-a:fp:channel-a:1000',
				sourceId: 'source-a',
				channelId: 'channel-a',
				kind: 'spike',
				payload: { count: 10 },
			}),
		).toBe(true)
		expect(
			await harness.repositories.alerts.enqueueNotification({
				dedupKey: 'spike:source-a:fp:channel-a:1000',
				sourceId: 'source-a',
				channelId: 'channel-a',
				kind: 'spike',
				payload: { count: 10 },
			}),
		).toBe(false)
	})

	test('indexes dead payloads and source maps durably', async () => {
		const harness = createHarness(() => 5_000)
		const blobs = new MemoryBlobs()
		const env = { repositories: harness.repositories, payloads: blobs, ingestQueue: new MemoryQueue<IngestMessage>() }
		await source(harness, 'source-a')
		await source(harness, 'source-b')
		const dead = message({ sourceId: 'source-a', eventId: 'dead-a' })
		await archiveDeadEvent(env, dead, { attempts: 6, reason: 'retry_exhausted', deadAt: 4_000 })
		await archiveDeadEvent(env, dead, { attempts: 7, reason: 'retry_exhausted', deadAt: 5_000 })
		expect(harness.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM dead_events').get()?.n).toBe(1)
		expect(harness.sqlite.query<{ attempts: number }, []>('SELECT attempts FROM dead_events').get()?.attempts).toBe(7)

		await harness.repositories.artifacts.upsertRelease({
			id: 'release-a',
			sourceId: 'source-a',
			runId: 'run-a',
			commitSha: 'abc123',
			state: 'succeeded',
		})
		const key = await storeSourceMap(env, {
			sourceId: 'source-a',
			releaseId: 'release-a',
			fileName: 'https://cdn.test/assets/app.js?x=1',
			body: '{"version":3}',
		})
		expect(key).toBe('source-maps/source-a/release-a/app.js.map')
		expect(await harness.repositories.artifacts.sourceMapKey('release-a', 'app.js')).toBe(key)
		await expect(
			storeSourceMap(env, {
				sourceId: 'source-b',
				releaseId: 'release-a',
				fileName: 'app.js',
				body: '{"version":3}',
			}),
		).rejects.toThrow('release does not belong to source')
		expect(blobs.values.has('source-maps/source-b/release-a/app.js.map')).toBe(false)
	})
})
