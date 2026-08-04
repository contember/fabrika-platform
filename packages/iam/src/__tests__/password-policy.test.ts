import { describe, expect, test } from 'bun:test'
import { PASSWORD_MAX_CODE_POINTS, validatePassword } from '../password-policy'

describe('password policy', () => {
	test('normalizes NFC and accepts a long passphrase without composition rules', () => {
		const result = validatePassword(`Cafe\u0301 is a long phrase`)
		expect(result).toEqual({ ok: true, password: 'Café is a long phrase' })
	})

	test('rejects short, oversized, common, and account-context passwords', () => {
		expect(validatePassword('too short').ok).toBe(false)
		expect(validatePassword('x'.repeat(PASSWORD_MAX_CODE_POINTS + 1)).ok).toBe(false)
		expect(validatePassword('passwordpassword').ok).toBe(false)
		expect(validatePassword('person@example.test', { email: 'person@example.test' }).ok).toBe(false)
	})
})
