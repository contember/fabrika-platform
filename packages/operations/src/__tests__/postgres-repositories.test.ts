import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyMigrations } from '../node/migrate.js'
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
	test('applies the final schema and preserves exact occurrence semantics', async () => {
		expect(await applyMigrations(db)).toEqual([])
		await repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
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
})
