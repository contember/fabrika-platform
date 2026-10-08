// The proxy secret of an application environment (ADR-0022 rule 5): generated once, sealed in the vault, and owned by
// the environment whose purpose it was sealed under.

import { describe, expect, test } from 'bun:test'
import { proxySecretPurpose, VaultProxySecrets } from '../proxy-secret'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))

async function setup() {
	const harness = createHarness()
	const { registry } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	for (const env of ['prod', 'stage']) {
		await registry.upsertAppEnv({ appId: 'notes', env, namespaceId: null, provider: 'test', providerTargetJson: '{}', providerArtifactJson: '{}' })
	}
	const vault = await Vault.create(harness.d1, KEY)
	return { harness, registry, vault, secrets: new VaultProxySecrets(registry, () => Promise.resolve(vault)) }
}

describe('VaultProxySecrets', () => {
	test('generates one secret per environment and answers the same one after', async () => {
		const { secrets } = await setup()
		const prod = await secrets.forAppEnv('notes', 'prod')
		expect(prod).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(await secrets.forAppEnv('notes', 'prod')).toBe(prod)
		expect(await secrets.forAppEnv('notes', 'stage')).not.toBe(prod)
	})

	test('stores only a vault ref, and the vault only ciphertext under the platform label of the environment', async () => {
		const { harness, secrets } = await setup()
		const prod = await secrets.forAppEnv('notes', 'prod')
		expect(JSON.stringify(queryRows(harness.sqlite, 'SELECT * FROM app_env_proxy_secrets'))).not.toContain(prod)
		const rows = queryRows(harness.sqlite, 'SELECT scope, label, ciphertext FROM vault')
		expect(rows.map((row) => [row['scope'], row['label']])).toEqual([['platform', 'platform:proxy-secret:notes@prod']])
		expect(JSON.stringify(rows)).not.toContain(prod)
	})

	test('a lost race keeps the recorded secret and deletes its own vault row', async () => {
		const { harness, registry, vault } = await setup()
		const winner = await new VaultProxySecrets(registry, () => Promise.resolve(vault)).forAppEnv('notes', 'prod')
		let reads = 0
		const late = new VaultProxySecrets({
			// The first read happens before the winner recorded its ref.
			getAppEnvProxySecretRef: (appId, env) => reads++ === 0 ? Promise.resolve(null) : registry.getAppEnvProxySecretRef(appId, env),
			claimAppEnvProxySecretRef: (appId, env, ref) => registry.claimAppEnvProxySecretRef(appId, env, ref),
		}, () => Promise.resolve(vault))
		expect(await late.forAppEnv('notes', 'prod')).toBe(winner)
		expect(queryRows(harness.sqlite, 'SELECT id FROM vault')).toHaveLength(1)
	})

	test("a ref to another environment's vault row is refused, never answered", async () => {
		const { harness, registry, secrets } = await setup()
		await secrets.forAppEnv('notes', 'stage')
		const stageRef = await registry.getAppEnvProxySecretRef('notes', 'stage')
		harness.sqlite.query('INSERT INTO app_env_proxy_secrets (app_id, env, value_ref) VALUES (?, ?, ?)').run('notes', 'prod', stageRef ?? '')
		await expect(secrets.forAppEnv('notes', 'prod')).rejects.toThrow('vault secret purpose mismatch')
	})

	test('the purpose names the IAM application id of the environment', () => {
		expect(proxySecretPurpose('notes', 'prod')).toEqual({ scope: 'platform', label: 'platform:proxy-secret:notes@prod' })
	})
})
