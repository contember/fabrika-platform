import { describe, expect, test } from 'bun:test'
import { PBKDF2_SHA256_ALGORITHM, PBKDF2_SHA256_OUTPUT_BYTES, PBKDF2_SHA256_SALT_BYTES, WebCryptoPasswordHasher } from '../password-crypto'

describe('WebCryptoPasswordHasher', () => {
	test('verifies a legacy PBKDF2 vector with extended parameters and requests a rehash', async () => {
		const hasher = new WebCryptoPasswordHasher()
		expect(
			await hasher.verify('password', {
				algorithm: PBKDF2_SHA256_ALGORITHM,
				parameters: '{"iterations":1,"outputBytes":32,"extension":true}',
				salt: '73616c74',
				passwordHash: '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
			}),
		).toEqual({ valid: true, needsRehash: true })
	})

	test.each([
		'null',
		'[]',
		'{',
		'{"iterations":"1","outputBytes":32}',
		'{"iterations":0,"outputBytes":32}',
		'{"iterations":1.5,"outputBytes":32}',
		'{"iterations":10000001,"outputBytes":32}',
		'{"iterations":1,"outputBytes":0}',
		'{"iterations":1,"outputBytes":129}',
		'{"iterations":1,"outputBytes":1.5}',
	])('fails closed on malformed persisted parameters %s', async (parameters) => {
		expect(
			await new WebCryptoPasswordHasher().verify('password', {
				algorithm: PBKDF2_SHA256_ALGORITHM,
				parameters,
				salt: '73616c74',
				passwordHash: '',
			}),
		).toEqual({ valid: false, needsRehash: false })
	})

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
