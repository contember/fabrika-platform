import { describe, expect, test } from 'bun:test'
import { sweepStaleRuns } from '../provider-reconcile'
import { createHarness, queryRows } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'
import { providerEnvironment } from './helpers/provider'

// The leased sweep is the cron-driven backstop-to-the-backstop: it reaps runs left in pending/running
// past the age threshold (the per-run DO backstop should have finished them within ~18 min). Driven
// against the harness's real bun:sqlite with the production migrations, inserting runs at controlled ages.

/** Fixed wall clock (unix SECONDS) — the sweep now stamps `finished_at` caller-side, so pin it. */
const NOW = 1_700_000_000

describe('sweepStaleRuns', () => {
	test('reaps stale pending/running runs, spares recent + already-terminal ones', async () => {
		const { db, sqlite } = createHarness(() => NOW)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const OLD = NOW - 40 * 60 // beyond the 30-min threshold
		const RECENT = NOW - 5 * 60 // within it
		sqlite.exec(`
			INSERT INTO runs (id, app_id, env, ref, trigger, status, created_at, started_at) VALUES
				('old-running',   'app','prod','refs/heads/main','manual','running',   ${OLD},    ${OLD}),
				('new-running',   'app','prod','refs/heads/main','manual','running',   ${RECENT}, ${RECENT}),
				('old-pending',   'app','prod','refs/heads/main','manual','pending',   ${OLD},    NULL),
				('old-succeeded', 'app','prod','refs/heads/main','manual','succeeded', ${OLD},    ${OLD})
		`)

		const swept = await sweepStaleRuns({ repositories: db, lock: makeFakeLock(db) }, 30 * 60, () => NOW)
		expect(swept).toBe(2) // old-running + old-pending

		const statusOf = (id: string): unknown => queryRows(sqlite, 'SELECT status FROM runs WHERE id = ?', id)[0]?.status
		expect(statusOf('old-running')).toBe('failed')
		expect(statusOf('old-pending')).toBe('failed') // aged on created_at when started_at is NULL
		expect(statusOf('new-running')).toBe('running') // recent — never reaped
		expect(statusOf('old-succeeded')).toBe('succeeded') // terminal — untouched
		// A swept run gets finished_at stamped — caller-side, from the injected clock.
		expect(queryRows(sqlite, 'SELECT finished_at FROM runs WHERE id = ?', 'old-running')[0]?.finished_at).toBe(NOW)
	})

	test('a swept running run ends its log with the reason', async () => {
		const { db, sqlite } = createHarness(() => NOW)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		const old = NOW - 40 * 60
		sqlite.exec(
			`INSERT INTO runs (id, app_id, env, ref, trigger, status, created_at, started_at, log_key)
				VALUES ('stuck','app','prod','refs/heads/main','manual','running',${old},${old},'runs/stuck/logs.ndjson')`,
		)
		const stored = new Map([['runs/stuck/logs.ndjson', `${JSON.stringify({ ts: 1, stream: 'meta', text: 'resolving source' })}\n`]])
		const runLogs = {
			put: async (key: string, value: string | ArrayBuffer | ReadableStream) => {
				if (typeof value !== 'string') throw new Error('test log store accepts strings only')
				stored.set(key, value)
			},
			get: async (key: string) => {
				const value = stored.get(key)
				return value === undefined ? null : { body: new Blob([value]).stream(), text: () => Promise.resolve(value) }
			},
		}

		expect(await sweepStaleRuns({ repositories: db, lock: makeFakeLock(db), runLogs }, 30 * 60, () => NOW)).toBe(1)

		const lines = (stored.get('runs/stuck/logs.ndjson') ?? '').trim().split('\n').map((line) => JSON.parse(line).text)
		expect(lines).toEqual([
			'resolving source',
			'deploy failed: no provider accepted the run within 30 minutes of its start; run the deploy again',
		])
	})

	test('a fresh run loop is never reaped (the age guard protects in-flight deploys)', async () => {
		const { db, sqlite } = createHarness(() => NOW)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		sqlite.exec(
			`INSERT INTO runs (id, app_id, env, ref, trigger, status, created_at)
				VALUES ('fresh','app','prod','refs/heads/main','manual','running',${NOW})`,
		)
		expect(await sweepStaleRuns({ repositories: db, lock: makeFakeLock(db) }, 30 * 60, () => NOW)).toBe(0)
		expect(queryRows(sqlite, 'SELECT status FROM runs WHERE id = ?', 'fresh')[0]?.status).toBe('running')
	})

	test('does not reap a run once its provider owns an external operation', async () => {
		const { db, sqlite } = createHarness(() => NOW)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		const old = NOW - 40 * 60
		sqlite.exec(
			`INSERT INTO runs (
				id, app_id, env, ref, trigger, status, created_at, started_at, external_run_id
			) VALUES (
				'platform-owned', 'app', 'prod', 'refs/heads/main', 'manual', 'running',
				${old}, ${old}, 'version'
			)`,
		)

		expect(await sweepStaleRuns({ repositories: db, lock: makeFakeLock(db) }, 30 * 60, () => NOW)).toBe(0)
		expect(queryRows(sqlite, 'SELECT status FROM runs WHERE id = ?', 'platform-owned')[0]?.status).toBe('running')
	})
})
