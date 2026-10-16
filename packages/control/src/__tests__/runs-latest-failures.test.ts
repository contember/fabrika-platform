import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createControlRepositories } from '../db'
import { createHarness, type Harness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

type Outcome = 'succeeded' | 'failed' | 'running'

function latestFailuresContract(database: () => SqlDatabase): void {
	async function seed(appId: string, history: Record<string, Outcome[]>) {
		const sql = database()
		const repositories = createControlRepositories(sql)
		await repositories.registry.createApp({ id: appId, repoUrl: 'github.com/acme/app' })
		const ids: Record<string, string[]> = {}
		for (const [env, outcomes] of Object.entries(history)) {
			await repositories.registry.upsertAppEnv({ appId, env, namespaceId: null, provider: 'test', providerTargetJson: '{}', providerArtifactJson: '{}' })
			ids[env] = []
			for (const [index, outcome] of outcomes.entries()) {
				const id = uuidv7()
				await repositories.runs.createRun({ id, appId, env, ref: 'main', trigger: 'manual', actor: 'user:test' })
				const finishedAt = outcome === 'running' ? null : 1_000 + index
				await sql.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').bind(outcome, finishedAt, id).run()
				ids[env].push(id)
			}
		}
		const latestFailures = async () =>
			(await repositories.runs.listLatestFailedRuns()).filter((run) => run.app_id === appId).map((run) => ({ id: run.id, env: run.env }))
		return { repositories, ids, latestFailures }
	}

	test('a failure that a later finished run superseded is not listed', async () => {
		const { latestFailures } = await seed('superseded', { prod: ['failed', 'failed', 'succeeded'] })
		expect(await latestFailures()).toEqual([])
	})

	test('the newest failure is listed once, however many failures precede it', async () => {
		const { ids, latestFailures } = await seed('repeated', { prod: ['succeeded', 'failed', 'failed', 'failed'] })
		expect(await latestFailures()).toEqual([{ id: ids.prod?.[3], env: 'prod' }])
	})

	test('a run still in flight does not supersede the failure before it', async () => {
		const { ids, latestFailures } = await seed('in-flight', { prod: ['failed', 'running'] })
		expect(await latestFailures()).toEqual([{ id: ids.prod?.[0], env: 'prod' }])
	})

	test('each environment answers for itself', async () => {
		const { ids, latestFailures } = await seed('per-env', { prod: ['failed', 'succeeded'], stage: ['succeeded', 'failed'] })
		expect(await latestFailures()).toEqual([{ id: ids.stage?.[1], env: 'stage' }])
	})

	test('a deleted environment leaves nothing to fix', async () => {
		const { repositories, latestFailures } = await seed('deleted-env', { prod: ['failed'], stage: ['failed'] })
		await repositories.registry.deleteAppEnv('deleted-env', 'stage')
		expect((await latestFailures()).map((run) => run.env)).toEqual(['prod'])
	})
}

describe('latest failed runs on SQLite', () => {
	let harness: Harness
	beforeEach(() => {
		harness = createHarness()
	})
	afterEach(() => harness.sqlite.close())

	latestFailuresContract(() => harness.d1)
})

if (!hasPostgres) console.warn(`runs-latest-failures.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('latest_failures')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('latest failed runs on Postgres', () => {
	latestFailuresContract(() => fixture.db)
})
