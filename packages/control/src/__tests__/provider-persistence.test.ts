import { describe, expect, test } from 'bun:test'
import { parseProviderJson, serializeProviderJson } from '../db/runs'
import { createHarness } from './helpers/harness'
import { fixtureNamespaceWrite, fixtureRuns, makeFakeLock } from './helpers/lock'

const targetJson = JSON.stringify({ provider: 'harbor', version: 2, payload: { region: 'eu-west' } })
const artifactJson = JSON.stringify({ provider: 'harbor', version: 4, payload: { image: 'registry.example/app:v4' } })

const appEnvironment = (appId: string, env: string) => ({
	appId,
	env,
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: targetJson,
	providerArtifactJson: artifactJson,
})

describe('generic provider persistence', () => {
	test('round-trips a third provider without changing the schema or query surface', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		const stored = await db.registry.upsertAppEnv(appEnvironment('app', 'prod'))

		expect(stored.provider).toBe('harbor')
		expect(stored.provider_target_json).toBe(targetJson)
		expect(stored.provider_artifact_json).toBe(artifactJson)
		expect((await db.registry.listAppEnvsByProvider('harbor')).map((row) => row.env)).toEqual(['prod'])
		expect(await db.registry.listAppEnvsByProvider('other')).toHaveLength(0)
	})

	test('persists and lists provider-owned external runs generically', async () => {
		const now = 2_000_000
		const { db, sqlite } = createHarness(() => now)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(appEnvironment('app', 'prod'))
		const run = await db.runs.createRun({ id: 'run-1', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		const owned = fixtureRuns(db.runs, makeFakeLock(db))
		await owned.start(run.id, 'runs/run-1/logs.ndjson')

		expect(await owned.externalId(run.id, 'harbor-operation-7')).toBe(true)
		expect((await db.runs.getRun(run.id))?.external_run_id).toBe('harbor-operation-7')
		expect((await db.runs.listInFlightRuns('harbor')).map((row) => row.id)).toEqual(['run-1'])
		expect(await db.runs.listInFlightRuns('other')).toHaveLength(0)

		sqlite.query('UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?').run(now - 7200, now - 7200, run.id)
		expect(await db.runs.listStaleRuns(3600)).toHaveLength(0)
		expect((await db.runs.getRun(run.id))?.status).toBe('running')
	})

	test('round-trips namespaces and namespace-owned or app-owned resource claims', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		const namespace = await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})
		await db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: namespace.id })
		await db.registry.upsertAppEnv({ ...appEnvironment('beta', 'prod'), namespaceId: namespace.id })
		await db.registry.createNamespaceResourceClaim({
			namespaceId: namespace.id,
			resourceKey: 'proxy',
			ownerAppId: null,
			ownerEnv: null,
		})
		await db.registry.createNamespaceResourceClaim({
			namespaceId: namespace.id,
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})
		await fixtureNamespaceWrite(db, namespace.id, 'ready', {
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 3, payload: { dock: '7' } }),
		})

		expect((await db.registry.listDeploymentNamespaces()).map((row) => [row.id, row.state])).toEqual([['apps-prod', 'ready']])
		expect((await db.registry.getDeploymentNamespace(namespace.id))?.provider_target_json)
			.toBe(JSON.stringify({ provider: 'harbor', version: 3, payload: { dock: '7' } }))
		expect((await db.registry.getAppEnv('alpha', 'prod'))?.namespace_id).toBe('apps-prod')
		expect((await db.registry.listAppEnvsByNamespace('apps-prod')).map((row) => row.app_id)).toEqual(['alpha', 'beta'])
		expect((await db.registry.listNamespaceResourceClaims(namespace.id)).map((claim) => [
			claim.resource_key,
			claim.owner_app_id,
		])).toEqual([
			['alpha-api', 'alpha'],
			['proxy', null],
		])
	})

	test('acquires claims idempotently and atomically with an environment upsert', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})

		const first = await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod', domain: 'alpha.example' },
			['z-shared', 'alpha-worker', 'alpha-worker'],
		)
		expect(first.resourceClaims.map((claim) => claim.resource_key)).toEqual(['alpha-worker', 'z-shared'])

		const retried = await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod', domain: 'new-alpha.example' },
			['z-shared'],
		)
		expect(retried.appEnv.domain).toBe('new-alpha.example')
		expect(retried.resourceClaims[0]?.created_at).toBe(first.resourceClaims[1]?.created_at)
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])

		await expect(db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('beta', 'prod'), namespaceId: 'apps-prod' },
			['beta-worker', 'z-shared'],
		)).rejects.toThrow('namespace resource claim owner is immutable')
		expect(await db.registry.getAppEnv('beta', 'prod')).toBeNull()
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])
	})

	test('keeps historical claims when an undeployed environment moves namespaces', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		for (const id of ['first', 'second']) {
			await db.registry.createDeploymentNamespace({
				id,
				env: 'prod',
				provider: 'harbor',
				exclusiveAppId: null,
				providerTargetJson: targetJson,
			})
		}
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'first' },
			['alpha-api'],
		)
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'second' },
			['alpha-api'],
		)

		expect((await db.registry.getAppEnv('alpha', 'prod'))?.namespace_id).toBe('second')
		expect((await db.registry.listNamespaceResourceClaims('first')).map((claim) => claim.resource_key)).toEqual(['alpha-api'])
		expect((await db.registry.listNamespaceResourceClaims('second')).map((claim) => claim.resource_key)).toEqual(['alpha-api'])
	})

	test('enforces namespace coordinates and resource ownership constraints', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})
		await db.registry.createDeploymentNamespace({
			id: 'other-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
		})

		await expect(db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'stage'), namespaceId: 'apps-prod' })).rejects.toThrow()
		await expect(db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: 'other-prod' })).rejects.toThrow()
		await db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod' })
		await db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})).resolves.toMatchObject({
			namespace_id: 'apps-prod',
			resource_key: 'alpha-api',
			owner_app_id: 'alpha',
			owner_env: 'prod',
		})
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: null,
			ownerEnv: null,
		})).rejects.toThrow()
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'broken-owner',
			ownerAppId: 'alpha',
			ownerEnv: null,
		})).rejects.toThrow()
		await expect(db.registry.deleteAppEnv('alpha', 'prod')).rejects.toThrow()
	})
})

describe('provider checkpoint JSON', () => {
	test('keeps keys, order and shared references byte-exact and refuses non-finite numbers', () => {
		const raw = '{"z":1,"__proto__":{"kept":true},"a":[null,false,"x"]}'
		expect(serializeProviderJson(parseProviderJson(raw, 'checkpoint'))).toBe(raw)
		const shared = { value: 1 }
		expect(serializeProviderJson({ first: shared, second: shared })).toBe('{"first":{"value":1},"second":{"value":1}}')
		expect(() => parseProviderJson('1e400', 'checkpoint')).toThrow('checkpoint is not a JSON value')
		expect(() => serializeProviderJson({ value: Number.NaN })).toThrow('provider checkpoint is not a JSON value')
	})
})
