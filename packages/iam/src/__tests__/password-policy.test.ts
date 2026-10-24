import { PASSWORD_DEFAULT_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH_FLOOR } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { catalogFor } from '../catalog'
import { BUN_PBKDF2_COST, WORKERS_PBKDF2_COST } from '../password-crypto'
import { minLengthProblem, passwordMinLengthFloor, storedMinLength } from '../password-minimum'
import { PASSWORD_MAX_CODE_POINTS, validatePassword } from '../password-policy'

describe('password policy', () => {
	test('normalizes NFC and accepts a long passphrase without composition rules', () => {
		const result = validatePassword(`Cafe\u0301 is a long phrase`, PASSWORD_DEFAULT_MIN_LENGTH)
		expect(result).toEqual({ ok: true, password: 'Café is a long phrase' })
	})

	test('rejects short, oversized, common, and account-context passwords', () => {
		expect(validatePassword('too short', PASSWORD_DEFAULT_MIN_LENGTH)).toEqual({ ok: false, problem: 'too_short' })
		expect(validatePassword('x'.repeat(PASSWORD_MAX_CODE_POINTS + 1), PASSWORD_DEFAULT_MIN_LENGTH)).toEqual({ ok: false, problem: 'too_long' })
		expect(validatePassword('passwordpassword', PASSWORD_DEFAULT_MIN_LENGTH)).toEqual({ ok: false, problem: 'guessable' })
		expect(validatePassword('person@example.test', PASSWORD_DEFAULT_MIN_LENGTH, { email: 'person@example.test' })).toEqual({
			ok: false,
			problem: 'guessable',
		})
	})

	test('the minimum is the one given: a password one code point shorter is refused, one of its length accepted', () => {
		expect(validatePassword('tulip-42', 10)).toEqual({ ok: false, problem: 'too_short' })
		expect(validatePassword('tulip-42x', 10)).toEqual({ ok: false, problem: 'too_short' })
		expect(validatePassword('tulip-42xy', 10)).toEqual({ ok: true, password: 'tulip-42xy' })
		// Code points, not UTF-16 units: five emoji are five characters.
		expect(validatePassword('🌷🌷🌷🌷🌷', 5)).toEqual({ ok: true, password: '🌷🌷🌷🌷🌷' })
		expect(validatePassword('🌷🌷🌷🌷', 5)).toEqual({ ok: false, problem: 'too_short' })
	})

	test('a short minimum still refuses the common passwords, in any case, Czech ones included', () => {
		for (const common of ['12345', 'password', 'Qwerty', 'LETMEIN', 'abc123', 'heslo123', 'Ahoj', 'qwertz']) {
			expect([common, validatePassword(common, PASSWORD_MIN_LENGTH_FLOOR)]).toEqual([common, { ok: false, problem: 'guessable' }])
		}
		expect(validatePassword('k7#q2', 5)).toEqual({ ok: true, password: 'k7#q2' })
	})
})

describe('the minimum an installation may set', () => {
	test('the floor is low only where verifiers meet OWASP: the Bun process 4, a Worker the default', () => {
		expect(passwordMinLengthFloor(BUN_PBKDF2_COST)).toBe(PASSWORD_MIN_LENGTH_FLOOR)
		expect(passwordMinLengthFloor(WORKERS_PBKDF2_COST)).toBe(PASSWORD_DEFAULT_MIN_LENGTH)
	})

	test('a whole number from the floor to the maximum, nothing else', () => {
		expect(minLengthProblem(PASSWORD_MIN_LENGTH_FLOOR, PASSWORD_MIN_LENGTH_FLOOR)).toBeNull()
		expect(minLengthProblem(PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH_FLOOR)).toBeNull()
		expect(minLengthProblem(PASSWORD_MIN_LENGTH_FLOOR - 1, PASSWORD_MIN_LENGTH_FLOOR)).toContain('below 4')
		expect(minLengthProblem(PASSWORD_MAX_LENGTH + 1, PASSWORD_MIN_LENGTH_FLOOR)).toContain('above 256')
		expect(minLengthProblem(7.5, PASSWORD_MIN_LENGTH_FLOOR)).toContain('whole number')
		expect(minLengthProblem(8, PASSWORD_DEFAULT_MIN_LENGTH)).toContain('below 15')
	})

	test('a stored minimum this runtime would not accept applies the default, never less', () => {
		expect(storedMinLength(null, PASSWORD_MIN_LENGTH_FLOOR)).toBe(PASSWORD_DEFAULT_MIN_LENGTH)
		expect(storedMinLength({ id: 1, min_length: 6, updated_at: 1 }, PASSWORD_MIN_LENGTH_FLOOR)).toBe(6)
		expect(storedMinLength({ id: 1, min_length: 6, updated_at: 1 }, PASSWORD_DEFAULT_MIN_LENGTH)).toBe(PASSWORD_DEFAULT_MIN_LENGTH)
		expect(storedMinLength({ id: 1, min_length: 20, updated_at: 1 }, PASSWORD_DEFAULT_MIN_LENGTH)).toBe(20)
	})
})

describe('the refusal of a short password', () => {
	test('names the minimum in a grammatical Czech form at every length an installation may set', () => {
		const problem = catalogFor('cs').pages.setPassword.problem
		expect(problem('too_short', 4, 256)).toBe('Použijte alespoň 4 znaky.')
		expect(problem('too_short', 5, 256)).toBe('Použijte alespoň 5 znaků.')
		expect(problem('too_short', 15, 256)).toBe('Použijte alespoň 15 znaků.')
		expect(catalogFor('en').pages.setPassword.problem('too_short', 4, 256)).toBe('Use at least 4 characters.')
	})
})
