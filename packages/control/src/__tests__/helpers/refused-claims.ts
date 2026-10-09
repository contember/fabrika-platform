import { expect } from 'bun:test'
import { AppEnvChangedError, type AppEnvInput, type ControlRepositories } from '../../db'

const prod: AppEnvInput = {
	appId: 'alpha',
	env: 'prod',
	namespaceId: 'apps-prod',
	provider: 'harbor',
	providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
	providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { image: 'app:v1' } }),
}

/**
 * The reviewer's sequence, on whichever dialect `db` runs: another request creates the namespaced environment first, so
 * a put that expected none answers a conflict; a put at a generation already passed does too. Neither keeps a claim.
 */
export async function refusedClaimScenario(db: ControlRepositories): Promise<void> {
	await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
	await db.registry.createDeploymentNamespace({
		id: 'apps-prod',
		env: 'prod',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { dock: 'eu' } }),
	})
	const created = await db.registry.upsertAppEnvWithNamespaceResourceClaims(prod, ['created-first'], { absent: true })
	await expect(db.registry.upsertAppEnvWithNamespaceResourceClaims(prod, ['claimed-by-refused-write'], { absent: true })).rejects
		.toBeInstanceOf(AppEnvChangedError)
	const updated = await db.registry.upsertAppEnvWithNamespaceResourceClaims(prod, ['created-first'], { generation: created.appEnv.generation })
	await expect(db.registry.upsertAppEnvWithNamespaceResourceClaims(prod, ['claimed-by-stale-write'], { generation: created.appEnv.generation }))
		.rejects.toBeInstanceOf(AppEnvChangedError)
	expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['created-first'])
	expect((await db.registry.getAppEnv('alpha', 'prod'))?.generation).toBe(updated.appEnv.generation)
}
