import type { ControlProvider, ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { Db } from '../db'
import { uuidv7 } from '../db'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

function testKey(): string {
	const raw = new Uint8Array(32).fill(11)
	let binary = ''
	for (const byte of raw) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const envelope = (payload: string): ProviderEnvelope => ({
	provider: 'memory',
	version: 1,
	payload,
})

const provider = (inputs: ProviderDeployInput[]): ControlProvider => ({
	id: 'memory',
	normalizeRegistration: (input) => input,
	deploy: async (input) => {
		inputs.push(input)
		return { state: 'succeeded', exitCode: 0 }
	},
})

async function seed(db: Db, valueRef: string): Promise<string> {
	await db.createApp({ id: 'app', repoUrl: 'https://github.com/acme/app.git' })
	await db.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		namespaceId: null,
		provider: 'memory',
		providerTargetJson: JSON.stringify(envelope('target')),
		providerArtifactJson: JSON.stringify(envelope('artifact')),
	})
	await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef })
	const runId = uuidv7()
	await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	return runId
}

const deps = (db: Db, vault: Vault, inputs: ProviderDeployInput[]): RunDeps => ({
	db,
	provider: provider(inputs),
	secrets: new VaultSecretResolver({ vault }),
	lock: makeFakeLock(),
})

describe('provider deploy through the vault', () => {
	test('decrypts a vault-backed value only into the in-flight provider input', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'app:app/*/API_KEY', 'SECRET-VALUE')
		const runId = await seed(db, ref)
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(deps(db, vault, inputs), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.secrets).toEqual({ API_KEY: 'SECRET-VALUE' })
	})

	test('a dangling vault ref fails before the provider receives a run', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'app:app/*/API_KEY', 'SECRET-VALUE')
		const runId = await seed(db, ref)
		await vault.delete(ref)
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(deps(db, vault, inputs), { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
		expect((await db.getRun(runId))?.status).toBe('failed')
	})
})
