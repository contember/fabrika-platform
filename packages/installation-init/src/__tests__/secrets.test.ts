import { describe, expect, test } from 'bun:test'
import { generateInstallationSecrets } from '../secrets'

describe('the generated secrets', () => {
	test('each has the shape the service that reads it parses', () => {
		const secrets = generateInstallationSecrets()

		const signingKeys: unknown = JSON.parse(secrets.signingKeys)
		expect(Array.isArray(signingKeys)).toBe(true)
		const active = Array.isArray(signingKeys) ? signingKeys[0] : undefined
		expect(active).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
		// The private half: without `d` IAM can verify and never sign.
		expect(active).toHaveProperty('d', expect.any(String))
		expect(active).toHaveProperty('kid', expect.any(String))

		for (const key of [secrets.rpcKey, secrets.proxyKey, secrets.provisioningKey]) {
			expect(key).toStartWith('px_')
			// 32 bytes at base64url is 43 characters; every shared secret must clear 32 or the service
			// refuses to boot.
			expect(key.slice(3)).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(key.length).toBeGreaterThanOrEqual(32)
		}
		expect(secrets.operationsSyncKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
		// base64, NOT base64url: the vault imports these bytes as an AES key.
		expect(secrets.vaultKey).toMatch(/^[A-Za-z0-9+/]{43}=$/)
		expect(Buffer.from(secrets.vaultKey, 'base64')).toHaveLength(32)
	})

	test('no base64url value starts with `-` or `_`, which downstream would read as a flag', () => {
		// One roll in sixteen starts with one of them, so a hundred rolls is the cheap version of a proof.
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const secrets = generateInstallationSecrets()
			for (
				const value of [
					secrets.rpcKey.slice(3),
					secrets.proxyKey.slice(3),
					secrets.provisioningKey.slice(3),
					secrets.operationsSyncKey,
				]
			) {
				expect(value.startsWith('-') || value.startsWith('_')).toBe(false)
			}
		}
	})

	test('every value is fresh — nothing is reused between two installations', () => {
		const first = generateInstallationSecrets()
		const second = generateInstallationSecrets()
		expect(Object.values(first)).not.toEqual(Object.values(second))
	})
})
