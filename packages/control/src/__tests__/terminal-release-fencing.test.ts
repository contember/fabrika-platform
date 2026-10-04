import { operationsReleaseName } from '@fabrika/operations-contract/releases'
import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, type RunMutationGuard, type TerminalOperationsReleaseRow } from '../db'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'
import { providerEnvironment } from './helpers/provider'

const NOW_S = 1_700_000_000
const NOW_MS = NOW_S * 1_000
const COMMIT = 'a'.repeat(40)
const originalPayload = JSON.stringify({
	runId: 'run',
	coordinate: { appId: 'notes', environment: 'prod' },
	phase: 'started',
	providerRunId: null,
	outcome: null,
	artifactState: 'pending',
	release: { kind: 'available', name: operationsReleaseName({ appId: 'notes', environment: 'prod', commitSha: COMMIT }), commitSha: COMMIT },
	observedAt: NOW_MS,
})
const terminalPayload = originalPayload.replace('"phase":"started"', '"phase":"terminal"').replace('"outcome":null', '"outcome":"succeeded"')
const guard: RunMutationGuard = { holder: 'owner', nowMs: NOW_MS, expectedProviderStateJson: null }

if (!hasPostgres) console.warn(`terminal-release-fencing.test.ts ${skipReason}`)

for (const backend of ['sqlite', 'postgres']) {
	describe.skipIf(backend === 'postgres' && !hasPostgres)(`terminal repair CAS — ${backend}`, () => {
		let database: SqlDatabase
		let repositories: ControlRepositories
		let expected: TerminalOperationsReleaseRow
		let close: () => Promise<void>
		let postgres: PostgresFixture | null

		beforeEach(async () => {
			postgres = null
			if (backend === 'postgres') {
				postgres = await createPostgres('terminal_cas')
				database = postgres.db
				close = postgres.close
			} else {
				const harness = createHarness(() => NOW_S)
				database = harness.d1
				close = () => {
					harness.sqlite.close()
					return Promise.resolve()
				}
			}
			repositories = createControlRepositories(database, { now: () => NOW_S })
			await repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
			await repositories.registry.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
			await repositories.registry.upsertAppEnv(providerEnvironment('notes', 'prod'))
			await repositories.runs.createRun({ id: 'run', appId: 'notes', env: 'prod', ref: 'main', trigger: 'manual', commitSha: COMMIT })
			await repositories.operationsReleases.project('run', originalPayload)
			await repositories.runs.markRunFinished('run', 'succeeded', 0)
			const terminal = await repositories.operationsReleases.getTerminal('run')
			if (terminal === null) throw new Error('expected terminal run')
			expected = terminal
			expect(await new SqlDeployLocks(database, { now: () => NOW_MS }).acquire('notes:prod', 'owner', 1000)).toBe(true)
		})

		afterEach(async () => close())

		test('one winner increments once and a stale diagnostic cannot overwrite the winner', async () => {
			expect(await repositories.operationsReleases.repairTerminal(expected, terminalPayload, guard)).toBe(true)
			expect(await repositories.operationsReleases.repairTerminal(expected, terminalPayload, guard)).toBe(false)
			expect(await repositories.operationsReleases.repairTerminal(expected, null, guard)).toBe(false)
			expect(await repositories.operationsReleases.get('run')).toMatchObject({ desired_revision: 2, payload_json: terminalPayload, last_error: null })
		})

		for (
			const mutation of [
				{ name: 'payload bytes without revision change', sql: 'UPDATE operations_release_sync SET payload_json = ?', value: `${originalPayload} ` },
				{ name: 'revision without payload change', sql: 'UPDATE operations_release_sync SET desired_revision = ?', value: 2 },
				{ name: 'run outcome', sql: 'UPDATE runs SET status = ?', value: 'failed' },
				{ name: 'finish time', sql: 'UPDATE runs SET finished_at = ?', value: NOW_S + 1 },
				{ name: 'external id', sql: 'UPDATE runs SET external_run_id = ?', value: 'changed-operation' },
				{ name: 'app', sql: 'UPDATE runs SET app_id = ?', value: 'other' },
				{ name: 'environment', sql: 'UPDATE runs SET env = ?', value: 'stage' },
				{ name: 'lease holder', sql: 'UPDATE deploy_locks SET holder = ?', value: 'new-owner' },
				{ name: 'expired lease', sql: 'UPDATE deploy_locks SET expires_at = ?', value: NOW_MS },
			]
		) {
			test(`stale ${mutation.name} refuses payload and diagnostic writes`, async () => {
				await database.prepare(mutation.sql).bind(mutation.value).run()
				await database.prepare('UPDATE operations_release_sync SET last_error = ? WHERE run_id = ?').bind('newer diagnostic', 'run').run()
				const before = await repositories.operationsReleases.get('run')
				expect(await repositories.operationsReleases.repairTerminal(expected, terminalPayload, guard)).toBe(false)
				expect(await repositories.operationsReleases.repairTerminal(expected, null, guard)).toBe(false)
				expect(await repositories.operationsReleases.get('run')).toEqual(before)
			})
		}

		test.skipIf(backend !== 'postgres')('two connections racing the same snapshot have one semantic winner', async () => {
			if (postgresUrl === null || postgres === null) throw new Error('Postgres fixture is required')
			const second = PostgresDatabase.connect(postgresUrl, { max: 1, connection: { search_path: postgres.schema } })
			try {
				const contender = createControlRepositories(second).operationsReleases
				const outcomes = await Promise.all([
					repositories.operationsReleases.repairTerminal(expected, terminalPayload, guard),
					contender.repairTerminal(expected, terminalPayload, guard),
				])
				expect(outcomes.filter(Boolean)).toHaveLength(1)
				expect((await repositories.operationsReleases.get('run'))?.desired_revision).toBe(2)
			} finally {
				await second.close()
			}
		})

		test.skipIf(backend !== 'postgres')('an uncommitted takeover blocks the lease fence and cannot be overwritten', async () => {
			if (postgresUrl === null || postgres === null) throw new Error('Postgres fixture is required')
			const takeover = new Bun.SQL({ url: postgresUrl, max: 1, connection: { search_path: postgres.schema } })
			let repair: Promise<boolean> | undefined
			try {
				await takeover.begin(async (tx) => {
					await tx.unsafe('UPDATE deploy_locks SET holder = $1 WHERE lock_key = $2', ['new-owner', 'notes:prod'])
					repair = repositories.operationsReleases.repairTerminal(expected, terminalPayload, guard)
					// Observe the real lock wait before committing the takeover, rather than race by timing.
					let blocked = false
					for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
						const rows = await tx.unsafe<{ blocked: boolean }[]>(`SELECT EXISTS (
							SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
								AND query LIKE '%UPDATE deploy_locks SET holder = holder%'
							) AS blocked`)
						blocked = rows[0]?.blocked === true
						if (!blocked) await Bun.sleep(5)
					}
					expect(blocked).toBe(true)
					const rows = await tx.unsafe<{ payload_json: string; desired_revision: number }[]>(
						'SELECT payload_json, desired_revision FROM operations_release_sync',
					)
					expect(rows[0]).toEqual({ payload_json: originalPayload, desired_revision: 1 })
				})
				expect(await repair).toBe(false)
				expect(await repositories.operationsReleases.get('run')).toMatchObject({ payload_json: originalPayload, desired_revision: 1 })
			} finally {
				await repair?.catch(() => {})
				await takeover.close()
			}
		})
	})
}
