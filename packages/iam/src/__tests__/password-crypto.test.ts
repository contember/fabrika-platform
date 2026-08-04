import { describe, expect, test } from 'bun:test'
import { PBKDF2_SHA256_ALGORITHM, PBKDF2_SHA256_OUTPUT_BYTES, PBKDF2_SHA256_SALT_BYTES, WebCryptoPasswordHasher } from '../password-crypto'

describe('WebCryptoPasswordHasher', () => {
	test('hashes and verifies without storing the password', async () => {
		const hasher = new WebCryptoPasswordHasher()
		const stored = await hasher.hash('correct horse battery staple')

		expect(stored.algorithm).toBe(PBKDF2_SHA256_ALGORITHM)
		expect(stored.salt).toHaveLength(PBKDF2_SHA256_SALT_BYTES * 2)
		expect(stored.passwordHash).toHaveLength(PBKDF2_SHA256_OUTPUT_BYTES * 2)
		expect(stored.passwordHash).not.toContain('correct')
		expect(await hasher.verify('correct horse battery staple', stored)).toEqual({ valid: true, needsRehash: false })
		expect(await hasher.verify('wrong', stored)).toEqual({ valid: false, needsRehash: false })
	})

	test('rejects unknown algorithms and malformed encodings', async () => {
		const hasher = new WebCryptoPasswordHasher()
		const stored = await hasher.hash('password')

		expect(await hasher.verify('password', { ...stored, algorithm: 'unknown' })).toEqual({ valid: false, needsRehash: false })
		expect(await hasher.verify('password', { ...stored, salt: 'not-hex' })).toEqual({ valid: false, needsRehash: false })
		expect(await hasher.verify('password', { ...stored, parameters: '{}' })).toEqual({ valid: false, needsRehash: false })
	})
})
