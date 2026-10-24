import type { ProxySecrets } from '../../proxy-secret'
import { Vault } from '../../vault'
import { createHarness } from './harness'

/** A fixed, valid base64 AES-256 KEK — tests only. */
export function testVaultKey(): string {
	return btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
}

/** A vault over its own in-memory database, for tests whose registry and vault need not share one. */
export function createTestVault(): Promise<Vault> {
	return Vault.create(createHarness().d1, testVaultKey())
}

/** One proxy secret for every environment, for a deploy whose test does not look at it. */
export const fixedProxySecrets: ProxySecrets = { forAppEnv: () => Promise.resolve('p'.repeat(43)) }
