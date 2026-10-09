import type { DeployLocks } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import { expect } from 'bun:test'
import { AppEnvChangedError, type AppEnvInput, type ControlRepositories } from '../../db'
import { fixtureProtect, fixtureRuns } from './lock'

const stage: AppEnvInput = {
	appId: 'acme',
	env: 'stage',
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
	providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { image: 'app:v1' } }),
}

/**
 * The reviewer's interleaving, on whichever dialect `db` runs: a run is queued for `stage` while it is unprotected; a
 * service reads the environment for a put and a delete; a human protects it; then the stale writes land. Neither the
 * stale writes nor a publication classified before the change may pass, and a recreated environment keeps the flag and
 * the counters. While the run is running, the human cannot change the flag at all.
 */
export async function protectionRaceScenario(db: ControlRepositories, locks: DeployLocks): Promise<void> {
	await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
	const read = await db.registry.upsertAppEnv(stage, { absent: true })
	expect(read).toMatchObject({ protected: 0, generation: 0, protection_revision: 0 })
	await expect(db.registry.upsertAppEnv(stage, { absent: true })).rejects.toBeInstanceOf(AppEnvChangedError)

	const owned = fixtureRuns(db.runs, locks)
	const run = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'stage', ref: 'main', trigger: 'manual', actor: 'user:ada' })
	const classifiedAt = { generation: read.generation, protectionRevision: read.protection_revision }
	const stageAt = { appId: 'acme', env: 'stage' }
	expect(await fixtureProtect(db.registry, locks, stageAt, true)).toMatchObject({ protected: 1, protection_revision: 1 })
	await owned.start(run.id, 'logs')
	const snapshot = JSON.stringify({ version: 1, contract: null, migrations: [], checker: '0.0.0', artifact: null })
	await owned.snapshot(run.id, snapshot)
	expect(await fixtureProtect(db.registry, locks, stageAt, false)).toBeNull()
	await expect(db.registry.deleteAppEnv('acme', 'stage', read.generation)).rejects.toBeInstanceOf(AppEnvChangedError)
	await expect(db.registry.upsertAppEnv(stage, { generation: read.generation })).rejects.toBeInstanceOf(AppEnvChangedError)
	await expect(db.registry.deleteApp('acme', [{ env: 'stage', generation: read.generation }])).rejects.toBeInstanceOf(AppEnvChangedError)
	expect(await owned.publish(run.id, classifiedAt, snapshot)).toBe(false)

	const current = await db.registry.getAppEnv('acme', 'stage')
	if (current === null) throw new Error('stage is gone')
	expect(await db.registry.deleteAppEnv('acme', 'stage', current.generation)).toBe(true)
	await expect(db.registry.upsertAppEnv(stage, { generation: read.generation })).rejects.toBeInstanceOf(AppEnvChangedError)
	const recreated = await db.registry.upsertAppEnv(stage, { absent: true })
	expect(recreated.protected).toBe(1)
	expect(recreated.generation).toBeGreaterThan(current.generation)
	expect(recreated.protection_revision).toBe(current.protection_revision)
	expect(await owned.publish(run.id, classifiedAt, snapshot)).toBe(false)
	expect((await db.registry.getAppEnv('acme', 'stage'))?.published_run_id).toBeNull()
}
