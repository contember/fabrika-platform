import { describe, expect, test } from 'bun:test'
import { appSecretPurpose, EnvSecretResolver, type SecretStoreEntry, VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'

// The ref-scheme dispatch: a ref's `<backend>:` prefix selects WHICH backend resolves it. These cover
// every scheme — vault / secretstore / env / literal — plus the fail-loud behaviour for missing
// backends and unknown schemes. The resolver handles per-app secret refs (`resolveSecret`).
//
// A `vault:` ref additionally has to name a row THIS app secret owns: the vault is shared with every
// other app and with the platform's own rows, and the ref is the only thing the registry stores.

/** The purpose every case below resolves under: app `notes`, env `prod`, secret `API_KEY`. */
const purpose = appSecretPurpose('notes', 'prod', 'API_KEY')

function testKey(): string {
	const raw = new Uint8Array(32).fill(7)
	let binary = ''
	for (const b of raw) binary += String.fromCharCode(b)
	return btoa(binary)
}

/** A fake CF Secrets Store entry (the real binding's `get()` is the same shape). */
class FakeStoreEntry implements SecretStoreEntry {
	constructor(private readonly value: string) {}
	get(): Promise<string> {
		return Promise.resolve(this.value)
	}
}

describe('VaultSecretResolver dispatch', () => {
	test('vault:<id> resolves only when the row belongs to this app secret', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret(purpose.scope, purpose.label, 'from-vault')
		const resolver = new VaultSecretResolver({ vault })
		expect(await resolver.resolveSecret(ref, purpose)).toBe('from-vault')
	})

	test('a vault row belonging to another app, or to the platform, is refused instead of decrypted', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
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
		const vault = await Vault.create(d1, testKey())
		const resolver = new VaultSecretResolver({ vault })
		const allEnv = appSecretPurpose('notes', null, 'API_KEY')
		const ref = await vault.putSecret(allEnv.scope, allEnv.label, 'shared')

		expect(await resolver.resolveSecret(ref, allEnv)).toBe('shared')
		await expect(resolver.resolveSecret(ref, purpose)).rejects.toThrow(/purpose mismatch/)
	})

	test('secretstore:<name> → the CF Secrets Store entry', async () => {
		const resolver = new VaultSecretResolver({ secretStore: { ACME_CF_TOKEN: new FakeStoreEntry('store-token') } })
		expect(await resolver.resolveSecret('secretstore:ACME_CF_TOKEN', purpose)).toBe('store-token')
	})

	test('secretstore: with no binding present fails loudly (CF-only path)', async () => {
		const resolver = new VaultSecretResolver({ secretStore: {} })
		await expect(resolver.resolveSecret('secretstore:MISSING', purpose)).rejects.toThrow(/CF-only/)
		// Also when the whole secretStore map is absent.
		const noStore = new VaultSecretResolver({})
		await expect(noStore.resolveSecret('secretstore:X', purpose)).rejects.toThrow()
	})

	test('env:NAME → the provided env source; missing var throws (no value leak)', async () => {
		const resolver = new VaultSecretResolver({ env: { TOKEN: 'env-value' } })
		expect(await resolver.resolveSecret('env:TOKEN', purpose)).toBe('env-value')
		await expect(resolver.resolveSecret('env:NOPE', purpose)).rejects.toThrow(/env var not present/)
	})

	test('literal:VALUE → the value verbatim', async () => {
		const resolver = new VaultSecretResolver({})
		expect(await resolver.resolveSecret('literal:plain', purpose)).toBe('plain')
		expect(await resolver.resolveSecret('literal:', purpose)).toBe('') // empty literal is valid
	})

	test('a vault ref with no vault configured fails loudly', async () => {
		const resolver = new VaultSecretResolver({ env: {} })
		await expect(resolver.resolveSecret('vault:abc', purpose)).rejects.toThrow(/vault backend not configured/)
	})

	test('unknown scheme + a ref with no colon both throw', async () => {
		const resolver = new VaultSecretResolver({})
		await expect(resolver.resolveSecret('wat:foo', purpose)).rejects.toThrow(/unsupported/)
		await expect(resolver.resolveSecret('nocolon', purpose)).rejects.toThrow(/<backend>/)
	})
})

describe('EnvSecretResolver (dev/test backward-compat)', () => {
	test('still resolves env: and literal:', async () => {
		const resolver = new EnvSecretResolver({ T: 'tok' })
		expect(await resolver.resolveSecret('env:T', purpose)).toBe('tok')
		expect(await resolver.resolveSecret('literal:v', purpose)).toBe('v')
		await expect(resolver.resolveSecret('env:MISSING', purpose)).rejects.toThrow()
	})
})
