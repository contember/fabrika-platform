// A deploy run's own artifact write (ADR-0043) against a REAL Postgres: it lands only under the run's lease, while the
// run runs uncancelled, and while the stored artifact is the one the run read. `run-lifecycle.test.ts` proves the
// run's use of it on SQLite.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories } from '../db'
import { LEASE_TTL_MS, runLeaseKey } from '../lease'
import { fixtureRuns } from './helpers/lock'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`registry-run-artifact-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let db: ControlRepositories
let locks: SqlDeployLocks

beforeAll(async () => {
	if (!hasPostgres || fixture !== null) return
	fixture = await createPostgres('control_run_artifact')
	db = createControlRepositories(fixture.db)
	locks = new SqlDeployLocks(fixture.db)
})

afterAll(async () => {
	await fixture?.close()
})

const artifact = (descriptor: string): string => JSON.stringify({ provider: 'harbor', version: 1, payload: { descriptor } })

/** A running run of a fresh environment, with its lease held by `holder`. */
async function runningRun(app: string, holder: string): Promise<{ runId: string; generation: number }> {
	await db.registry.createApp({ id: app, repoUrl: `github.com/acme/${app}` })
	const row = await db.registry.upsertAppEnv({
		appId: app,
		env: 'stage',
		namespaceId: null,
		provider: 'harbor',
		providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
		providerArtifactJson: artifact('registered'),
	})
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: app, env: 'stage', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	await fixtureRuns(db.runs, locks).start(runId)
	if (!(await locks.acquire(runLeaseKey(app, 'stage'), holder, LEASE_TTL_MS))) throw new Error('the run lease is held')
	return { runId, generation: row.generation }
}

describe.skipIf(!hasPostgres)("a deploy run's artifact write on Postgres", () => {
	test('lands under the lease over the artifact the run read, and advances the generation', async () => {
		const { runId, generation } = await runningRun('notes', 'run-holder')

		const row = await db.registry.replaceAppEnvArtifactForRun(runId, artifact('registered'), artifact('commit'), {
			holder: 'run-holder',
			nowMs: Date.now(),
		})

		expect(row?.provider_artifact_json).toBe(artifact('commit'))
		expect(row?.generation).toBe(generation + 1)
	})

	test('is refused over another artifact, without the lease, and for a cancelled run, and changes nothing', async () => {
		const { runId, generation } = await runningRun('tasks', 'run-holder')
		const fence = { holder: 'run-holder', nowMs: Date.now() }

		expect(await db.registry.replaceAppEnvArtifactForRun(runId, artifact('operator'), artifact('stale'), fence)).toBeNull()
		expect(await db.registry.replaceAppEnvArtifactForRun(runId, artifact('registered'), artifact('other'), { holder: 'other', nowMs: Date.now() }))
			.toBeNull()
		await db.runs.requestRunCancellation(runId)
		expect(await db.registry.replaceAppEnvArtifactForRun(runId, artifact('registered'), artifact('cancelled'), fence)).toBeNull()

		const row = await db.registry.getAppEnv('tasks', 'stage')
		expect(row?.provider_artifact_json).toBe(artifact('registered'))
		expect(row?.generation).toBe(generation)
	})
})
