import { describe, expect, test } from 'bun:test'
import { appSecretPurpose, VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { testVaultKey } from './helpers/vault'

// The vault is the only app-secret backend. A `vault:` ref has to name a row THIS app secret owns: the
// vault is shared with every other app and with the platform's own rows, and the ref is the only thing
// the registry stores. Any other ref is a row from before secrets were vault-only and fails loudly.

/** The purpose every case below resolves under: app `notes`, env `prod`, secret `API_KEY`. */
const purpose = appSecretPurpose('notes', 'prod', 'API_KEY')

describe('VaultSecretResolver', () => {
	test('vault:<id> resolves only when the row belongs to this app secret', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testVaultKey())
		const ref = await vault.putSecret(purpose.scope, purpose.label, 'from-vault')
		const resolver = new VaultSecretResolver({ vault })
		expect(await resolver.resolveSecret(ref, purpose)).toBe('from-vault')
	})

	test('a vault row belonging to another app, or to the platform, is refused instead of decrypted', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testVaultKey())
		const resolver = new VaultSecretResolver({ vault })
		const foreign = await vault.putSecret('app-env', 'app-env:other/prod/API_KEY', 'other-app-value')
		const platform = await vault.putSecret('platform', 'github-app:recovery', 'platform-value')

		await expect(resolver.resolveSecret(foreign, purpose)).rejects.toThrow(/purpose mismatch/)
		await expect(resolver.resolveSecret(platform, purpose)).rejects.toThrow(/purpose mismatch/)
		// The rows themselves are untouched — a refused read is a read, not a write.
		expect(await vault.getSecret(foreign)).toBe('other-app-value')
		expect(await vault.getSecret(platform)).toBe('platform-value')
	})

	test('the all-env layer and the env layer seal under different purposes', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testVaultKey())
		const resolver = new VaultSecretResolver({ vault })
		const allEnv = appSecretPurpose('notes', null, 'API_KEY')
		const ref = await vault.putSecret(allEnv.scope, allEnv.label, 'shared')

		expect(await resolver.resolveSecret(ref, allEnv)).toBe('shared')
		await expect(resolver.resolveSecret(ref, purpose)).rejects.toThrow(/purpose mismatch/)
	})

	test('a pre-existing non-vault ref fails with a clear error that names neither the ref nor its value', async () => {
		const { d1 } = createHarness()
		const resolver = new VaultSecretResolver({ vault: await Vault.create(d1, testVaultKey()) })
		for (const legacy of ['literal:sk-live-plaintext', 'env:STRIPE_KEY', 'secretstore:STRIPE_KEY', 'nocolon']) {
			const failure = resolver.resolveSecret(legacy, purpose)
			await expect(failure).rejects.toThrow('app secret is not stored in the vault — set its value again')
			await failure.catch((cause: unknown) => {
				expect(String(cause)).not.toContain('sk-live-plaintext')
				expect(String(cause)).not.toContain('STRIPE_KEY')
			})
		}
	})

	test('a vault ref with no vault configured fails loudly', async () => {
		const resolver = new VaultSecretResolver({})
		await expect(resolver.resolveSecret('vault:abc', purpose)).rejects.toThrow(/vault not configured/)
	})
})
