import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { archiveDeadEvent, persistIngest, storeSourceMap } from '../pipeline.js'
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

	test('reserves a numeric ingest id once and consumes the portable rate window atomically', async () => {
		const harness = createHarness(() => 1_000)
		await source(harness, 'source-a')
		expect(await harness.repositories.sources.ensureIngestProjectId('source-a', '123456')).toBe('123456')
		expect(await harness.repositories.sources.ensureIngestProjectId('source-a', '999999')).toBe('123456')
		const decisions = await Promise.all(
			Array.from({ length: 305 }, () =>
				harness.repositories.ingestRateLimits.consume({
					sourceId: 'source-a',
					windowStart: 0,
					limit: 300,
				})),
		)
		expect(decisions.filter(Boolean)).toHaveLength(300)
		expect(await harness.repositories.ingestRateLimits.prune(60_000)).toBe(1)
	})

	test('records the first source disable time and clears it on re-enable', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await source(harness, 'source-a')
		now = 2_000
		expect(
			await harness.repositories.sources.upsert({
				id: 'ignored-on-conflict',
				appId: 'source-a',
				environment: 'production',
				displayName: 'source-a',
				enabled: false,
			}),
		).toMatchObject({ enabled: 0, disabled_at: 2_000 })
		now = 3_000
		expect(
			await harness.repositories.sources.upsert({
				id: 'ignored-on-conflict',
				appId: 'source-a',
				environment: 'production',
				displayName: 'source-a',
				enabled: false,
			}),
		).toMatchObject({ enabled: 0, disabled_at: 2_000 })
		now = 4_000
		expect(
			await harness.repositories.sources.upsert({
				id: 'ignored-on-conflict',
				appId: 'source-a',
				environment: 'production',
				displayName: 'source-a',
				enabled: true,
			}),
		).toMatchObject({ enabled: 1, disabled_at: null })
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

	test('applies regressions and unsnoozes once across duplicate delivery', async () => {
		const harness = createHarness(() => 10_000)
		const env = {
			repositories: harness.repositories,
			payloads: new MemoryBlobs(),
			ingestQueue: new MemoryQueue<IngestMessage>(),
		}
		await source(harness, 'source-a')
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'before', receivedAt: 1_000 }))
		harness.sqlite.run(
			`UPDATE issues SET status = 'resolved', resolved_in_release = NULL
			 WHERE source_id = 'source-a' AND fingerprint = 'fp-shared'`,
		)
		const regression = message({ sourceId: 'source-a', eventId: 'regression', receivedAt: 2_000 })
		expect((await persistIngest(env, regression)).issue.status).toBe('open')
		expect((await persistIngest(env, regression)).duplicate).toBe(true)
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'after-regression', receivedAt: 3_000 }))
		harness.sqlite.run(
			`UPDATE issues SET status = 'ignored', snooze_until_count = 4
			 WHERE source_id = 'source-a' AND fingerprint = 'fp-shared'`,
		)
		const unsnooze = message({ sourceId: 'source-a', eventId: 'unsnooze', receivedAt: 4_000 })
		expect((await persistIngest(env, unsnooze)).issue.status).toBe('open')
		expect((await persistIngest(env, unsnooze)).duplicate).toBe(true)
		const issue = await harness.repositories.issues.get('source-a', 'fp-shared')
		expect(issue?.regressed_at).toBe(2_000)
		expect(await harness.repositories.issues.activity('source-a', 'fp-shared')).toMatchObject([
			{ kind: 'regressed', at: 2_000 },
			{ kind: 'unsnoozed', at: 4_000 },
		])
	})

	test('persists triage activity and keeps merge targets inside a source', async () => {
		const harness = createHarness(() => 10_000)
		const blobs = new MemoryBlobs()
		const env = {
			repositories: harness.repositories,
			payloads: blobs,
			ingestQueue: new MemoryQueue<IngestMessage>(),
		}
		await source(harness, 'source-a')
		await source(harness, 'source-b')
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'issue', fingerprint: 'issue' }))
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'target', fingerprint: 'target' }))
		await persistIngest(env, message({ sourceId: 'source-b', eventId: 'foreign', fingerprint: 'issue' }))
		await harness.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'issue',
			mutation: { kind: 'comment', text: 'Investigating' },
			actorId: 'user-a',
			actorLabel: 'Operator',
		})
		await harness.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'issue',
			mutation: { kind: 'assign', principalId: 'user-b', principalLabel: 'Owner' },
			actorId: 'user-a',
			actorLabel: 'Operator',
		})
		const merged = await harness.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'issue',
			mutation: { kind: 'merge', target: 'target' },
			actorId: 'user-a',
			actorLabel: 'Operator',
		})
		expect(merged?.assigned_to).toBe('user-b')
		expect(merged?.merged_into).toBe('target')
		expect((await harness.repositories.issues.activity('source-a', 'issue')).map((item) => item.kind)).toEqual([
			'comment',
			'assigned',
			'merged',
		])
		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'post-merge', fingerprint: 'issue', receivedAt: 2_000 }))
		await persistIngest(env, message({ sourceId: 'source-b', eventId: 'same-fingerprint', fingerprint: 'issue', receivedAt: 3_000 }))
		expect(await harness.repositories.ingest.counts({ sourceId: 'source-a', fingerprint: 'issue' })).toEqual([
			{ fingerprint: 'issue', count: 1, first: 1_000, last: 1_000 },
		])
		expect(await harness.repositories.ingest.counts({ sourceId: 'source-a', fingerprint: 'target' })).toEqual([
			{ fingerprint: 'target', count: 2, first: 1_000, last: 2_000 },
		])
		expect(await harness.repositories.ingest.counts({ sourceId: 'source-b', fingerprint: 'issue' })).toEqual([
			{ fingerprint: 'issue', count: 2, first: 1_000, last: 3_000 },
		])
		expect(blobs.values.has('events/source-a/target/9999999997999_post-merge.json')).toBe(true)
		await expect(
			harness.repositories.issues.mutate({
				sourceId: 'source-a',
				fingerprint: 'issue',
				mutation: { kind: 'merge', target: 'foreign' },
				actorId: null,
				actorLabel: null,
			}),
		).rejects.toThrow('Merge target does not exist in this source.')

		await persistIngest(env, message({ sourceId: 'source-a', eventId: 'final', fingerprint: 'final' }))
		await harness.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'target',
			mutation: { kind: 'merge', target: 'final' },
			actorId: null,
			actorLabel: null,
		})
		await expect(
			harness.repositories.issues.mutate({
				sourceId: 'source-a',
				fingerprint: 'issue',
				mutation: { kind: 'merge', target: 'target' },
				actorId: null,
				actorLabel: null,
			}),
		).rejects.toThrow('Merge target must be a canonical issue.')
	})

	test('claims alert windows atomically and deduplicates the notification outbox', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await source(harness, 'source-a')
		await source(harness, 'source-b')
		await harness.repositories.alerts.setConfig('source-a', { threshold: 12, enabled: true })
		await harness.repositories.alerts.setRule('source-a', 'regression', true)
		expect(await harness.repositories.alerts.getConfig('source-a')).toEqual({
			source_id: 'source-a',
			threshold: 12,
			enabled: 1,
		})
		expect(await harness.repositories.alerts.listRules('source-a')).toEqual([
			{ source_id: 'source-a', type: 'regression', enabled: 1 },
		])
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
		expect(
			await harness.repositories.alerts.enqueueNotification({
				dedupKey: 'cross-source',
				sourceId: 'source-b',
				channelId: 'channel-a',
				kind: 'spike',
				payload: {},
			}),
		).toBe(false)
		expect(await harness.repositories.alerts.deleteRule('source-a', 'regression')).toBe(true)
		expect(await harness.repositories.alerts.deleteConfig('source-a')).toBe(true)
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
