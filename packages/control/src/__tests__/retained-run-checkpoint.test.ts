import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createControlRepositories } from '../db'
import { retainedCheckpointReader } from '../retained-run-checkpoints'
import { createHarness, type Harness } from './helpers/harness'

let harness: Harness
beforeEach(() => {
	harness = createHarness()
})
afterEach(() => harness.sqlite.close())

const createRun = async (id: string, appId: string, env: string, externalId: string, state: string) => {
	const { registry, runs } = createControlRepositories(harness.d1)
	if (await registry.getApp(appId) === null) await registry.createApp({ id: appId, repoUrl: 'github.com/example/application' })
	await registry.upsertAppEnv({
		appId,
		env,
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	await runs.createRun({ id, appId, env, ref: 'main', trigger: 'manual' })
	await runs.markRunStarted(id, `${id}.log`)
	await runs.setRunExternalId(id, externalId, { binding: state })
	return runs
}

test('retained lookup is scoped to the exact app, environment and external version', async () => {
	const runs = await createRun('old', 'app', 'prod', 'version-a', 'old-binding')
	await runs.markRunFinished('old', 'failed', 1)
	await createRun('new', 'app', 'prod', 'version-b', 'new-binding')
	await createRun('other-app', 'other', 'prod', 'version-a', 'other-app-binding')
	await createRun('other-env', 'app', 'stage', 'version-a', 'other-env-binding')
	const retained = await runs.getRunByExternalId({ appId: 'app', env: 'prod', externalId: 'version-a' })
	expect(retained?.id).toBe('old')
	expect(retained?.provider_state_json).toBe('{"binding":"old-binding"}')
	expect(retained?.status).toBe('failed')
	expect(await runs.getRunByExternalId({ appId: 'missing', env: 'prod', externalId: 'version-a' })).toBeNull()
	expect(await runs.getRunByExternalId({ appId: 'app', env: 'missing', externalId: 'version-a' })).toBeNull()
	expect(await runs.getRunByExternalId({ appId: 'app', env: 'prod', externalId: 'missing' })).toBeNull()
})

test('ambiguous retained versions are refused rather than selecting an arbitrary binding', async () => {
	const runs = await createRun('first', 'app', 'prod', 'version-a', 'first-binding')
	await createRun('second', 'app', 'prod', 'version-a', 'second-binding')
	await expect(runs.getRunByExternalId({ appId: 'app', env: 'prod', externalId: 'version-a' }))
		.rejects.toThrow('ambiguous retained run state')
})

test('the provider callback parses only its scoped retained checkpoint and honors cancellation', async () => {
	const runs = await createRun('own', 'app', 'prod', 'version-a', 'owned')
	await createRun('foreign', 'other', 'prod', 'version-b', 'foreign')
	const controller = new AbortController()
	const read = retainedCheckpointReader(runs, { appId: 'app', env: 'prod' }, controller.signal)
	expect(await read('version-a')).toEqual({ binding: 'owned' })
	expect(await read('version-b')).toBeNull()
	await harness.d1.prepare('UPDATE runs SET provider_state_json = ? WHERE id = ?')
		.bind('invalid-private-sentinel', 'own').run()
	await expect(read('version-a')).rejects.toThrow('retained provider checkpoint is not valid JSON')
	controller.abort(new Error('lookup cancelled'))
	await expect(read('version-a')).rejects.toThrow('lookup cancelled')
})
