import type { IngestMessage } from '@fabrika/operations-contract'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createOperationsIngestQueue } from '../node/consumer.js'
import { applyMigrations, applyQualifiedMigrations, migrationResultMessage, postgresMigrations } from '../node/migrate.js'
import { credentialVerifier } from '../pipeline.js'
import { createPostgresOperationsRepositories, type OperationsRepositories, type RecordOccurrenceInput } from '../repositories.js'

const postgresUrl = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? null
const hasPostgres = postgresUrl !== null
if (!hasPostgres) {
	console.warn(
		'postgres-repositories.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to apply the Operations Postgres migrations and run the repository contract',
	)
}

let schema = ''
let db: PostgresDatabase
let repositories: OperationsRepositories

beforeAll(async () => {
	if (!postgresUrl) return
	schema = `operations_${Math.random().toString(36).slice(2, 10)}`
	const admin = PostgresDatabase.connect(postgresUrl)
	await admin.prepare(`CREATE SCHEMA ${schema}`).run()
	await admin.close()
	db = PostgresDatabase.connect(postgresUrl, { connection: { search_path: schema }, max: 1 })
	await applyMigrations(db)
	repositories = createPostgresOperationsRepositories(db, { now: () => 3_000 })
})

afterAll(async () => {
	if (!postgresUrl) return
	await db.close()
	const admin = PostgresDatabase.connect(postgresUrl)
	await admin.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
	await admin.close()
})

function occurrence(eventId: string, receivedAt: number): RecordOccurrenceInput {
	return {
		sourceId: 'source-a',
		fingerprint: 'fp-a',
		eventId,
		title: 'Error: portable',
		culprit: null,
		level: 'error',
		release: null,
		receivedAt,
		blobKey: `events/${eventId}.json`,
	}
}

