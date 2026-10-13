import { describe, expect, test } from 'bun:test'
import { DEFAULT_LOCALE, displayNameProblem, isLocale, LOCALES, MAX_DISPLAY_NAME_LENGTH } from '../locale'

describe('locales', () => {
	test('the default is one of the languages, and nothing else is one', () => {
		expect(LOCALES).toContain(DEFAULT_LOCALE)
		expect(LOCALES.every(isLocale)).toBe(true)
		for (const value of ['de', 'EN', 'cs-CZ', '', null, 1]) expect(isLocale(value)).toBe(false)
	})
})

describe('displayNameProblem', () => {
	test('admits one short line of any script', () => {
		expect(displayNameProblem('Partnerský portál')).toBeNull()
		expect(displayNameProblem('😀'.repeat(MAX_DISPLAY_NAME_LENGTH))).toBeNull()
	})

	test('refuses an empty, padded, overlong or multi-line name', () => {
		expect(displayNameProblem('')).not.toBeNull()
		expect(displayNameProblem(' Notes')).not.toBeNull()
		expect(displayNameProblem('N'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).not.toBeNull()
		expect(displayNameProblem('Notes\r\nBcc: someone')).not.toBeNull()
		expect(displayNameProblem('Notes\u0000')).not.toBeNull()
	})
})
