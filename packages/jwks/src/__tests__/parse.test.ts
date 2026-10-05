import { describe, expect, test } from 'bun:test'
import { parseJwks } from '../index'
import { PUBLIC_JWKS } from './helpers'

describe('parseJwks', () => {
	test('requires own keys and kty, ignores inherited optional fields, and rejects own undefined', () => {
		expect(parseJwks(Object.create({ keys: [{ kty: 'EC' }] }))).toBeNull()
		expect(parseJwks({ keys: [Object.create({ kty: 'EC' })] })).toBeNull()
		const key: object = Object.create({ kid: 'inherited', x: 42 })
		Object.defineProperty(key, 'kty', { value: 'EC' })
		expect(parseJwks({ keys: [key] })).toStrictEqual({ keys: [{ kty: 'EC' }] })
		Object.defineProperty(key, 'kid', { value: undefined })
		expect(parseJwks({ keys: [key] })).toBeNull()
	})

	test('preserves EC values, key order and optional property presence while dropping extra fields', () => {
		const keys = [
			...PUBLIC_JWKS.keys,
			{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
			{ kty: 'EC', kid: '', alg: '', use: '' },
			{ kty: 'EC' },
		]
		expect(parseJwks({ keys: keys.map(key => ({ ...key, extra: true, d: 'private' })), extra: true })).toStrictEqual({ keys })
	})

	test('an empty set remains empty', () => {
		expect(parseJwks({ keys: [] })).toStrictEqual({ keys: [] })
	})

	const malformed: [string, unknown][] = [
		['null', null],
		['a primitive', 'keys'],
		['an array', []],
		['missing keys', {}],
		['keys is not an array', { keys: {} }],
		['a null member', { keys: [null] }],
		['a primitive member', { keys: ['EC'] }],
		['an array member', { keys: [[]] }],
		['missing kty', { keys: [{ crv: 'P-256' }] }],
		['non-string kty', { keys: [{ kty: 42 }] }],
		['mixed EC and RSA', { keys: [...PUBLIC_JWKS.keys, { kty: 'RSA', n: 'modulus', e: 'AQAB' }] }],
		['mixed EC and OKP', { keys: [...PUBLIC_JWKS.keys, { kty: 'OKP', crv: 'Ed25519', x: 'x' }] }],
		['a symmetric key', { keys: [{ kty: 'oct', k: 'secret' }] }],
	]
	for (const [name, body] of malformed) {
		test(`rejects ${name}`, () => {
			expect(parseJwks(body)).toBeNull()
		})
	}

	for (const field of ['crv', 'x', 'y', 'kid', 'alg', 'use']) {
		test(`rejects a present non-string ${field} rather than dropping it`, () => {
			for (const value of [null, 42, false, {}, [], undefined]) {
				expect(parseJwks({ keys: [...PUBLIC_JWKS.keys, { kty: 'EC', [field]: value }] })).toBeNull()
			}
		})
	}
})
