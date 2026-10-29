// A run's lane (the workspace of a dev bootstrap): only a newer succeeded run of the SAME lane supersedes a pending run,
// with no lane being a lane of its own. SQLite always, Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createManualRun } from '../api/runs'
import { type ControlRepositories, createControlRepositories } from '../db'
import { createHarness, type Harness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { fixtureRuns } from './helpers/lock'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

function laneContract(database: () => SqlDatabase): void {
	let repositories: ControlRepositories
	let owned: ReturnType<typeof fixtureRuns>
	let appId: string

	beforeEach(async () => {
		const sql = database()
		repositories = createControlRepositories(sql)
		owned = fixtureRuns(repositories.runs, new SqlDeployLocks(sql))
		appId = `lane${uuidv7().replaceAll('-', '').slice(-12)}`
		await repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
		await repositories.registry.upsertAppEnv({
			appId,
			env: 'dev',
			namespaceId: null,
			provider: 'test',
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
		})
	})

	const create = (lane: string | null) =>
		repositories.runs.createRun({ id: uuidv7(), appId, env: 'dev', ref: 'main', trigger: 'manual', actor: 'user:test', lane })

	async function succeed(lane: string | null): Promise<string> {
		const run = await create(lane)
		expect(await owned.start(run.id)).toBe(true)
		expect(await owned.finish(run.id, 'succeeded', 0)).toBe(true)
		return run.id
	}

	test('a succeeded run of another lane neither supersedes a pending run nor blocks its start', async () => {
		const pending = await create('workspace-b')
		const other = await succeed('workspace-a')
		const unlaned = await succeed(null)
		expect(pending.lane).toBe('workspace-b')
		expect(await repositories.runs.getSupersedingRun(pending.id)).toBeNull()
		expect(await owned.supersede(pending.id, other)).toBe(false)
		expect(await owned.supersede(pending.id, unlaned)).toBe(false)
		expect(await owned.start(pending.id)).toBe(true)
	})

	test('a newer succeeded run of the same lane still supersedes', async () => {
		const pending = await create('workspace-a')
		const newer = await succeed('workspace-a')
		expect((await repositories.runs.getSupersedingRun(pending.id))?.id).toBe(newer)
		expect(await owned.start(pending.id)).toBe(false)
		expect(await owned.supersede(pending.id, newer)).toBe(true)
		expect(await repositories.runs.getRun(pending.id)).toMatchObject({ status: 'failed', superseded_by: newer })
	})

	test('runs with no lane supersede each other, and a laned run does not supersede them', async () => {
		const pending = await create(null)
		const laned = await succeed('workspace-a')
		expect(await repositories.runs.getSupersedingRun(pending.id)).toBeNull()
		expect(await owned.supersede(pending.id, laned)).toBe(false)
		const newer = await succeed(null)
		expect((await repositories.runs.getSupersedingRun(pending.id))?.id).toBe(newer)
		expect(await owned.start(pending.id)).toBe(false)
		expect(await owned.supersede(pending.id, newer)).toBe(true)
	})

	test('a manual run persists its lane, and has none unless given one', async () => {
		const context = {
			repositories,
			queue: { send: () => Promise.resolve() },
			auth: allowAllAuth(),
		}
		const laned = await createManualRun(context, { appId, env: 'dev', ref: 'main', lane: 'workspace-a' })
		const plain = await createManualRun(context, { appId, env: 'dev', ref: 'main' })
		expect((await repositories.runs.getRun(laned.id))?.lane).toBe('workspace-a')
		expect((await repositories.runs.getRun(plain.id))?.lane).toBeNull()
	})
}

describe('run lanes on SQLite', () => {
	let harness: Harness
	beforeEach(() => {
		harness = createHarness()
	})
	afterEach(() => harness.sqlite.close())

	laneContract(() => harness.d1)
})

if (!hasPostgres) console.warn(`runs-lane.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('run_lanes')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('run lanes on Postgres', () => {
	laneContract(() => fixture.db)
})
