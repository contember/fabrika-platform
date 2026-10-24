import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ControlRepositories } from '../db'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { contractCommits } from './helpers/commits'
import { createHarness } from './helpers/harness'
import { fixtureProtect, makeFakeLock } from './helpers/lock'

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
	resolveSource: () => Promise.resolve({ commitSha: 'c'.repeat(40) }),
	deploy: async (input) => {
		inputs.push(input)
		return { state: 'succeeded', exitCode: 0 }
	},
})

async function seed(db: ControlRepositories, valueRef: string): Promise<string> {
	await db.registry.createApp({ id: 'app', repoUrl: 'https://github.com/acme/app.git' })
	await db.registry.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		namespaceId: null,
		provider: 'memory',
		providerTargetJson: JSON.stringify(envelope('target')),
		providerArtifactJson: JSON.stringify(envelope('artifact')),
	})
	// Unprotected, so the first contract publishes without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'app', env: 'prod' }, false)
	await db.registry.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef })
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
	return runId
}

const deps = (db: ControlRepositories, vault: Vault, inputs: ProviderDeployInput[]): RunDeps => ({
	repositories: db,
	provider: provider(inputs),
	secrets: new VaultSecretResolver({ vault }),
	lock: makeFakeLock(db),
	logs: { put: () => Promise.resolve() },
	commits: contractCommits('app'),
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
		expect((await db.runs.getRun(runId))?.status).toBe('failed')
	})
})