describe.skipIf(!hasPostgres)('Operations repositories on real Postgres', () => {
	test('reports the platform jobs migration during an adopted legacy upgrade', async () => {
		if (postgresUrl === null) throw new Error('FABRIKA_TEST_POSTGRES_URL is not set')
		const legacySchema = `operations_legacy_${crypto.randomUUID().replaceAll('-', '')}`
		const admin = PostgresDatabase.connect(postgresUrl)
		await admin.prepare(`CREATE SCHEMA ${legacySchema}`).run()
		await admin.close()
		const legacy = PostgresDatabase.connect(postgresUrl, { connection: { search_path: legacySchema }, max: 1 })
		try {
			await legacy.prepare('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run()
			for (const [index, migration] of postgresMigrations().entries()) {
				await legacy.batch([
					legacy.prepare(migration.sql),
					legacy.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, index + 1),
				])
			}

			const applied = await applyQualifiedMigrations(legacy)
			expect(applied).toEqual(['platform-node/0001_jobs.sql'])
			expect(migrationResultMessage(applied)).toBe('migrations applied: platform-node/0001_jobs.sql')
			expect(await applyMigrations(legacy)).toEqual([])
		} finally {
			await legacy.close()
			const cleanup = PostgresDatabase.connect(postgresUrl)
			await cleanup.prepare(`DROP SCHEMA ${legacySchema} CASCADE`).run()
			await cleanup.close()
		}
	})

	test('installs the shared jobs bundle and runs the Operations queue contract', async () => {
		expect(await applyMigrations(db)).toEqual([])
		const { results: ledger } = await db
			.prepare('SELECT bundle, name FROM operations_schema_migrations ORDER BY bundle, name')
			.all<{ bundle: string; name: string }>()
		expect(ledger).toEqual([
			{ bundle: 'operations', name: '0001_init.sql' },
			{ bundle: 'operations', name: '0002_catalog.sql' },
			{ bundle: 'operations', name: '0003_ingest.sql' },
			{ bundle: 'operations', name: '0004_releases.sql' },
			{ bundle: 'operations', name: '0005_health.sql' },
			{ bundle: 'operations', name: '0006_operator_api.sql' },
			{ bundle: 'platform-node', name: '0001_jobs.sql' },
		])

		const message: IngestMessage = {
			projectId: 'queue-source',
			fingerprint: 'queue-fingerprint',
			eventId: 'queue-event',
			title: 'Error: queued',
			culprit: null,
			level: 'error',
			receivedAt: 1_000,
			payload: { event_id: 'queue-event', message: 'queued' },
		}
		const queue = createOperationsIngestQueue(db, { now: () => 1_000 })
		await queue.send(message)
		const jobs = await queue.claim({
			limit: 1,
			visibilityTimeoutMs: 10_000,
			decode: (value) => {
				if (JSON.stringify(value) !== JSON.stringify(message)) throw new Error('unexpected Operations queue payload')
				return message
			},
		})
		expect(jobs).toHaveLength(1)
		expect(jobs[0]?.payload.eventId).toBe(message.eventId)
		const jobId = jobs[0]?.id
		if (jobId === undefined) throw new Error('Operations queue did not return a job id')
		await queue.ack(jobId)
		expect((await db.prepare(`SELECT id FROM jobs WHERE queue = 'operations-ingest'`).all()).results).toEqual([])
	})

	test('applies the final schema and preserves exact occurrence semantics', async () => {
		expect(await applyMigrations(db)).toEqual([])
		await repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		expect(await repositories.sources.ensureIngestProjectId('source-a', '123456')).toBe('123456')
		expect(
			await repositories.sources.rotateCredential({
				id: 'credential-a',
				sourceId: 'source-a',
				verifier: await credentialVerifier('0123456789abcdef0123456789abcdef'),
				overlapUntil: 3_000,
			}),
		).toBe(true)
		expect(
			await repositories.sources.resolveIngestCredential(
				await credentialVerifier('0123456789abcdef0123456789abcdef'),
			),
		).toEqual({ sourceId: 'source-a', ingestProjectId: '123456' })
		const rateDecisions = await Promise.all(
			Array.from({ length: 4 }, () =>
				repositories.ingestRateLimits.consume({
					sourceId: 'source-a',
					windowStart: 0,
					limit: 3,
				})),
		)
		expect(rateDecisions.filter(Boolean)).toHaveLength(3)
		expect((await repositories.ingest.record(occurrence('event-a', 1_000))).duplicate).toBe(false)
		expect((await repositories.ingest.record(occurrence('event-a', 1_000))).duplicate).toBe(true)
		expect((await repositories.ingest.record(occurrence('event-b', 2_000))).duplicate).toBe(false)
		expect(await repositories.ingest.counts({ sourceId: 'source-a' })).toEqual([
			{ fingerprint: 'fp-a', count: 2, first: 1_000, last: 2_000 },
		])
		expect(
			await repositories.ingest.series({
				sourceId: 'source-a',
				since: 0,
				until: 4_000,
				buckets: 2,
			}),
		).toEqual([
			{ fingerprint: 'fp-a', bucket: 0, count: 1 },
			{ fingerprint: 'fp-a', bucket: 1, count: 1 },
		])

		await db.prepare(`UPDATE issues SET status = 'resolved', resolved_in_release = NULL
			WHERE source_id = ? AND fingerprint = ?`).bind('source-a', 'fp-a').run()
		expect((await repositories.ingest.record(occurrence('event-c', 3_000))).issue.status).toBe('open')
		expect((await repositories.ingest.record(occurrence('event-c', 3_000))).duplicate).toBe(true)
		expect((await repositories.issues.activity('source-a', 'fp-a')).map((item) => item.kind)).toEqual(['regressed'])

		await repositories.alerts.upsertChannel({
			id: 'channel-a',
			sourceId: 'source-a',
			scope: 'new_issue',
			type: 'webhook',
			target: 'https://example.test/hook',
			enabled: true,
		})
		await repositories.alerts.enqueueNotification({
			dedupKey: 'new:source-a:fp-a',
			sourceId: 'source-a',
			channelId: 'channel-a',
			kind: 'new_issue',
			payload: { fingerprint: 'fp-a' },
		})
		const claimed = await repositories.alerts.claimNotifications({ limit: 1, leaseMs: 1_000 })
		expect(claimed).toHaveLength(1)
		const notification = claimed[0]
		if (!notification) throw new Error('expected claimed notification')
		expect(
			await repositories.alerts.completeNotification({
				id: notification.id,
				claimToken: notification.claimToken,
				delivered: true,
			}),
		).toBe(true)

		const grouped = await repositories.ingest.recordGroup(
			Array.from({ length: 25 }, (_, index) => occurrence(`storm-${index}`, 4_000 + index)),
		)
		expect(grouped).toHaveLength(25)
		expect(grouped.every((result) => !result.duplicate)).toBe(true)
		expect((await repositories.ingest.counts({ sourceId: 'source-a', fingerprint: 'fp-a' }))[0]?.count).toBe(28)
	})

	test('keeps the latest observed release summary and every deploy-run link', async () => {
		await repositories.sources.upsert({
			id: 'release-source',
			appId: 'release-app',
			environment: 'production',
			displayName: 'Release App',
			enabled: true,
		})
		const commitSha = 'a'.repeat(40)
		const releaseName = `fabrika/release-app/production/default/${commitSha}`

		const record = async (input: {
			runId: string
			outcome: 'failed' | 'succeeded'
			revision: number
			observedAt: number
		}) => {
			const release = await repositories.artifacts.upsertRelease({
				id: `release-${input.runId}`,
				sourceId: 'release-source',
				runId: input.runId,
				commitSha,
				releaseName,
				state: input.outcome,
				artifactState: input.outcome === 'succeeded' ? 'complete' : 'incomplete',
				finishedAt: input.observedAt,
				observedAt: input.observedAt,
			})
			await repositories.artifacts.reconcileRunLink({
				runId: input.runId,
				sourceId: 'release-source',
				releaseId: release.id,
				availability: 'available',
				unavailableReason: null,
				phase: 'terminal',
				providerRunId: `provider-${input.runId}`,
				outcome: input.outcome,
				artifactState: input.outcome === 'succeeded' ? 'complete' : 'incomplete',
				revision: input.revision,
				projectionHash: `projection-${input.runId}-${input.revision}`,
				observedAt: input.observedAt,
			})
			return release
		}

		expect((await record({ runId: 'failed', outcome: 'failed', revision: 1, observedAt: 4_100 })).state).toBe('failed')
		expect((await record({ runId: 'retry', outcome: 'succeeded', revision: 1, observedAt: 4_300 })).run_id).toBe('retry')
		const delayed = await record({ runId: 'failed', outcome: 'failed', revision: 2, observedAt: 4_200 })
		expect(delayed.run_id).toBe('retry')
		expect(delayed.state).toBe('succeeded')
		expect(delayed.artifact_state).toBe('complete')
		expect(Number(delayed.finished_at)).toBe(4_300)
		expect(Number(delayed.updated_at)).toBe(4_300)

		const { results: links } = await db
			.prepare('SELECT run_id, projection_revision FROM deploy_run_links WHERE source_id = ? ORDER BY run_id')
			.bind('release-source')
			.all<{ run_id: string; projection_revision: number }>()
		expect(links).toEqual([
			{ run_id: 'failed', projection_revision: 2 },
			{ run_id: 'retry', projection_revision: 1 },
		])
	})
})
